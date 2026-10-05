/**
 * Sends a clean 504 if a request hasn't finished within timeoutMs, instead
 * of leaving the client hanging indefinitely on a stalled call. This is a
 * safety net, not true cancellation — it can't stop work already in
 * flight (Node doesn't give middleware a way to abort an arbitrary
 * in-progress handler), but it bounds how long a caller waits, which is
 * what actually matters for graceful failure. The two most likely slow
 * paths (the downloader library call, and the upstream fetch in
 * fetchMedia) also have their own more precise timeouts — see
 * withTimeout.js and the AbortController usage in fetchMedia.
 */
function requestTimeout(timeoutMs = Number(process.env.REQUEST_TIMEOUT_MS) || 30_000) {
  return (req, res, next) => {
    const timer = setTimeout(() => {
      if (!res.headersSent) {
        res.status(504).json({
          success: false,
          error: { message: "Request timed out.", statusCode: 504, ...(req.id ? { requestId: req.id } : {}) },
        });
      }
    }, timeoutMs);

    res.on("finish", () => clearTimeout(timer));
    res.on("close", () => clearTimeout(timer));
    next();
  };
}

module.exports = requestTimeout;
