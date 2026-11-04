// End-to-end checks of the streaming / redirect / size-cap behaviour of
// /api/fetch-media against a throwaway local server. The SSRF guard itself is
// covered in ssrf.test.js (and would, correctly, refuse 127.0.0.1), so here it
// is swapped for a permissive stand-in — everything else is the real code.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const Module = require("node:module");
const { Writable } = require("node:stream");

const realSsrf = require("../src/utils/ssrf");
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "btch-downloader") return {};
  if (request === "../utils/ssrf") {
    return { ...realSsrf, assertPublicHostname: () => {}, createGuardedLookup: () => undefined };
  }
  return originalLoad.call(this, request, ...rest);
};
const { fetchMedia } = require("../src/controllers/downloaderController");

let server;
let base;
test.before(async () => {
  server = http.createServer((req, res) => {
    const u = req.url.split("?")[0];
    if (u === "/ok") { res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": "5" }); return res.end("hello"); }
    if (u === "/redir") { res.writeHead(302, { Location: "/ok" }); return res.end(); }
    if (u === "/loop") { res.writeHead(302, { Location: "/loop" }); return res.end(); }
    if (u === "/badproto") { res.writeHead(302, { Location: "file:///etc/passwd" }); return res.end(); }
    if (u === "/html") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end("<html>blocked</html>"); }
    if (u === "/missing") { res.writeHead(404); return res.end(); }
    if (u === "/chunked") { res.writeHead(200, { "Content-Type": "audio/mpeg" }); res.write("0123456789"); return res.end("0123456789"); }
    if (u === "/weird") { res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": "2" }); return res.end("ok"); }
    res.writeHead(500); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  Module._load = originalLoad;
  await new Promise((r) => server.close(r));
});

class FakeRes extends Writable {
  constructor() { super(); this.headers = {}; this.chunks = []; }
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; }
  _write(chunk, _e, cb) { this.chunks.push(chunk); cb(); }
  get body() { return Buffer.concat(this.chunks).toString(); }
}

async function run(path, query = {}) {
  const res = new FakeRes();
  const done = new Promise((resolve) => res.on("close", resolve));
  await fetchMedia({ query: { url: base + path, ...query } }, res);
  await done;
  return res;
}

test("streams the body with a safe attachment filename and the real extension", async () => {
  const res = await run("/ok", { filename: 'my "clip"\r\n.mp4' });
  assert.equal(res.body, "hello");
  assert.equal(res.headers["content-type"], "video/mp4");
  assert.equal(res.headers["content-length"], "5");
  assert.match(res.headers["content-disposition"], /^attachment; filename="[A-Za-z0-9._-]+\.mp4"$/);
});

test("derives the filename from the path when none is given", async () => {
  const res = await run("/ok");
  assert.equal(res.headers["content-disposition"], 'attachment; filename="ok.mp4"');
});

test("follows a redirect", async () => {
  const res = await run("/redir");
  assert.equal(res.body, "hello");
});

test("gives up on a redirect loop with a 502", async () => {
  await assert.rejects(run("/loop"), (e) => e.statusCode === 502 && /too many times/.test(e.message));
});

test("refuses a redirect to a non-http(s) protocol", async () => {
  await assert.rejects(run("/badproto"), (e) => e.statusCode === 502 && /unsupported protocol/.test(e.message));
});

test("HTML/JSON/text answers are treated as failures, not saved as media", async () => {
  await assert.rejects(run("/html"), (e) => e.statusCode === 502 && /did not return a media file/.test(e.message));
});

test("upstream error statuses become a 502", async () => {
  await assert.rejects(run("/missing"), (e) => e.statusCode === 502 && /404/.test(e.message));
});

test("an unreachable host is a 502, not a crash", async () => {
  const dead = http.createServer();
  await new Promise((r) => dead.listen(0, "127.0.0.1", r));
  const port = dead.address().port;
  await new Promise((r) => dead.close(r));
  await assert.rejects(fetchMedia({ query: { url: `http://127.0.0.1:${port}/x` } }, new FakeRes()), (e) => e.statusCode === 502);
});

test("FETCH_MEDIA_MAX_BYTES: a declared Content-Length over the cap is a 413 before any body is sent", async () => {
  process.env.FETCH_MEDIA_MAX_BYTES = "3";
  try {
    await assert.rejects(run("/ok"), (e) => e.statusCode === 413);
  } finally {
    delete process.env.FETCH_MEDIA_MAX_BYTES;
  }
});

test("FETCH_MEDIA_MAX_BYTES: a chunked response with no Content-Length is cut off at the cap", async () => {
  process.env.FETCH_MEDIA_MAX_BYTES = "15";
  const warn = console.warn;
  console.warn = () => {};
  try {
    const res = new FakeRes();
    const done = new Promise((resolve) => res.on("close", resolve));
    await fetchMedia({ query: { url: base + "/chunked" } }, res);
    await done;
    assert.ok(res.body.length < 20, `expected a truncated body, got ${res.body.length} bytes`);
  } finally {
    console.warn = warn;
    delete process.env.FETCH_MEDIA_MAX_BYTES;
  }
});

test("an unknown content type keeps the sanitized name without inventing an extension", async () => {
  const res = await run("/weird", { filename: "report v2" });
  assert.equal(res.headers["content-disposition"], 'attachment; filename="report_v2"');
});
