const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCorsOrigin, parseTrustProxy, envInt } = require("../src/utils/config");

test("parseCorsOrigin: unset, empty and * all mean any origin", () => {
  assert.equal(parseCorsOrigin(undefined), "*");
  assert.equal(parseCorsOrigin(""), "*");
  assert.equal(parseCorsOrigin(" * "), "*");
  assert.equal(parseCorsOrigin("https://a.com,*"), "*");
});

test("parseCorsOrigin: a comma-separated list becomes an array (the old code passed the raw string)", () => {
  assert.equal(parseCorsOrigin("https://a.com"), "https://a.com");
  assert.deepEqual(parseCorsOrigin("https://a.com, https://b.com ,"), ["https://a.com", "https://b.com"]);
});

test("parseTrustProxy: sensible defaults and never 'trust everything'", () => {
  assert.equal(parseTrustProxy(undefined), false);
  assert.equal(parseTrustProxy(undefined, { onVercel: true }), 1);
  assert.equal(parseTrustProxy("false", { onVercel: true }), false);
  assert.equal(parseTrustProxy("0"), false);
  assert.equal(parseTrustProxy("2"), 2);
  assert.equal(parseTrustProxy("true"), 1);
  assert.equal(parseTrustProxy("loopback, 10.0.0.0/8"), "loopback, 10.0.0.0/8");
});

test("envInt: falls back on missing, blank, negative or non-numeric values", () => {
  const env = { A: "5", B: "", C: "-1", D: "abc", E: "0" };
  assert.equal(envInt("A", 9, env), 5);
  assert.equal(envInt("B", 9, env), 9);
  assert.equal(envInt("C", 9, env), 9);
  assert.equal(envInt("D", 9, env), 9);
  assert.equal(envInt("E", 9, env), 0);
  assert.equal(envInt("MISSING", 9, env), 9);
});
