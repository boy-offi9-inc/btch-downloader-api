const http = require("node:http");
const https = require("node:https");
const { Transform, pipeline } = require("node:stream");
const ApiError = require("../utils/ApiError");
const { requireHttpUrl, requireNonEmptyString } = require("../utils/validate");
const { withTimeout, normalizeError } = require("@boy-offi9-inc/reqkit");
const { assertPublicHostname, createGuardedLookup, parseAllowedHosts } = require("../utils/ssrf");
const { envInt } = require("../utils/config");

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

module.exports = { fetchMedia };
