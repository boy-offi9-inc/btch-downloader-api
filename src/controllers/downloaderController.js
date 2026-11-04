const http = require("node:http");
const https = require("node:https");
const { Transform, pipeline } = require("node:stream");
const btch = require("btch-downloader");
const { PLATFORMS } = require("../config/platforms");
const ApiError = require("../utils/ApiError");
const { requireInputForQueryType, requireHttpUrl, requireNonEmptyString } = require("../utils/validate");
const { withTimeout, TimeoutError, withDedupe, normalizeError } = require("@boy-offi9-inc/reqkit");
const TtlCache = require("../utils/ttlCache");
const { normalizeResult, truncateListResult, hasHandler, isHeuristic } = require("../utils/normalizeResult");
const { assertPublicHostname, createGuardedLookup, parseAllowedHosts } = require("../utils/ssrf");
const { envInt } = require("../utils/config");

// Applies to platforms with `supportsLimit: true` (youtube-search, pinterest
// search) — these can return dozens of hits per query, most of which nobody
// asked for. Defaults to a small, sane page size and caps how high a caller
// can push it, rather than shipping (and letting the client render) an
// unbounded list on every request.
const LIST_LIMIT_DEFAULT = 5;
const LIST_LIMIT_MAX = 50;

// Short-lived cache of successful /api/download responses, keyed by
// platform + input + limit. Cuts repeat upstream calls (and the rate-limiting
// that comes with them). Only successes are stored. Set CACHE_TTL_MS=0 to
// turn it off. Keep the TTL short: upstream media links can expire.
const downloadCache = new TtlCache({
  ttlMs: envInt("CACHE_TTL_MS", 300_000),
  maxEntries: envInt("CACHE_MAX_ENTRIES", 200),
});

// Optional CDN caching (EDGE_CACHE_SECONDS, default 0 = off). The in-memory
// cache above is per-process, so on Vercel hit rates are low; this lets the
// platform's edge cache absorb repeat requests instead. Only ever applied to
// successful responses. Keep it short — upstream media links expire.
function applyEdgeCache(res) {
  const seconds = envInt("EDGE_CACHE_SECONDS", 0);
  if (seconds > 0) res.set("Cache-Control", `public, s-maxage=${Math.floor(seconds)}`);
}

function parseLimit(rawLimit) {
  const n = Number.parseInt(rawLimit, 10);
  if (!Number.isFinite(n) || n < 1) return LIST_LIMIT_DEFAULT;
  return Math.min(n, LIST_LIMIT_MAX);
}

/*
 Official btch-downloader documentation & project links:
 - GitHub: https://github.com/hostinger-bot/btch-downloader
 - npm:    https://www.npmjs.com/package/btch-downloader

 Notes:
 - The controller uses the btch-downloader package (see links above) and
   delegates platform-specific work to the library's exported functions.
 - See the library README for details about the `aio` (auto-detect) function
   and supported URL formats.
*/

// Log at startup which expected downloader functions are available vs missing.
(function logAvailableDownloaders() {
  try {
    const available = Object.keys(btch).filter((k) => typeof btch[k] === "function");
    const expected = Object.values(PLATFORMS).map((p) => p.fn);
    const missing = expected.filter((fn) => !available.includes(fn));
    if (missing.length) {
      console.warn("btch-downloader: missing expected functions:", missing);
    }
    console.debug("btch-downloader: available functions:", available);
  } catch (e) {
    console.warn("btch-downloader: could not inspect exports", e.message);
  }
})();

/**
 * GET /api/platforms
 * Returns the list of supported platforms — used by the frontend to build its dropdown.
 * Only returns platforms for which the underlying btch-downloader package exposes the
 * configured function. This avoids advertising routes that will 404 at runtime.
 */
function listPlatforms(req, res) {
  const platforms = Object.entries(PLATFORMS)
    .filter(([key, cfg]) => typeof btch[cfg.fn] === "function")
    .map(([key, value]) => ({
      key,
      queryType: value.queryType,
      example: value.example,
      ...(value.note ? { note: value.note } : {}),
      ...(value.deprecated ? { deprecated: true } : {}),
      ...(value.supportsLimit ? { supportsLimit: true } : {}),
    }));
  res.json({ success: true, count: platforms.length, platforms });
}

/**
 * Helper: normalize known URL forms that btch-downloader expects in a specific shape.
 * Currently normalizes YouTube "shorts" and youtu.be short links to the canonical
 * https://www.youtube.com/watch?v=<id> form.
 */
function normalizeInputForDownloader(input) {
  let v = String(input || "").trim();
  if (!v) return v;

  // Normalize youtu.be/<id> -> https://www.youtube.com/watch?v=<id>
  v = v.replace(/^(?:https?:\/\/)?(?:www\.)?youtu\.be\/([^?&/]+).*$/i, "https://www.youtube.com/watch?v=$1");

  // Normalize youtube.com/shorts/<id> -> https://www.youtube.com/watch?v=<id>
  v = v.replace(/^(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([^?&/]+).*$/i, "https://www.youtube.com/watch?v=$1");

  return v;
}

/**
 * YouTube: pull the 11-char video id out of any common URL shape (watch,
 * youtu.be, shorts, embed, live) so we can rebuild clean URLs without
 * tracking params like ?si=... that some upstream scrapers choke on.
 */
function extractYouTubeId(input) {
  const m = String(input || "").match(
    /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/))([A-Za-z0-9_-]{11})/i
  );
  return m ? m[1] : null;
}

/**
 * The upstream YouTube scraper is picky and sometimes answers
 * `{ developer, status: true }` with no links at all. Rather than trust one
 * URL shape, try a few equivalent ones (the form the library documents
 * first, then www, then exactly what the caller sent).
 */
function buildCandidates(platform, rawQuery, normalizedQuery) {
  if (platform !== "youtube") return [normalizedQuery];
  const id = extractYouTubeId(rawQuery);
  const list = id
    ? [`https://youtube.com/watch?v=${id}`, `https://www.youtube.com/watch?v=${id}`, rawQuery]
    : [normalizedQuery, rawQuery];
  return [...new Set(list)];
}

// Platforms whose success means "there are downloadable links". An empty
// result from these is a failure, not a success. (Search platforms can
// legitimately return nothing, so they're excluded.)
const LIST_PLATFORMS = new Set(["youtube-search", "pinterest"]);

/**
 * The upstream half of /api/download: try each candidate input against the
 * library within one shared deadline, validate what comes back, and build the
 * response body. Throws ApiError on any failure.
 */
async function resolveDownload(platform, rawQuery, normalizedQuery, appliedLimit) {
  const fn = btch[PLATFORMS[platform].fn];
  const candidates = buildCandidates(platform, rawQuery, normalizedQuery);
  const totalMs = Number(process.env.DOWNLOAD_TIMEOUT_MS) || 25_000;
  const deadline = Date.now() + totalMs;
  // Heuristic handlers (see normalizeResult.js) are guesses, so an empty
  // result from them is passed through, not turned into a 502.
  const mustHaveMedia = hasHandler(platform) && !LIST_PLATFORMS.has(platform) && !isHeuristic(platform);

  let data = null;
  let lastError = null;

  for (const candidate of candidates) {
    const remaining = deadline - Date.now();
    if (remaining <= 500) break;

    let attempt;
    try {
      attempt = await withTimeout(() => fn(candidate), remaining);
    } catch (err) {
      // Only OUR deadline is a 504; a library that times out internally is an
      // upstream failure and is reported as a 502 below.
      if (err instanceof TimeoutError) {
        throw new ApiError(504, `The ${platform} downloader took too long to respond.`);
      }
      // A plain Error here is the upstream/library failing, not our server
      // crashing — report it as a 502 instead of a generic 500.
      lastError = err instanceof ApiError ? err : new ApiError(502, `The ${platform} source failed: ${err.message || "unknown error"}`);
      continue;
    }

    // btch-downloader sometimes returns an object containing an `error`
    // property or a `status: false` result instead of throwing.
    if (attempt && (attempt.error || attempt.status === false || attempt.success === false)) {
      const message =
        (typeof attempt.error === "string" && attempt.error) ||
        (attempt.error && attempt.error.message) ||
        "Downloader returned an error";
      lastError = new ApiError(502, message);
      continue;
    }

    const attemptNormalized = normalizeResult(platform, attempt);
    if (mustHaveMedia && !attemptNormalized) {
      // "status: true" but no links — the upstream gave us nothing usable.
      lastError = new ApiError(
        502,
        `The ${platform} source answered but returned no downloadable links. ` +
          "This is usually the upstream provider failing or rate-limiting, not a problem with your URL. Try again shortly."
      );
      continue;
    }

    data = attempt;
    lastError = null;
    break;
  }

  if (lastError || data === null) {
    throw lastError || new ApiError(504, `The ${platform} downloader took too long to respond.`);
  }

  // For list-shaped platforms (search results), trim to `limit` (default 5,
  // capped at 50, via ?limit=) before it's ever normalized or sent back — so
  // the raw JSON and the normalized view agree, and a query that could
  // return dozens of hits doesn't ship (and force the client to render) all
  // of them by default.
  if (appliedLimit !== null) {
    truncateListResult(platform, data, appliedLimit);
  }

  const body = {
    success: true,
    platform,
    query: rawQuery,
    ...(appliedLimit !== null ? { limit: appliedLimit } : {}),
    // `result` stays exactly what the library returned (raw toggle / direct
    // API callers depend on that, aside from the ?limit= trim above).
    // `normalized` is a best-effort, consistent {kind, ...} view built from
    // real per-platform shapes (src/utils/normalizeResult.js) — null for
    // platforms without a handler yet, or if nothing usable was found; the
    // frontend falls back to its generic parser in that case.
    result: data,
    normalized: normalizeResult(platform, data),
  };

  return body;
}

const resolveOnce = withDedupe(resolveDownload, {
  keyFn: (platform, rawQuery, _normalizedQuery, appliedLimit) => JSON.stringify([platform, rawQuery, appliedLimit]),
});

/**
 * GET /api/download/:platform?url=...  (or ?query=... for search-based platforms)
 * Generic handler shared by every platform route.
 */
async function download(req, res) {
  const { platform } = req.params;
  const input = req.query.url || req.query.query;

  const config = PLATFORMS[platform];
  if (!config) {
    throw new ApiError(404, `Unsupported platform "${platform}".`);
  }

  const paramName = config.queryType === "query" ? "query" : "url";
  if (input === undefined) {
    throw new ApiError(400, `Missing required "${paramName}" query parameter. Example: ${config.example}`);
  }
  const rawQuery = requireInputForQueryType(input, config.queryType, paramName);

  const appliedLimit = config.supportsLimit ? parseLimit(req.query.limit) : null;
  const cacheKey = JSON.stringify([platform, rawQuery, appliedLimit]);
  const cached = downloadCache.get(cacheKey);
  if (cached) {
    res.set("X-Cache", "HIT");
    applyEdgeCache(res);
    return res.json(cached);
  }

  const fn = btch[config.fn];
  if (typeof fn !== "function") {
    // Provide a clearer message including available functions for debugging.
    const available = Object.keys(btch).filter((k) => typeof btch[k] === "function");
    console.warn(`btch-downloader: "${config.fn}" is not exported. Available: ${available.join(", ")}`);
    throw new ApiError(404, `The ${platform} downloader is not available in this build.`);
  }

  // Normalize a few common URL shapes so downstream downloaders (like YouTube)
  // receive the canonical form they expect and avoid confusing errors such as
  // "Invalid search API response" when callers pass a shorts/ or youtu.be link.
  let normalizedQuery = rawQuery;
  // Only apply the YouTube normalizations when the platform is youtube or aio —
  // aio delegates to platform-specific downloaders and benefits from the same fix.
  if (platform === "youtube" || platform === "aio") {
    normalizedQuery = normalizeInputForDownloader(rawQuery);
  }

  // Identical requests that arrive while one is already in flight share a
  // single upstream call (reqkit's withDedupe) instead of each hitting the
  // provider — the in-memory cache only helps once the first one has finished.
  const body = await resolveOnce(platform, rawQuery, normalizedQuery, appliedLimit);

  downloadCache.set(cacheKey, body);
  if (downloadCache.enabled) res.set("X-Cache", "MISS");
  applyEdgeCache(res);
  res.json(body);
}

/**
 * Maps a real (upstream) Content-Type to a file extension. Used instead of
 * guessing from the URL, since many CDN links (e.g. YouTube's googlevideo.com
 * playback URLs) carry no file extension in the path at all.
 */
const EXT_BY_MIME = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * Content-Types that indicate the upstream did NOT actually hand us media —
 * typically an error/interstitial page from a CDN that rejected the request
 * (missing Referer/User-Agent, expired signed URL, geo-block, etc). Forwarding
 * these as if they were the real file is exactly the "downloads a tiny raw
 * file that needs manual renaming" bug — so we treat them as failures instead.
 */
function looksLikeFailurePayload(contentType) {
  return /^(text\/html|application\/json|text\/plain)\b/i.test(contentType || "");
}

const MAX_REDIRECTS = 5;
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const guardedLookup = createGuardedLookup();

/** Keeps only filename-safe characters so the value can never break out of the header. */
function safeFileName(value, fallback = "download") {
  const cleaned = String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 120);
  return cleaned || fallback;
}

/**
 * One GET to `url` with the SSRF guard attached at connect time. Resolves with
 * the response (headers received, body unread). `signal` aborts the attempt;
 * it's only wired to connect + headers (see fetchMedia), so a big,
 * slow-but-working download isn't killed mid-stream.
 */
function requestOnce(url, signal) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      url,
      {
        method: "GET",
        lookup: guardedLookup,
        signal,
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: "*/*",
          // No compression: we pass Content-Length straight through, and
          // media is already compressed.
          "Accept-Encoding": "identity",
          Referer: `${url.protocol}//${url.host}/`,
        },
      },
      resolve
    );
    req.on("error", reject);
    req.end();
  });
}

/** Counts bytes and aborts the stream once `max` is exceeded (for responses with no Content-Length). */
function byteLimiter(max) {
  let seen = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length;
      if (seen > max) {
        const e = new Error("Media is larger than this server allows.");
        e.code = "EMEDIA_TOO_LARGE";
        return cb(e);
      }
      cb(null, chunk);
    },
  });
}

function toApiError(err) {
  if (err instanceof ApiError) return err;
  const n = normalizeError(err);
  if (n.isTimeout) return new ApiError(504, "Upstream media host took too long to respond.");
  if (n.code === "EBLOCKED_ADDRESS") return new ApiError(400, "Refusing to fetch a private/internal address.");
  if (n.code === "ENOTFOUND" || n.code === "EAI_AGAIN") return new ApiError(502, "Could not resolve the media host.");
  return new ApiError(502, "Could not reach the media host.");
}

/**
 * GET /api/fetch-media?url=...&filename=...
 * Streams a direct media URL (as returned inside a /api/download result) back
 * through this server with a Content-Disposition header, so a browser click
 * triggers a real file save instead of navigating to/opening the raw CDN URL.
 * This also sidesteps CDNs that don't set download-friendly headers themselves,
 * and avoids exposing the raw source URL directly to the client's tab history.
 *
 * Safety: private/internal addresses are refused at hostname level AND at
 * connect time (DNS-rebinding safe); redirects are followed manually, up to
 * MAX_REDIRECTS, with every hop re-checked; FETCH_MEDIA_ALLOWED_HOSTS can
 * restrict the route to a fixed set of CDN domains; FETCH_MEDIA_MAX_BYTES
 * can cap response size.
 */
async function fetchMedia(req, res) {
  const { url, filename } = req.query;

  const parsedUrlString = requireHttpUrl(url, "url");
  if (typeof filename === "string" && filename.trim()) {
    // Only validate when a real (non-empty) filename was actually given —
    // this stays an optional field with a derived fallback.
    requireNonEmptyString(filename, "filename", { maxLength: 255 });
  }

  const allowedHosts = parseAllowedHosts(process.env.FETCH_MEDIA_ALLOWED_HOSTS);
  const connectTimeoutMs = envInt("FETCH_MEDIA_TIMEOUT_MS", 20_000) || 20_000;
  const maxBytes = envInt("FETCH_MEDIA_MAX_BYTES", 0);

  let current = new URL(parsedUrlString);
  let upstream;
  for (let hop = 0; ; hop += 1) {
    assertPublicHostname(current.hostname, { allowedHosts });
    try {
      upstream = await withTimeout((signal) => requestOnce(current, signal), connectTimeoutMs);
    } catch (err) {
      throw toApiError(err);
    }

    const status = upstream.statusCode || 0;
    const location = upstream.headers.location;
    if (status >= 300 && status < 400 && location) {
      upstream.resume(); // discard the redirect body so the socket is freed
      if (hop >= MAX_REDIRECTS) throw new ApiError(502, "Upstream media host redirected too many times.");
      try {
        current = new URL(location, current);
      } catch {
        throw new ApiError(502, "Upstream media host sent an invalid redirect.");
      }
      if (!/^https?:$/.test(current.protocol)) throw new ApiError(502, "Upstream media host redirected to an unsupported protocol.");
      continue;
    }
    break;
  }

  if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
    upstream.resume();
    throw new ApiError(502, `Upstream media host returned ${upstream.statusCode}.`);
  }

  const contentType = upstream.headers["content-type"] || "application/octet-stream";
  const contentLength = Number(upstream.headers["content-length"]);

  if (looksLikeFailurePayload(contentType)) {
    // The upstream responded 200 but the body isn't actually media — most
    // likely a block page or error response. Fail loudly instead of handing
    // the client a garbage file.
    upstream.resume();
    throw new ApiError(502, "Upstream did not return a media file (got a text/HTML/JSON response instead).");
  }

  if (maxBytes > 0 && Number.isFinite(contentLength) && contentLength > maxBytes) {
    upstream.resume();
    throw new ApiError(413, "Media is larger than this server allows.");
  }

  const baseName = safeFileName(
    (typeof filename === "string" && filename.trim()) || (current.pathname.split("/").pop() || "download").replace(/\.[a-z0-9]+$/i, "")
  );

  // Determine the real extension from the actual response Content-Type,
  // ignoring whatever extension (if any) the client guessed beforehand.
  const mimeBase = contentType.split(";")[0].trim().toLowerCase();
  const ext = EXT_BY_MIME[mimeBase];
  const safeName = ext ? `${baseName.replace(/\.[a-z0-9]+$/i, "")}.${ext}` : baseName;

  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
  if (Number.isFinite(contentLength)) res.setHeader("Content-Length", String(contentLength));

  // pipeline() tears down the upstream socket if the client goes away (and
  // vice versa) — plain .pipe() would leave it open and leak the connection.
  const stages = maxBytes > 0 && !Number.isFinite(contentLength) ? [upstream, byteLimiter(maxBytes), res] : [upstream, res];
  pipeline(...stages, (err) => {
    if (err && err.code !== "ERR_STREAM_PREMATURE_CLOSE") {
      console.warn(`fetch-media stream ended early${req.id ? " id=" + req.id : ""}: ${err.message}`);
    }
  });
}

module.exports = { listPlatforms, download, fetchMedia, downloadCache };
