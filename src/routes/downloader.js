const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const { listPlatforms } = require("../controllers/platforms");
const { download } = require("../controllers/download");
const { fetchMedia } = require("../controllers/fetchMedia");

const router = express.Router();

// GET /api/platforms — list all supported platforms (for the frontend dropdown)
router.get("/platforms", listPlatforms);

// GET /api/download/:platform?url=... — download/fetch media info for a given platform
router.get("/download/:platform", asyncHandler(download));

// GET /api/fetch-media?url=...&filename=... — streams a direct media URL back
// with a Content-Disposition header so it triggers a real browser download.
router.get("/fetch-media", asyncHandler(fetchMedia));

module.exports = router;
