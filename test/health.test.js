const test = require("node:test");
const assert = require("node:assert/strict");
const { createHealthHandler } = require("../src/controllers/healthController");

function fakeRes() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

test("shallow health never touches the upstream", async () => {
  let probes = 0;
  const health = createHealthHandler({ probe: async () => { probes += 1; } });
  const res = fakeRes();
  await health({ query: {} }, res);
  assert.equal(probes, 0);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "ok");
  assert.equal(typeof res.body.version, "string");
});

test("deep health: healthy upstream -> 200 with upstream.ok", async () => {
  const health = createHealthHandler({ probe: async () => {} });
  const res = fakeRes();
  await health({ query: { deep: "1" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.upstream.ok, true);
});

test("deep health: failing upstream -> 503 degraded with the reason", async () => {
  const health = createHealthHandler({ probe: async () => { throw new Error("no results"); } });
  const res = fakeRes();
  await health({ query: { deep: "true" } }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.status, "degraded");
  assert.equal(res.body.upstream.error, "no results");
});

test("deep health: probe result is reused for 60s, then refreshed", async () => {
  let probes = 0;
  const clock = { t: 1_000_000 };
  const health = createHealthHandler({ probe: async () => { probes += 1; }, now: () => clock.t });
  await health({ query: { deep: "1" } }, fakeRes());
  await health({ query: { deep: "1" } }, fakeRes());
  assert.equal(probes, 1);
  clock.t += 61_000;
  await health({ query: { deep: "1" } }, fakeRes());
  assert.equal(probes, 2);
});

test("includes cache stats when provided", async () => {
  const health = createHealthHandler({ getCacheStats: () => ({ size: 3 }) });
  const res = fakeRes();
  await health({ query: {} }, res);
  assert.deepEqual(res.body.cache, { size: 3 });
});
