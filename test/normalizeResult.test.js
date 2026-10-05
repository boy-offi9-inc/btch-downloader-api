const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeResult, truncateListResult, hasHandler } = require("../src/utils/normalizeResult");

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
  assert.equal(hasHandler("spotify"), false);
});
