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

  const data = await fn(input.trim());

  res.json({
    success: true,
    platform,
    query: input.trim(),
    result: data,
  });
}

module.exports = { listPlatforms, download };
