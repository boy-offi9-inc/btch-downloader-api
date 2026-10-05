const crypto = require("crypto");

// Accept a caller-supplied ID (handy when a gateway/proxy already assigns
// one) only if it is short and boring — anything else could be used to
// smuggle junk into log lines, so it is replaced with a fresh UUID.
const VALID_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Gives every request an ID (req.id), returns it in the X-Request-Id header,
 * and — via the logger and error handler — puts it in log lines and error
 * bodies so a user's report can be matched to the exact request in your logs.
 */
function requestId(req, res, next) {
  const incoming = req.headers["x-request-id"];
  const id = typeof incoming === "string" && VALID_ID.test(incoming) ? incoming : crypto.randomUUID();
  req.id = id;
  res.setHeader("X-Request-Id", id);
  next();
}

module.exports = requestId;
