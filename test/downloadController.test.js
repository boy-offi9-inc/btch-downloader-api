const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// --- Replace the real `btch-downloader` with a controllable stub, so these
// tests never touch the network (and run even if the package isn't installed).
const { PLATFORMS } = require("../src/config/platforms");
const stub = {};
for (const { fn } of Object.values(PLATFORMS)) stub[fn] = async () => ({});

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "btch-downloader") return stub;
  return originalLoad.call(this, request, ...rest);
};

process.env.CACHE_TTL_MS = "60000";
const originalDebug = console.debug;
console.debug = () => {}; // the controller lists available functions at load
const { download, downloadCache } = require("../src/controllers/downloaderController");
console.debug = originalDebug;

test.beforeEach(() => downloadCache.clear());
test.after(() => { Module._load = originalLoad; });

async function call(platform, query = {}) {
  const res = {
    headers: {},
    body: null,
    set(k, v) { this.headers[k] = v; return this; },
    json(b) { this.body = b; return this; },
  };
  await download({ params: { platform }, query }, res);
  return res;
}

const MP4 = "https://cdn.example/v.mp4";
const EMPTY = { developer: "BOTCAHX", status: true }; // what the upstream sent in issue #1

test("YouTube: retries equivalent URL forms until one returns links", async () => {
  const seen = [];
  stub.youtube = async (u) => {
    seen.push(u);
    return u.startsWith("https://youtube.com/") ? EMPTY : { status: true, title: "T", mp4: MP4 };
  };
  const res = await call("youtube", { url: "https://youtu.be/_P7JjijXlYg?si=YCU3HTJ-m727Bous" });
  assert.deepEqual(seen, [
    "https://youtube.com/watch?v=_P7JjijXlYg",
    "https://www.youtube.com/watch?v=_P7JjijXlYg",
  ]);
  assert.equal(res.body.normalized.media[0].url, MP4);
});

test("YouTube: upstream that only ever returns { status: true } is a 502, not a success", async () => {
  let calls = 0;
  stub.youtube = async () => { calls += 1; return EMPTY; };
  await assert.rejects(
    call("youtube", { url: "https://youtu.be/_P7JjijXlYg" }),
    (e) => e.statusCode === 502 && /no downloadable links/.test(e.message)
  );
  assert.equal(calls, 3);
});

test("a throwing upstream becomes a 502 with the reason", async () => {
  stub.youtube = async () => { throw new Error("boom"); };
  await assert.rejects(
    call("youtube", { url: "https://youtu.be/_P7JjijXlYg" }),
    (e) => e.statusCode === 502 && /boom/.test(e.message)
  );
});

test("an upstream { status: false, error } is surfaced as a 502", async () => {
  stub.ttdl = async () => ({ status: false, error: "blocked" });
  await assert.rejects(
    call("tiktok", { url: "https://www.tiktok.com/@u/video/1" }),
    (e) => e.statusCode === 502 && e.message === "blocked"
  );
});

test("a hung upstream gives a 504", async () => {
  const previous = process.env.DOWNLOAD_TIMEOUT_MS;
  process.env.DOWNLOAD_TIMEOUT_MS = "700";
  stub.youtube = () => new Promise(() => {});
  try {
    await assert.rejects(call("youtube", { url: "https://youtu.be/_P7JjijXlYg" }), (e) => e.statusCode === 504);
  } finally {
    if (previous === undefined) delete process.env.DOWNLOAD_TIMEOUT_MS;
    else process.env.DOWNLOAD_TIMEOUT_MS = previous;
  }
});

const hit = (i) => ({ type: "video", url: `https://youtube.com/watch?v=id${i}`, title: `T${i}`, timestamp: "1:00" });
const searchResult = () => ({ status: true, result: { all: [1, 2, 3, 4, 5, 6].map(hit), videos: [1, 2, 3, 4, 5, 6].map(hit) } });

test("search: ?limit= trims raw AND normalized so they agree", async () => {
  stub.yts = async () => searchResult();
  const res = await call("youtube-search", { query: "kratos", limit: "3" });
  assert.equal(res.body.limit, 3);
  assert.equal(res.body.result.result.all.length, 3);
  assert.equal(res.body.normalized.items.length, 3);
});

test("search: default limit is 5", async () => {
  stub.yts = async () => searchResult();
  const res = await call("youtube-search", { query: "kratos" });
  assert.equal(res.body.normalized.items.length, 5);
});

test("cache: an identical request is served from cache (X-Cache HIT)", async () => {
  let calls = 0;
  stub.ttdl = async () => { calls += 1; return { title: "x", video: [MP4] }; };
  const q = { url: "https://www.tiktok.com/@u/video/1" };
  const first = await call("tiktok", q);
  const second = await call("tiktok", q);
  assert.equal(calls, 1);
  assert.equal(first.headers["X-Cache"], "MISS");
  assert.equal(second.headers["X-Cache"], "HIT");
  assert.deepEqual(first.body, second.body);
});

test("cache: failures are never cached", async () => {
  let calls = 0;
  stub.ttdl = async () => {
    calls += 1;
    if (calls === 1) throw new Error("flaky");
    return { title: "x", video: [MP4] };
  };
  const q = { url: "https://www.tiktok.com/@u/video/2" };
  await assert.rejects(call("tiktok", q));
  const res = await call("tiktok", q);
  assert.equal(calls, 2);
  assert.equal(res.body.success, true);
});

test("cache: a different ?limit= is a different entry", async () => {
  let calls = 0;
  stub.yts = async () => { calls += 1; return searchResult(); };
  await call("youtube-search", { query: "kratos", limit: "2" });
  await call("youtube-search", { query: "kratos", limit: "4" });
  assert.equal(calls, 2);
});

test("validation: unknown platform is 404, missing input is 400", async () => {
  await assert.rejects(call("nope", { url: "https://x.com" }), (e) => e.statusCode === 404);
  await assert.rejects(call("youtube", {}), (e) => e.statusCode === 400);
  await assert.rejects(call("youtube", { url: "not a url" }), (e) => e.statusCode === 400);
});
