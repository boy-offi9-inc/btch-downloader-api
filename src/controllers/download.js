const btch = require("btch-downloader");
const { PLATFORMS } = require("../config/platforms");
const ApiError = require("../utils/ApiError");
const { requireInputForQueryType } = require("../utils/validate");
const { withTimeout, TimeoutError, withDedupe } = require("@boy-offi9-inc/reqkit");
const TtlCache = require("../utils/ttlCache");
const { normalizeResult, truncateListResult, hasHandler, isHeuristic } = require("../utils/normalizeResult");
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

module.exports = { download, downloadCache };
