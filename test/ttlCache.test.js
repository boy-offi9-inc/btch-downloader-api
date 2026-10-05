const test = require("node:test");
const assert = require("node:assert/strict");
const TtlCache = require("../src/utils/ttlCache");

function makeCache(opts = {}) {
  const clock = { t: 1_000 };
  const cache = new TtlCache({ ttlMs: 100, maxEntries: 3, now: () => clock.t, ...opts });
  return { cache, clock };
}

test("returns what was stored, counts hits and misses", () => {
  const { cache } = makeCache();
  cache.set("a", { n: 1 });
  assert.deepEqual(cache.get("a"), { n: 1 });
  assert.equal(cache.get("nope"), undefined);
  assert.equal(cache.stats().hits, 1);
  assert.equal(cache.stats().misses, 1);
});

test("entries expire after the TTL", () => {
  const { cache, clock } = makeCache();
  cache.set("a", 1);
  clock.t += 99;
  assert.equal(cache.get("a"), 1);
  clock.t += 2;
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.stats().size, 0);
});

test("evicts the least recently used entry past maxEntries", () => {
  const { cache } = makeCache();
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  cache.get("a"); // "a" is now the most recently used, so "b" is oldest
  cache.set("d", 4);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.get("d"), 4);
});

test("ttl of 0 disables caching", () => {
  const { cache } = makeCache({ ttlMs: 0 });
  assert.equal(cache.enabled, false);
  cache.set("a", 1);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.stats().size, 0);
});

test("clear() empties the cache and resets counters", () => {
  const { cache } = makeCache();
  cache.set("a", 1);
  cache.get("a");
  cache.clear();
  assert.deepEqual([cache.stats().size, cache.stats().hits, cache.stats().misses], [0, 0, 0]);
});
