const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeResult, truncateListResult, hasHandler, isHeuristic, guessMediaType } = require("../src/utils/normalizeResult");

test("youtube: builds MP4 + MP3 entries", () => {
  const out = normalizeResult("youtube", {
    status: true,
    title: "T",
    mp4: "https://cdn.example/v.mp4",
    mp3: "https://cdn.example/a.mp3",
  });
  assert.equal(out.kind, "media");
  assert.deepEqual(out.media.map((m) => m.type), ["video", "audio"]);
});

test("youtube: the upstream's empty { developer, status: true } is null, not a success", () => {
  assert.equal(normalizeResult("youtube", { developer: "BOTCAHX", status: true }), null);
});

test("youtube-search: lists hits as not directly downloadable", () => {
  const out = normalizeResult("youtube-search", {
    result: {
      all: [
        { type: "video", url: "https://youtube.com/watch?v=aaaaaaaaaaa", title: "A", timestamp: "1:00", thumbnail: "https://i.example/a.jpg" },
        { type: "list", url: "https://youtube.com/playlist?list=PL1", title: "P", videoCount: 12 },
      ],
    },
  });
  assert.equal(out.kind, "list");
  assert.equal(out.items[0].downloadable, false);
  assert.equal(out.items[0].meta, "1:00");
  assert.equal(out.items[1].type, "playlist");
  assert.equal(out.items[1].meta, "12 videos");
});

test("unknown platforms and non-objects normalize to null", () => {
  assert.equal(normalizeResult("xiaohongshu-profile", { result: "https://x.example/a.mp4" }), null);
  assert.equal(normalizeResult("spotify", { a: 1 }), null);
  assert.equal(normalizeResult("youtube", null), null);
  assert.equal(normalizeResult("youtube", "nope"), null);
});

test("truncateListResult trims `all` and `videos` in place", () => {
  const hit = (i) => ({ type: "video", url: `https://youtube.com/watch?v=${i}` });
  const data = { result: { all: [1, 2, 3, 4].map(hit), videos: [1, 2, 3, 4].map(hit) } };
  truncateListResult("youtube-search", data, 2);
  assert.equal(data.result.all.length, 2);
  assert.equal(data.result.videos.length, 2);
});

test("hasHandler only reports real handlers", () => {
  assert.equal(hasHandler("youtube"), true);
  assert.equal(hasHandler("toString"), false);
  assert.equal(hasHandler("xiaohongshu-profile"), false);
  assert.equal(hasHandler("spotify"), true); // heuristic, but still a handler
});

test("isHeuristic flags only the best-effort handlers", () => {
  for (const p of ["spotify", "xiaohongshu", "snackvideo", "cocofun", "threads", "kuaishou"]) assert.equal(isHeuristic(p), true, p);
  for (const p of ["youtube", "tiktok", "pinterest", "xiaohongshu-profile"]) assert.equal(isHeuristic(p), false, p);
});

// --- Per-platform handlers, written against the shapes documented in normalizeResult.js ---
const U = (name) => `https://cdn.example/${name}`;

test("instagram: wraps url list as video media and takes the first thumbnail", () => {
  const out = normalizeResult("instagram", { status: true, result: [{ thumbnail: U("t.jpg"), url: U("tok1") }, { thumbnail: U("t2.jpg"), url: U("tok2") }] });
  assert.equal(out.media.length, 2);
  assert.equal(out.media[0].label, "Media 1");
  assert.equal(out.media[0].type, "video");
  assert.equal(out.thumbnail, U("t.jpg"));
});

test("facebook: maps Normal_video/HD to SD/HD and ignores non-URL keys", () => {
  const out = normalizeResult("facebook", { developer: "x", status: true, Normal_video: U("sd.mp4"), HD: U("hd.mp4") });
  assert.deepEqual(out.media.map((m) => m.label), ["SD", "HD"]);
});

test("tiktok: video + audio arrays, labels depend on count", () => {
  const out = normalizeResult("tiktok", { title: "T", thumbnail: U("t.jpg"), video: [U("v.mp4")], audio: [U("a.mp3")] });
  assert.deepEqual(out.media.map((m) => [m.label, m.type]), [["Video (no watermark)", "video"], ["Audio (MP3)", "audio"]]);
  const two = normalizeResult("tiktok", { video: [U("1.mp4"), U("2.mp4")] });
  assert.deepEqual(two.media.map((m) => m.label), ["Video 1", "Video 2"]);
});

test("twitter: array of single-key quality objects", () => {
  const out = normalizeResult("twitter", { title: "T", url: [{ hd: U("hd.mp4") }, { sd: U("sd.mp4") }] });
  assert.deepEqual(out.media.map((m) => m.label), ["HD", "SD"]);
});

test("mediafire: types the file from mimetype/ext and reads owner as author", () => {
  const out = normalizeResult("mediafire", { result: { filename: "a.zip", url: U("a.zip"), mimetype: "application/zip", ext: "zip", owner: "bob" } });
  assert.equal(out.title, "a.zip");
  assert.equal(out.author, "bob");
  assert.equal(out.media[0].type, "file");
  assert.equal(normalizeResult("mediafire", { result: { filename: "a.zip" } }), null);
});

test("capcut: originalVideoUrl becomes the video, coverUrl the thumbnail", () => {
  const out = normalizeResult("capcut", { title: "T", originalVideoUrl: U("v.mp4"), coverUrl: U("c.jpg"), authorName: "A" });
  assert.equal(out.media[0].type, "video");
  assert.equal(out.thumbnail, U("c.jpg"));
  assert.equal(out.author, "A");
});

test("gdrive: nested result.data.downloadUrl; null when missing", () => {
  const out = normalizeResult("gdrive", { result: { data: { filename: "clip.mp4", downloadUrl: U("dl") } } });
  assert.equal(out.media[0].type, "video"); // typed from the filename extension
  assert.equal(normalizeResult("gdrive", { result: { data: {} } }), null);
});

test("douyin: result.data.links with quality labels", () => {
  const out = normalizeResult("douyin", { result: { data: { title: "T", thumbnail: U("t.jpg"), links: [{ quality: "720p", url: U("a") }, { quality: "480p", url: U("b") }] } } });
  assert.deepEqual(out.media.map((m) => m.label), ["720p", "480p"]);
});

test("soundcloud: prefers downloadMp3, falls back to audio, thumbnail falls back to artwork", () => {
  const a = normalizeResult("soundcloud", { result: { title: "T", downloadMp3: U("dl.mp3"), audio: U("stream"), downloadArtwork: U("art.jpg") } });
  assert.equal(a.media[0].url, U("dl.mp3"));
  assert.equal(a.thumbnail, U("art.jpg"));
  const b = normalizeResult("soundcloud", { result: { audio: U("stream") } });
  assert.equal(b.media[0].url, U("stream"));
});

test("pinterest: search shape becomes a downloadable list", () => {
  const out = normalizeResult("pinterest", {
    result: { result: { query: "cats", count: 2, result: [
      { title: "A", images: { original: U("a.jpg"), medium: U("a_m.jpg") }, uploader: { full_name: "U" } },
      { description: " B ", video_url: U("b.mp4") },
    ] } },
  });
  assert.equal(out.kind, "list");
  assert.equal(out.items.length, 2);
  assert.equal(out.items[0].downloadable, true);
  assert.equal(out.items[1].type, "video");
  assert.equal(out.items[1].title, "B");
});

test("pinterest: single-pin shape becomes media (video + cover) and image-only pins work", () => {
  const withVideo = normalizeResult("pinterest", { result: { result: { title: "P", video_url: U("p.mp4"), images: { orig: { url: U("p.jpg") } }, user: { full_name: "U" } } } });
  assert.equal(withVideo.kind, "media");
  assert.deepEqual(withVideo.media.map((m) => m.label), ["Video", "Cover Image"]);
  const imageOnly = normalizeResult("pinterest", { result: { result: { images: { "736x": { url: U("p.jpg") } } } } });
  assert.equal(imageOnly.media[0].label, "Image");
  assert.equal(normalizeResult("pinterest", { result: { result: {} } }), null);
});

test("pinterest: truncateListResult trims a search and leaves a single pin alone", () => {
  const search = { result: { result: { count: 9, result: [1, 2, 3, 4, 5] } } };
  truncateListResult("pinterest", search, 2);
  assert.equal(search.result.result.result.length, 2);
  assert.equal(search.result.result.count, 2);
  const pin = { result: { result: { title: "x" } } };
  truncateListResult("pinterest", pin, 2);
  assert.deepEqual(pin, { result: { result: { title: "x" } } });
});

test("a handler that throws degrades to null instead of breaking the response", () => {
  assert.equal(normalizeResult("pinterest", { result: { result: { result: { get result() { throw new Error("boom"); } } } } }), null);
});

test("guessMediaType: mimetype beats extension beats label", () => {
  assert.equal(guessMediaType({ mimetype: "audio/mpeg", url: "https://x/a.mp4" }), "audio");
  assert.equal(guessMediaType({ url: "https://x/a.webm?x=1" }), "video");
  assert.equal(guessMediaType({ label: "Cover art" }), "image");
  assert.equal(guessMediaType({ label: "zzz" }), "file");
});

// --- Heuristic handlers ---
test("heuristic: finds the download link, splits out the cover, and tags the result", () => {
  const out = normalizeResult("spotify", { developer: "x", status: true, result: { title: "Song", artist: "Band", cover: U("c.jpg"), download: U("a.mp3") } });
  assert.equal(out.heuristic, true);
  assert.equal(out.title, "Song");
  assert.equal(out.author, "Band");
  assert.equal(out.thumbnail, U("c.jpg"));
  assert.deepEqual(out.media.map((m) => [m.type, m.url]), [["audio", U("a.mp3")]]);
});

test("heuristic: walks nested objects and arrays, de-duplicates, skips unlabeled page links", () => {
  const out = normalizeResult("threads", { status: true, data: { caption: "hi", username: "u", items: [{ video: U("v.mp4") }, { video: U("v.mp4") }, { images: [U("p.jpg")] }], profile: "https://threads.com/@u" } });
  assert.deepEqual(out.media.map((m) => m.url), [U("v.mp4")]); // video once; the image stays the thumbnail
  assert.equal(out.thumbnail, U("p.jpg"));
  assert.ok(out.media.every((m) => m.url !== "https://threads.com/@u"), "a 'profile' page link must not match the 'file' key");
});

test("heuristic: image-only posts promote their images to downloadable media", () => {
  const out = normalizeResult("xiaohongshu", { status: true, result: { title: "Trip", images: [U("1.jpg"), U("2.jpg")] } });
  assert.deepEqual(out.media.map((m) => m.type), ["image", "image"]);
  assert.equal(out.thumbnail, U("1.jpg"));
});

test("heuristic: nothing URL-shaped means null (and the controller does not treat that as a failure)", () => {
  assert.equal(normalizeResult("kuaishou", { status: true, message: "ok" }), null);
});
