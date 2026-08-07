const btch = require("btch-downloader");
const { PLATFORMS } = require("../config/platforms");
const ApiError = require("../utils/ApiError");

/**
 * GET /api/platforms
 * Returns the list of supported platforms — used by the frontend to build its dropdown.
 */
function listPlatforms(req, res) {
  const platforms = Object.entries(PLATFORMS).map(([key, value]) => ({
    key,
    queryType: value.queryType,
    example: value.example,
    ...(value.note ? { note: value.note } : {}),
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

  if (!input || !input.trim()) {
    const paramName = config.queryType === "query" ? "query" : "url";
    throw new ApiError(400, `Missing required "${paramName}" query parameter. Example: ${config.example}`);
  }

  const fn = btch[config.fn];
  if (typeof fn !== "function") {
    throw new ApiError(500, `Downloader function "${config.fn}" is not available in btch-downloader.`);
  }

  // Normalize a few common URL shapes so downstream downloaders (like YouTube)
  // receive the canonical form they expect and avoid confusing errors such as
  // "Invalid search API response" when callers pass a shorts/ or youtu.be link.
  const rawQuery = input.trim();
  let normalizedQuery = rawQuery;
  // Only apply the YouTube normalizations when the platform is youtube or aio —
  // aio delegates to platform-specific downloaders and benefits from the same fix.
  if (/(youtube|aio)/i.test(platform)) {
    normalizedQuery = normalizeInputForDownloader(rawQuery);
  }

  const data = await fn(normalizedQuery);

  // btch-downloader sometimes returns an object containing an `error` property
  // or a `status: false` result instead of throwing. Map those to a consistent
  // API error response so clients get a helpful message and proper HTTP status.
  if (data && (data.error || data.status === false || data.success === false)) {
    const message =
      (typeof data.error === "string" && data.error) ||
      (data.error && data.error.message) ||
      "Downloader returned an error";
    throw new ApiError(502, message);
  }

  res.json({
    success: true,
    platform,
    query: rawQuery,
    result: data,
  });
}

module.exports = { listPlatforms, download };
