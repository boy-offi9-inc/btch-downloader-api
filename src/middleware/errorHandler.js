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
    console.error(`[Unhandled Error]${req.id ? " id=" + req.id : ""}`, err);
  }

  // ApiErrors and 4xx errors from Express/body-parser carry messages that are
  // safe to show. Anything else that ends up a 500 is an unexpected crash, and
  // its message can leak internals (paths, library details) — log it, but
  // send a generic line.
  const exposeMessage = err instanceof ApiError || statusCode < 500;
  res.status(statusCode).json({
    success: false,
    error: {
      message: (exposeMessage && err.message) || "Internal Server Error",
      statusCode,
      ...(req.id ? { requestId: req.id } : {}),
    },
  });
}

module.exports = { notFound, errorHandler };
