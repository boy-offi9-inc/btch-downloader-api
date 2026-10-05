/**
 * Tiny in-memory TTL cache with a size cap (oldest/least-recently-used entry
 * is evicted first). No timers — entries expire lazily on read, so it is safe
 * in serverless environments and never keeps the process alive.
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
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get enabled() {
    return this.ttlMs > 0 && this.maxEntries > 0;
  }

  get(key) {
    if (!this.enabled) return undefined;
    const entry = this.map.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.map.delete(key);
      this.misses += 1;
      return undefined;
    }
    // Re-insert so Map order tracks recency (oldest key is always first).
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits += 1;
    return entry.value;
  }

  set(key, value) {
    if (!this.enabled) return;
    this.map.delete(key);
    this.map.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.map.size > this.maxEntries) {
      this.map.delete(this.map.keys().next().value);
    }
  }

  clear() {
    this.map.clear();
    this.hits = 0;
    this.misses = 0;
  }

  stats() {
    return {
      enabled: this.enabled,
      size: this.map.size,
      maxEntries: this.maxEntries,
      ttlMs: this.ttlMs,
      hits: this.hits,
      misses: this.misses,
    };
  }
}

module.exports = TtlCache;
