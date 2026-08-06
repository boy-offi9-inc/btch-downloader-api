const ApiError = require("../utils/ApiError");

/**
 * Catches 404s for unmatched routes.
 */
function notFound(req, res, next) {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`));
}

/**
 * Central error handler — every thrown/forwarded error ends up here.
 * Keeps error responses consistent across the whole API.
 */
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const statusCode = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;

  if (statusCode === 500) {
    console.error("[Unhandled Error]", err);
  }

  res.status(statusCode).json({
    success: false,
    error: {
      message: err.message || "Internal Server Error",
      statusCode,
    },
  });
}

module.exports = { notFound, errorHandler };
