const btch = require("btch-downloader");
const { PLATFORMS } = require("../config/platforms");

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

module.exports = { listPlatforms };
