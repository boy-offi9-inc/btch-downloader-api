const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const { listPlatforms, download } = require("../controllers/downloaderController");

const router = express.Router();

// GET /api/platforms — list all supported platforms (for the frontend dropdown)
router.get("/platforms", listPlatforms);

// GET /api/download/:platform?url=... — download/fetch media info for a given platform
router.get("/download/:platform", asyncHandler(download));

module.exports = router;
