/**
 * Small, dependency-free parsers for env-driven settings, kept separate so
 * they can be unit-tested without booting Express.
 */

/**
 * CORS_ORIGIN: "*" (or unset) -> any origin; "https://a.com" -> that origin;
 * "https://a.com, https://b.com" -> a list. (The cors package does NOT split
 * a comma-separated string for you — passing it through raw silently matches
 * nothing, which is what the old code did.)
 */
function parseCorsOrigin(raw) {
  const value = String(raw === undefined ? "" : raw).trim();
  if (!value || value === "*") return "*";
  const list = value.split(",").map((s) => s.trim()).filter(Boolean);
  if (list.includes("*")) return "*";
  return list.length === 1 ? list[0] : list;
}

/**
 * TRUST_PROXY: how many reverse-proxy hops to trust for the client IP.
 * Needed so rate limiting sees the real caller instead of the platform's
 * proxy. Unset -> 1 hop on Vercel, none elsewhere. "false"/"0" -> none;
 * a number -> that many hops; "true" -> 1 hop (never "trust everything",
 * which would let callers spoof X-Forwarded-For); anything else is passed to
 * Express as-is (e.g. "loopback, 10.0.0.0/8").
 */
function parseTrustProxy(raw, { onVercel = false } = {}) {
  const value = String(raw === undefined ? "" : raw).trim().toLowerCase();
  if (!value) return onVercel ? 1 : false;
  if (value === "false" || value === "0") return false;
  if (value === "true") return 1;
  if (/^\d+$/.test(value)) return Number(value);
  return String(raw).trim();
}

/** Non-negative integer from an env var, with a fallback. */
function envInt(name, fallback, env = process.env) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

module.exports = { parseCorsOrigin, parseTrustProxy, envInt };
