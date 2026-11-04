const { createMemoryCache } = require("@boy-offi9-inc/reqkit");

/**
 * Small TTL layer on top of reqkit's createMemoryCache (which supplies the
 * size-capped, least-recently-used storage). This adds the two things that
 * store doesn't have: per-entry expiry and hit/miss counters. No timers —
 * entries expire lazily on read, so it is safe in serverless environments and
 * never keeps the process alive.
 *
 * Note: it lives in one process's memory. On Vercel each serverless instance
 * has its own cache; on Railway/Render/Docker it is shared by every request
 * to that one server.
 *
 * ttlMs <= 0 or maxEntries <= 0 disables caching entirely.
 */
class TtlCache {
  constructor({ ttlMs = 300_000, maxEntries = 200, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.store = this.enabled ? createMemoryCache({ maxEntries }) : null;
    this.hits = 0;
    this.misses = 0;
  }

  get enabled() {
    return this.ttlMs > 0 && this.maxEntries > 0;
  }

  get(key) {
    if (!this.enabled) return undefined;
    const entry = this.store.get(key); // also marks it most-recently-used
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    return entry.value;
  }

  set(key, value) {
    if (!this.enabled) return;
    this.store.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  clear() {
    if (this.store) this.store.clear();
    this.hits = 0;
    this.misses = 0;
  }

  stats() {
    return {
      enabled: this.enabled,
      size: this.store ? this.store.size : 0,
      maxEntries: this.maxEntries,
      ttlMs: this.ttlMs,
      hits: this.hits,
      misses: this.misses,
    };
  }
}

module.exports = TtlCache;
