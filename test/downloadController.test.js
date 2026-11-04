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

test("heuristic platform: an empty/odd upstream answer is passed through, not turned into a 502", async () => {
  stub.spotify = async () => ({ developer: "x", status: true, message: "nothing recognisable" });
  const res = await call("spotify", { url: "https://open.spotify.com/track/abc" });
  assert.equal(res.body.success, true);
  assert.equal(res.body.normalized, null);
  assert.equal(res.body.result.message, "nothing recognisable");
});

test("heuristic platform: a recognisable answer is normalized and tagged", async () => {
  stub.spotify = async () => ({ result: { title: "Song", download: "https://cdn.example/a.mp3" } });
  const res = await call("spotify", { url: "https://open.spotify.com/track/def" });
  assert.equal(res.body.normalized.heuristic, true);
  assert.equal(res.body.normalized.media[0].type, "audio");
});

test("verified platforms still 502 on an empty answer (heuristic change didn't loosen them)", async () => {
  stub.ttdl = async () => ({ title: "x" });
  await assert.rejects(call("tiktok", { url: "https://www.tiktok.com/@u/video/9" }), (e) => e.statusCode === 502);
});

test("a platform whose library function is missing gives a generic 404 (no export list leaked)", async () => {
  const saved = stub.cocofun;
  delete stub.cocofun;
  const warn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(call("cocofun", { url: "https://www.icocofun.com/share/post/1" }), (e) => e.statusCode === 404 && !/Available/.test(e.message) && !/ttdl/.test(e.message));
  } finally {
    console.warn = warn;
    stub.cocofun = saved;
  }
});

test("edge cache: Cache-Control is only sent when EDGE_CACHE_SECONDS is set, on MISS and HIT", async () => {
  stub.ttdl = async () => ({ title: "x", video: [MP4] });
  const q = { url: "https://www.tiktok.com/@u/video/55" };
  const off = await call("tiktok", q);
  assert.equal(off.headers["Cache-Control"], undefined);

  process.env.EDGE_CACHE_SECONDS = "60";
  try {
    const hit = await call("tiktok", q); // served from memory cache
    assert.equal(hit.headers["X-Cache"], "HIT");
    assert.equal(hit.headers["Cache-Control"], "public, s-maxage=60");
    const miss = await call("tiktok", { url: "https://www.tiktok.com/@u/video/56" });
    assert.equal(miss.headers["Cache-Control"], "public, s-maxage=60");
  } finally {
    delete process.env.EDGE_CACHE_SECONDS;
  }
});

// --- fetch-media: refusals that must happen BEFORE any network call ---
const { fetchMedia } = require("../src/controllers/downloaderController");

test("fetch-media: private, loopback and metadata addresses are refused with 400", async () => {
  for (const url of ["http://127.0.0.1/a.mp4", "http://localhost:3000/x", "http://[::1]/x", "http://169.254.169.254/latest/meta-data", "http://10.0.0.5/x", "http://[::ffff:127.0.0.1]/x", "http://2130706433/x"]) {
    await assert.rejects(fetchMedia({ query: { url }, id: "t" }, {}), (e) => e.statusCode === 400, url);
  }
});

test("fetch-media: non-http(s) and malformed URLs are 400", async () => {
  for (const url of ["file:///etc/passwd", "ftp://example.com/x", "not a url"]) {
    await assert.rejects(fetchMedia({ query: { url } }, {}), (e) => e.statusCode === 400, url);
  }
});

test("fetch-media: FETCH_MEDIA_ALLOWED_HOSTS rejects hosts outside the list before connecting", async () => {
  process.env.FETCH_MEDIA_ALLOWED_HOSTS = "googlevideo.com";
  try {
    await assert.rejects(fetchMedia({ query: { url: "https://example.com/a.mp4" } }, {}), (e) => e.statusCode === 400 && /allowlist/.test(e.message));
  } finally {
    delete process.env.FETCH_MEDIA_ALLOWED_HOSTS;
  }
});

test("dedupe: concurrent identical requests share ONE upstream call", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  stub.ttdl = async () => { calls += 1; await gate; return { title: "x", video: [MP4] }; };
  const q = { url: "https://www.tiktok.com/@u/video/777" };
  const pending = [call("tiktok", q), call("tiktok", q), call("tiktok", q)];
  await new Promise((r) => setTimeout(r, 20));
  release();
  const results = await Promise.all(pending);
  assert.equal(calls, 1);
  assert.ok(results.every((r) => r.body.success === true));
});

test("dedupe: a failed shared call fails every waiter, and the next request starts fresh", async () => {
  let calls = 0;
  stub.ttdl = async () => { calls += 1; if (calls === 1) throw new Error("down"); return { title: "x", video: [MP4] }; };
  const q = { url: "https://www.tiktok.com/@u/video/778" };
  const [a, b] = await Promise.allSettled([call("tiktok", q), call("tiktok", q)]);
  assert.equal(a.status, "rejected");
  assert.equal(b.status, "rejected");
  assert.equal(calls, 1);
  const ok = await call("tiktok", q);
  assert.equal(ok.body.success, true);
});

test("dedupe: different limits are different calls", async () => {
  let calls = 0;
  stub.yts = async () => { calls += 1; return searchResult(); };
  await Promise.all([call("youtube-search", { query: "k", limit: "2" }), call("youtube-search", { query: "k", limit: "3" })]);
  assert.equal(calls, 2);
});
