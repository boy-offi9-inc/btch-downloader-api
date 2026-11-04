/**
 * Per-platform normalizer for raw btch-downloader responses.
 *
 * Why this exists: btch-downloader returns a genuinely different shape for
 * every platform — flat objects (`youtube`: {mp3, mp4}), objects with
 * platform-specific key names (`facebook`: {Normal_video, HD}), arrays of
 * single-key "variant" objects (`twitter`: {url: [{hd}, {sd}]}), and results
 * nested 1-3 levels deep under repeated `result`/`data` wrappers
 * (`gdrive`, `pinterest`, `douyin`). A single generic heuristic can't
 * reliably parse all of that — confirmed against real captured responses,
 * several shapes silently produced zero usable links or the wrong media
 * type. Each function below targets one platform's *actual, observed*
 * response shape instead of guessing.
 *
 * Every handler returns one of:
 *   { kind: "media", title, thumbnail, author, media: [{ label, type, url }] }
 *   { kind: "list",  items: [{ title, url, thumbnail, type, meta, downloadable }] }
 *   null  — handler couldn't find anything usable; caller should fall back
 *           to the generic client-side parser.
 *
 * `downloadable` on a list item distinguishes a direct media URL (e.g. a
 * Pinterest search hit's image, which the fetch-media proxy can stream) from
 * a source-page link (e.g. a YouTube search hit's watch-page URL, which
 * isn't itself downloadable — it needs to be re-run through the `youtube`
 * platform first).
 */

const VIDEO_EXT = /\.(mp4|webm|mov|m4v)(\?|$)/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|wav)(\?|$)/i;
const IMAGE_EXT = /\.(jpe?g|png|gif|webp)(\?|$)/i;

function isUrl(v) {
  return typeof v === "string" && /^https?:\/\/\S+$/i.test(v);
}

/**
 * Single source of truth for "what kind of media is this", used by every
 * handler below. Checks the strongest signal first (an explicit MIME type
 * or file extension) before falling back to keyword guesses from a label —
 * CDN links frequently carry no file extension at all (they're signed
 * token endpoints), so the label/key name is often the only real signal.
 */
function guessMediaType({ label, url, mimetype, ext } = {}) {
  const mt = String(mimetype || "").toLowerCase();
  if (mt.startsWith("video/")) return "video";
  if (mt.startsWith("audio/")) return "audio";
  if (mt.startsWith("image/")) return "image";

  const e = String(ext || "").toLowerCase().replace(/^\./, "");
  if (["mp4", "webm", "mov", "m4v"].includes(e)) return "video";
  if (["mp3", "m4a", "aac", "wav", "ogg"].includes(e)) return "audio";
  if (["jpg", "jpeg", "png", "gif", "webp"].includes(e)) return "image";

  if (VIDEO_EXT.test(url || "")) return "video";
  if (AUDIO_EXT.test(url || "")) return "audio";
  if (IMAGE_EXT.test(url || "")) return "image";

  const l = String(label || "").toLowerCase();
  if (/video/.test(l)) return "video";
  if (/(audio|music|song)/.test(l)) return "audio";
  if (/(image|photo|cover|artwork|thumb)/.test(l)) return "image";
  return "file";
}

// --- youtube: {developer, status, title, thumbnail, author, mp3, mp4} ---
function youtube(raw) {
  const media = [];
  if (isUrl(raw.mp4)) media.push({ label: "MP4 Video", type: "video", url: raw.mp4 });
  if (isUrl(raw.mp3)) media.push({ label: "MP3 Audio", type: "audio", url: raw.mp3 });
  return { kind: "media", title: raw.title || null, thumbnail: raw.thumbnail || null, author: raw.author || null, media };
}

// --- youtube-search: {developer, status, result: {status, all: [...]}} ---
// `all` items are search hits (a video's *watch page*, or a playlist), not
// downloadable files — they need to be re-run through the `youtube`
// platform to actually get a download link, so downloadable: false.
function youtubeSearch(raw) {
  const inner = raw && raw.result;
  const all = inner && Array.isArray(inner.all) ? inner.all : [];
  const items = all
    .filter((it) => isUrl(it && it.url))
    .map((it) => ({
      title: it.title || null,
      url: it.url,
      thumbnail: it.thumbnail || it.image || null,
      type: it.type === "list" ? "playlist" : "video",
      meta: it.type === "list" ? (it.videoCount != null ? `${it.videoCount} videos` : null) : it.timestamp || (it.duration && it.duration.timestamp) || null,
      downloadable: false,
    }));
  return { kind: "list", items };
}

// --- instagram: {developer, status, result: [{thumbnail, url}, ...]} ---
// The library gives no type field and the CDN url has no file extension
// (it's a signed token endpoint) — reels/posts via this API are
// overwhelmingly video, so that's the safe default absent any other signal.
function instagram(raw) {
  const list = Array.isArray(raw.result) ? raw.result : [];
  const media = list
    .filter((it) => isUrl(it && it.url))
    .map((it, i) => ({
      label: list.length > 1 ? `Media ${i + 1}` : "Video",
      type: guessMediaType({ label: "video", url: it.url }),
      url: it.url,
    }));
  const thumbnail = (list[0] && list[0].thumbnail) || null;
  return { kind: "media", title: null, thumbnail, author: null, media };
}

// --- facebook: {developer, status, Normal_video, HD} ---
const FACEBOOK_LABELS = { Normal_video: "SD", HD: "HD" };
function facebook(raw) {
  const media = [];
  for (const [key, val] of Object.entries(raw)) {
    if (["developer", "status", "success", "error"].includes(key)) continue;
    if (isUrl(val)) media.push({ label: FACEBOOK_LABELS[key] || key, type: "video", url: val });
  }
  return { kind: "media", title: null, thumbnail: null, author: null, media };
}

// --- tiktok: {title, thumbnail, video: [url], audio: [url]} ---
function tiktok(raw) {
  const media = [];
  const videos = Array.isArray(raw.video) ? raw.video.filter(isUrl) : [];
  const audios = Array.isArray(raw.audio) ? raw.audio.filter(isUrl) : [];
  videos.forEach((url, i) => media.push({ label: videos.length > 1 ? `Video ${i + 1}` : "Video (no watermark)", type: "video", url }));
  audios.forEach((url, i) => media.push({ label: audios.length > 1 ? `Audio ${i + 1}` : "Audio (MP3)", type: "audio", url }));
  return { kind: "media", title: raw.title || null, thumbnail: raw.thumbnail || null, author: null, media };
}

// --- twitter: {title, url: [{hd: "..."}, {sd: "..."}]} ---
function twitter(raw) {
  const media = [];
  (Array.isArray(raw.url) ? raw.url : []).forEach((entry) => {
    if (entry && typeof entry === "object") {
      for (const [quality, url] of Object.entries(entry)) {
        if (isUrl(url)) media.push({ label: quality.toUpperCase(), type: "video", url });
      }
    }
  });
  return { kind: "media", title: raw.title || null, thumbnail: null, author: null, media };
}

// --- mediafire: {result: {filename, filesize, ext, mimetype, url, owner}} ---
function mediafire(raw) {
  const d = raw.result || raw;
  if (!d || !isUrl(d.url)) return null;
  return {
    kind: "media",
    title: d.filename || null,
    thumbnail: null,
    author: d.owner || null,
    media: [{ label: d.filename || "File", type: guessMediaType({ url: d.url, mimetype: d.mimetype, ext: d.ext }), url: d.url }],
  };
}

// --- capcut: {title, originalVideoUrl, coverUrl, authorName} ---
function capcut(raw) {
  const media = [];
  if (isUrl(raw.originalVideoUrl)) media.push({ label: "Video", type: "video", url: raw.originalVideoUrl });
  return { kind: "media", title: raw.title || null, thumbnail: raw.coverUrl || null, author: raw.authorName || null, media };
}

// --- gdrive: {result: {data: {filename, filesize, downloadUrl}}} ---
function gdrive(raw) {
  const d = (raw.result && raw.result.data) || raw.data || {};
  if (!isUrl(d.downloadUrl)) return null;
  return {
    kind: "media",
    title: d.filename || null,
    thumbnail: null,
    author: null,
    media: [{ label: d.filename || "File", type: guessMediaType({ url: d.downloadUrl, ext: (d.filename || "").split(".").pop() }), url: d.downloadUrl }],
  };
}

// --- douyin: {result: {data: {title, thumbnail, links: [{quality, url}]}}} ---
function douyin(raw) {
  const d = (raw.result && raw.result.data) || raw.data || {};
  const links = Array.isArray(d.links) ? d.links : [];
  const media = links.filter((l) => isUrl(l && l.url)).map((l) => ({ label: l.quality || "Video", type: "video", url: l.url }));
  return { kind: "media", title: d.title || null, thumbnail: d.thumbnail || null, author: null, media };
}

// --- soundcloud: {result: {title, thumbnail, audio, downloadMp3, downloadArtwork}} ---
function soundcloud(raw) {
  const d = raw.result || raw;
  const media = [];
  const mp3 = isUrl(d.downloadMp3) ? d.downloadMp3 : d.audio;
  if (isUrl(mp3)) media.push({ label: "MP3 Audio", type: "audio", url: mp3 });
  return { kind: "media", title: d.title || null, thumbnail: d.thumbnail || d.downloadArtwork || null, author: null, media };
}

// --- pinterest: TWO very different shapes depending on url vs search-term input ---
// Search (by query): result.result -> {query, count, result: [pin, ...]}
// Single pin (by url): result.result -> the pin object itself {id, title, images, video_url, user, ...}
function pinterest(raw) {
  const layer = raw && raw.result;
  if (!layer) return null;

  const searchPayload = layer.result;
  if (searchPayload && Array.isArray(searchPayload.result)) {
    const items = searchPayload.result
      .filter((p) => isUrl(p.video_url) || isUrl(p.image_url) || (p.images && isUrl(p.images.original)))
      .map((p) => {
        const url = isUrl(p.video_url) ? p.video_url : (p.images && p.images.original) || p.image_url;
        return {
          title: p.title || (p.description && p.description.trim()) || null,
          url,
          thumbnail: (p.images && (p.images.medium || p.images.large)) || p.image_url || null,
          type: isUrl(p.video_url) ? "video" : "image",
          meta: p.uploader ? p.uploader.full_name : null,
          downloadable: true,
        };
      });
    return { kind: "list", items };
  }

  // Single-pin shape
  const pin = (layer.result && typeof layer.result === "object" ? layer.result : layer) || {};
  const images = pin.images || {};
  const bestImage = (images.orig && images.orig.url) || images["736x"]?.url || images["600x315"]?.url || pin.image || null;
  const media = [];
  if (isUrl(pin.video_url)) media.push({ label: "Video", type: "video", url: pin.video_url });
  if (isUrl(bestImage)) media.push({ label: media.length ? "Cover Image" : "Image", type: "image", url: bestImage });
  if (!media.length) return null;
  return {
    kind: "media",
    title: pin.title || (pin.description && pin.description.trim()) || null,
    thumbnail: bestImage,
    author: pin.user ? pin.user.full_name : null,
    media,
  };
}


// --- Heuristic handlers ---------------------------------------------------
// spotify, xiaohongshu, snackvideo, cocofun, threads and kuaishou do NOT have
// a handler written against a captured, real response yet. Rather than leave
// them with no normalized view at all, these use a best-effort scan of the raw
// response: walk it, collect every URL, and classify each one by file
// extension / key name. Results are tagged `heuristic: true` so callers (and
// the frontend) can tell them apart from the per-platform-verified handlers
// above — and, crucially, an empty heuristic result is NOT treated as an
// upstream failure (see isHeuristic), because a miss here may just mean the
// guess was wrong, not that the download failed.
const SKIP_KEYS = new Set(["developer", "status", "success", "error", "creator"]);
// Keys are matched as whole words (camelCase / snake_case split, plural "s"
// dropped) — a plain substring test would let "profile" match "file".
const THUMB_TOKENS = new Set(["thumb", "thumbnail", "cover", "poster", "preview", "avatar", "artwork", "image", "img"]);
const LINK_TOKENS = new Set(["download", "video", "audio", "music", "song", "mp3", "mp4", "media", "play", "src", "url", "link", "file", "hd", "sd", "nowm", "nwm", "wm"]);

function keyTokens(key) {
  return String(key || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((t) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t));
}
const keyIn = (set) => (key) => keyTokens(key).some((t) => set.has(t));
const isThumbKey = keyIn(THUMB_TOKENS);
const isLinkKey = keyIn(LINK_TOKENS);
const TITLE_KEYS = ["title", "caption", "desc", "description", "name", "text", "filename"];
const AUTHOR_KEYS = ["author", "authorName", "username", "nickname", "artist", "artists", "uploader", "owner"];
const MAX_SCAN_DEPTH = 6;
const MAX_SCAN_NODES = 500;

function firstString(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (Array.isArray(v) && typeof v[0] === "string" && v[0].trim()) return v[0].trim();
    if (v && typeof v === "object" && typeof v.name === "string" && v.name.trim()) return v.name.trim();
  }
  return null;
}

function scanForMedia(raw) {
  const found = []; // { key, url }
  let nodes = 0;
  (function walk(value, key, depth) {
    if (nodes++ > MAX_SCAN_NODES || depth > MAX_SCAN_DEPTH || value == null) return;
    if (typeof value === "string") {
      if (isUrl(value)) found.push({ key, url: value });
    } else if (Array.isArray(value)) {
      value.forEach((v) => walk(v, key, depth + 1));
    } else if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if (!SKIP_KEYS.has(k)) walk(v, k, depth + 1);
      }
    }
  })(raw, "", 0);

  let thumbnail = null;
  let media = [];
  const thumbs = [];
  const seen = new Set();
  for (const { key, url } of found) {
    if (seen.has(url)) continue;
    seen.add(url);
    const type = guessMediaType({ label: key, url });
    if (isThumbKey(key) && type !== "video" && type !== "audio") {
      if (!thumbnail) thumbnail = url;
      thumbs.push({ label: key || "Image", type: "image", url });
      continue;
    }
    // Keep anything we can positively type; for untyped links, only keep
    // ones whose key name says "this is the thing to download".
    if (type === "file" && !isLinkKey(key)) continue;
    media.push({ label: key || "File", type, url });
  }
  // Image-only posts (photo carousels, covers-as-content): with no video,
  // audio or file found, the "thumbnails" ARE the downloadable media.
  if (!media.length) media = thumbs;

  // Flatten the first object layer (and a nested result/data layer) for title/author.
  const layers = [raw];
  for (const k of ["result", "data"]) if (raw && typeof raw[k] === "object" && !Array.isArray(raw[k])) layers.push(raw[k]);
  if (layers.length > 1 && layers[1] && typeof layers[1].data === "object") layers.push(layers[1].data);
  let title = null;
  let author = null;
  for (const layer of layers) {
    if (!layer || typeof layer !== "object") continue;
    title = title || firstString(layer, TITLE_KEYS);
    author = author || firstString(layer, AUTHOR_KEYS);
  }
  return { kind: "media", title, thumbnail, author, media, heuristic: true };
}

const HEURISTIC_PLATFORMS = new Set(["spotify", "xiaohongshu", "snackvideo", "cocofun", "threads", "kuaishou"]);

const HANDLERS = {
  youtube,
  "youtube-search": youtubeSearch,
  instagram,
  facebook,
  tiktok,
  twitter,
  mediafire,
  capcut,
  gdrive,
  douyin,
  soundcloud,
  pinterest,
  spotify: scanForMedia,
  xiaohongshu: scanForMedia,
  snackvideo: scanForMedia,
  cocofun: scanForMedia,
  threads: scanForMedia,
  kuaishou: scanForMedia,
};

/**
 * @param {string} platform - the PLATFORMS registry key (e.g. "youtube-search")
 * @param {unknown} raw - the exact value returned by the btch-downloader function
 * @returns {object|null} a normalized {kind, ...} object, or null if there's no
 *   handler for this platform yet, or the handler found nothing usable — in
 *   either case the caller should fall back to the generic client-side parser.
 */
function normalizeResult(platform, raw) {
  if (!raw || typeof raw !== "object") return null;
  const handler = HANDLERS[platform];
  if (!handler) return null;

  let out;
  try {
    out = handler(raw);
  } catch {
    // A handler bug (unexpected shape variant we haven't seen) should
    // degrade to the generic fallback, never break the whole response.
    return null;
  }
  if (!out) return null;

  if (out.kind === "media") {
    out.media = (out.media || []).filter((m) => m && isUrl(m.url));
    if (!out.media.length) return null;
  } else if (out.kind === "list") {
    out.items = (out.items || []).filter((it) => it && isUrl(it.url));
    if (!out.items.length) return null;
  } else {
    return null;
  }
  return out;
}

/**
 * Trims a list-shaped platform's raw response IN PLACE to `limit` entries,
 * before normalizeResult ever sees it — so the raw JSON (what the "raw"
 * toggle shows, and what any direct API caller gets back) and the
 * `normalized` view both reflect the same, already-trimmed list. No-op for
 * every other shape (including Pinterest's *single-pin* response, which has
 * no list to trim).
 */
function truncateListResult(platform, data, limit) {
  if (!data || typeof data !== "object" || !Number.isFinite(limit)) return data;

  if (platform === "youtube-search") {
    const inner = data.result;
    if (inner && typeof inner === "object") {
      if (Array.isArray(inner.all)) inner.all = inner.all.slice(0, limit);
      if (Array.isArray(inner.videos)) inner.videos = inner.videos.slice(0, limit);
    }
  } else if (platform === "pinterest") {
    const searchPayload = data.result && data.result.result;
    if (searchPayload && Array.isArray(searchPayload.result)) {
      searchPayload.result = searchPayload.result.slice(0, limit);
      if (typeof searchPayload.count === "number") searchPayload.count = Math.min(searchPayload.count, limit);
    }
    // Single-pin shape (searchPayload has no .result array) is left untouched.
  }

  return data;
}

function hasHandler(platform) {
  return Object.prototype.hasOwnProperty.call(HANDLERS, platform);
}

/**
 * True for platforms whose handler is a best-effort scan rather than one
 * written against a real captured response. The download controller does
 * not turn an empty result from these into a 502 — see scanForMedia above.
 */
function isHeuristic(platform) {
  return HEURISTIC_PLATFORMS.has(platform);
}

module.exports = { normalizeResult, guessMediaType, truncateListResult, hasHandler, isHeuristic };
