const test = require("node:test");
const assert = require("node:assert/strict");
const requestId = require("../src/middleware/requestId");
const { errorHandler } = require("../src/middleware/errorHandler");
const ApiError = require("../src/utils/ApiError");

function run(headers = {}) {
  const req = { headers };
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; } };
  let called = false;
  requestId(req, res, () => { called = true; });
  assert.ok(called, "next() must be called");
  return { req, res };
}

test("requestId: generates a UUID and returns it as a header", () => {
  const { req, res } = run();
  assert.match(req.id, /^[0-9a-f]{8}-[0-9a-f]{4}-/);
  assert.equal(res.headers["X-Request-Id"], req.id);
});

test("requestId: keeps a sane incoming ID", () => {
  const { req } = run({ "x-request-id": "gateway-abc-12345" });
  assert.equal(req.id, "gateway-abc-12345");
});

test("requestId: replaces a suspicious incoming ID", () => {
  const { req } = run({ "x-request-id": "bad id with spaces & junk" });
  assert.notEqual(req.id, "bad id with spaces & junk");
  assert.match(req.id, /^[0-9a-f]{8}-/);
});

function fakeRes() {
  return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

test("errorHandler: includes the request ID in the error body", () => {
  const res = fakeRes();
  errorHandler(new ApiError(502, "upstream down"), { id: "req-12345678" }, res, () => {});
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.body, { success: false, error: { message: "upstream down", statusCode: 502, requestId: "req-12345678" } });
});

test("errorHandler: unknown errors become a 500 (and are logged)", () => {
  const res = fakeRes();
  const original = console.error;
  console.error = () => {};
  try {
    errorHandler(new Error("kaboom"), {}, res, () => {});
  } finally {
    console.error = original;
  }
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error.requestId, undefined);
});
