// Extensions that don't need their own log line — keeps the console
// focused on API calls (what actually matters for debugging/monitoring)
// instead of getting drowned out by every CSS/JS/image request.
const QUIET_EXTENSIONS = /\.(css|js|png|jpg|jpeg|gif|svg|ico|woff2?)$/i;

/**
 * Logs method, path, status code, and response time for each request.
 * No external dependency (morgan, etc.) — this project's dependency list
 * is intentionally small, and the format needed here is simple enough
 * not to warrant one.
 */
function requestLogger(req, res, next) {
  if (QUIET_EXTENSIONS.test(req.path)) return next();

  const start = process.hrtime.bigint();
  const { method, path } = req;
  // Some endpoints (fetch-media in particular) carry very long signed
  // URLs/tokens in the query string — truncate so one request can't
  // flood the console.
  const queryString = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  const truncatedQuery = queryString.length > 120 ? queryString.slice(0, 120) + "…" : queryString;

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const statusLabel =
      res.statusCode >= 500 ? "\x1b[31m" : res.statusCode >= 400 ? "\x1b[33m" : "\x1b[32m";
    const reset = "\x1b[0m";
    console.log(`${method} ${path}${truncatedQuery} ${statusLabel}${res.statusCode}${reset} ${durationMs.toFixed(1)}ms${req.id ? " id=" + req.id : ""}`);
  });

  next();
}

module.exports = requestLogger;
