const withTimeout = require("../utils/withTimeout");
const { normalizeResult } = require("../utils/normalizeResult");
const { version } = require("../../package.json");

// A deep check calls a real third-party provider, so the result is reused
// for a minute — health pings (or someone hammering ?deep=1) can't turn
// into a flood of upstream requests.
const PROBE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 8_000;

/**
 * Cheap end-to-end probe: run one real YouTube search through the library
 * and make sure it yields usable results. It's a heuristic — it proves the
 * library can reach its upstream and parse an answer, not that every
 * platform works — but it separates "my server is up" from "the provider
 * behind the downloader is failing".
 */
async function defaultProbe() {
  // Required lazily so this module (and its tests) don't need the library
  // loaded just to report a shallow "ok".
  const btch = require("btch-downloader");
  if (typeof btch.yts !== "function") throw new Error("yts is not available in btch-downloader");
  const data = await withTimeout(btch.yts("music"), PROBE_TIMEOUT_MS, "Upstream probe timed out.");
  if (!normalizeResult("youtube-search", data)) throw new Error("Upstream answered but returned no results.");
}

function createHealthHandler({ probe = defaultProbe, now = Date.now, getCacheStats = () => null } = {}) {
  let last = null;
  let inflight = null;

  function checkUpstream() {
    if (last && now() - last.at < PROBE_TTL_MS) return Promise.resolve(last.result);
    if (!inflight) {
      inflight = (async () => {
        const started = now();
        let result;
        try {
          await probe();
          result = { ok: true, latencyMs: now() - started };
        } catch (err) {
          result = { ok: false, latencyMs: now() - started, error: String(err && err.message).slice(0, 200) };
        }
        last = { at: now(), result: { ...result, checkedAt: new Date(now()).toISOString() } };
        return last.result;
      })().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  return async function health(req, res) {
    const base = { success: true, status: "ok", version, uptime: process.uptime() };
    const cache = getCacheStats();
    if (cache) base.cache = cache;

    const deep = ["1", "true"].includes(String(req.query.deep || "").toLowerCase());
    if (!deep) return res.json(base);

    const upstream = await checkUpstream();
    if (!upstream.ok) {
      // 503 so an uptime monitor pointed at ?deep=1 actually alerts.
      return res.status(503).json({ ...base, success: false, status: "degraded", upstream });
    }
    return res.json({ ...base, upstream });
  };
}

module.exports = { createHealthHandler, defaultProbe };
