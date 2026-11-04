# btch-downloader-api

<p align="left">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white" alt="Node >=20">
  <img src="https://img.shields.io/badge/express-4.x-000000?logo=express&logoColor=white" alt="Express 4.x">
  <img src="https://img.shields.io/badge/platforms-20-blueviolet" alt="20 supported platforms">
  <img src="https://img.shields.io/badge/deploy-Railway%20%7C%20Render%20%7C%20Vercel%20%7C%20Docker-informational" alt="Deploy targets">
</p>

**[Live demo](https://btch-downloader-api-green.vercel.app/)** — try the endpoint tester without running anything locally.

A small, well-structured REST API that wraps the [`btch-downloader`](https://www.npmjs.com/package/btch-downloader) library, plus a built-in browser page for testing every endpoint without needing Postman.

Fetch public media info/download links from TikTok, Instagram, YouTube, Spotify, Pinterest, SoundCloud, Facebook, Twitter/X, Google Drive, MediaFire, CapCut, Douyin, Xiaohongshu (posts and profiles), SnackVideo, Cocofun, Threads, and Kuaishou — plus an `aio` endpoint that auto-detects the platform from the URL — all through one consistent JSON API.

> **Note:** `aio` and `mediafire` are marked "no longer maintained" in the upstream `btch-downloader` library as of v6. They're still wired up here and may keep working, but treat them as the first candidates to fail on a future dependency bump — prefer a specific platform key over `aio` where you can.


**External resources (official btch-downloader project)**

- GitHub: https://github.com/hostinger-bot/btch-downloader
- npm: https://www.npmjs.com/package/btch-downloader

---

## Features

- 🎯 One generic route (`/api/download/:platform`) handles all 17 supported platforms
- 🧩 Adding a new platform is a one-line change (`src/config/platforms.js`)
- 🛡️ Centralized error handling, input validation, and rate limiting (with a tighter limit on the file-streaming route)
- 🔒 SSRF-hardened `/api/fetch-media`: private/IPv6/mapped addresses blocked at connect time, every redirect hop re-checked, optional host allowlist and size cap
- 🧰 Built on [`@boy-offi9-inc/reqkit`](https://github.com/boy-offi9-inc/reqkit) for timeouts (with real cancellation), concurrent-request dedupe, the LRU cache store and error normalization — fewer home-grown helpers to maintain
- 🧹 Normalized `{kind, media|items}` view for every platform except `xiaohongshu-profile` (six use a best-effort scan — see below)
- 🧪 Static frontend tester served at `/` — no separate frontend project needed, fully responsive from small phones to desktop
- 📦 Clean, conventional Express project layout
- 🚀 Deploy-ready for Railway, Render, Vercel (serverless), or plain Docker — configs included for all four

---

## Project structure

```
btch-downloader-api/
├── api/
│   └── index.js             # Vercel serverless entry point (reuses src/app.js)
├── public/
│   └── index.html           # Frontend endpoint tester (served at "/"), fully responsive
├── src/
│   ├── config/
│   │   └── platforms.js     # Single source of truth for supported platforms
│   ├── controllers/
│   │   └── downloaderController.js
│   ├── middleware/
│   │   ├── errorHandler.js  # 404 + centralized error responses
│   │   └── requestId.js     # X-Request-Id on every request
│   ├── routes/
│   │   └── downloader.js
│   ├── utils/
│   │   ├── ApiError.js
│   │   ├── asyncHandler.js
│   │   ├── config.js        # CORS_ORIGIN / TRUST_PROXY / env-number parsing
│   │   ├── normalizeResult.js
│   │   ├── ssrf.js          # private-address checks + connect-time DNS guard
│   │   └── ttlCache.js      # TTL + hit/miss stats on top of reqkit's LRU store
│   ├── app.js               # Express app factory (no listen — reused by every deploy target)
│   └── index.js             # Local/Railway/Render entry point (calls app.listen)
├── scripts/
│   └── check-syntax.js       # `npm run lint` — dependency-free syntax check
├── test/                     # node:test suite (npm test)
├── .github/
│   ├── workflows/ci.yml      # Lint + tests + smoke test on push/PR
│   ├── dependabot.yml        # Dependency update PRs
│   └── ISSUE_TEMPLATE/       # Bug report / feature request forms
├── .dockerignore
├── .env.example
├── .gitignore
├── .nvmrc
├── Dockerfile
├── Procfile                  # Fallback start command for Heroku-style platforms
├── LICENSE
├── railway.json
├── render.yaml
├── requests.http             # Ready-made sample requests (VS Code REST Client / JetBrains HTTP client)
├── vercel.json
├── package.json
└── README.md
```

---

## Getting started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

| Variable                 | Default | Description                              |
| ------------------------- | ------- | ----------------------------------------- |
| `PORT`                    | `3000`  | Port the server listens on                |
| `CORS_ORIGIN`              | `*`     | Allowed CORS origin(s) — one, or a comma-separated list |
| `TRUST_PROXY`              | `1` on Vercel, else off | Reverse-proxy hops to trust for the client IP (keeps rate limiting per-caller) |
| `RATE_LIMIT_WINDOW_MS`     | `60000` | Rate limit window, in milliseconds        |
| `RATE_LIMIT_MAX`           | `30`    | Max requests per IP per window            |
| `DOWNLOAD_TIMEOUT_MS`      | `25000` | Max wait for the downloader library       |
| `CACHE_TTL_MS`             | `300000`| Cache successful downloads this long (`0` = off) |
| `CACHE_MAX_ENTRIES`        | `200`   | Max cached responses (oldest evicted)     |
| `EDGE_CACHE_SECONDS`       | `0`     | Send `Cache-Control: public, s-maxage=N` on successful downloads so a CDN can cache them (`0` = off) |
| `FETCH_MEDIA_RATE_LIMIT_MAX` | `10`  | Max `/api/fetch-media` requests per IP per window |
| `FETCH_MEDIA_ALLOWED_HOSTS` | *(any public host)* | Comma-separated hosts (subdomains included) `/api/fetch-media` may fetch from |
| `FETCH_MEDIA_MAX_BYTES`    | `0`     | Refuse/abort media larger than this (`0` = no cap) |
| `FETCH_MEDIA_TIMEOUT_MS`   | `20000` | Connect + response-headers timeout for `/api/fetch-media` |

### 3. Run it

```bash
npm start        # production
npm run dev       # auto-restart on changes (nodemon)
```

Then open **http://localhost:3000** to use the frontend tester, or call the API directly.

---

## API reference

### `GET /api/health`

Cheap liveness check — this is what Railway/Render/Docker health checks hit.

```json
{ "success": true, "status": "ok", "version": "1.3.0", "uptime": 12.4, "cache": { "size": 3, "hits": 5, "misses": 8 } }
```

`GET /api/health?deep=1` also runs one real search through the downloader library to check the **upstream provider** is answering. The result is reused for 60 seconds. If the probe fails you get `503` with `"status": "degraded"` and the reason — point an uptime monitor at this URL to be alerted when scraping breaks.

```json
{ "success": false, "status": "degraded", "upstream": { "ok": false, "error": "Upstream answered but returned no results.", "latencyMs": 812 } }
```

### Request IDs and caching

- Every response carries an `X-Request-Id` header (a caller-supplied one is kept if it looks sane). Errors repeat it as `error.requestId`, and it's in the server log line, so a user's report can be matched to the exact request.
- Identical `/api/download` requests that arrive while one is already running share a single upstream call (reqkit's `withDedupe`), so a burst on one URL can't multiply provider traffic.
- Successful `/api/download` responses are cached in memory for `CACHE_TTL_MS`. Cached responses carry `X-Cache: HIT` (fresh ones `MISS`). Failures are never cached. On Vercel each serverless instance has its own cache.

### `GET /api/platforms`

Lists every supported platform, its expected query type, and an example input. The frontend uses this to build its dropdown. Platforms that support pagination (see `?limit=` below) carry `"supportsLimit": true`; platforms the upstream library marks "no longer maintained" carry `"deprecated": true`.

```json
{
  "success": true,
  "count": 20,
  "platforms": [
    { "key": "tiktok", "queryType": "url", "example": "https://www.tiktok.com/@user/video/1234567890" },
    { "key": "youtube-search", "queryType": "query", "example": "Somewhere Only We Know", "supportsLimit": true },
    { "key": "aio", "queryType": "url", "example": "https://www.tiktok.com/@user/video/1234567890", "deprecated": true }
  ]
}
```

### `GET /api/download/:platform?url=...`

Fetches media info/download links for the given platform. Most platforms expect a `url` query param; search-based platforms (like YouTube Search) expect `query` instead — check `queryType` from `/api/platforms`.

For platforms with `supportsLimit: true` (`youtube-search`, `pinterest` when used as a search), an optional `?limit=` caps how many results come back — default `5`, max `50`, silently falls back to the default on anything non-numeric or below `1`.

**Example**

```
GET /api/download/tiktok?url=https://www.tiktok.com/@user/video/1234567890
```

```json
{
  "success": true,
  "platform": "tiktok",
  "query": "https://www.tiktok.com/@user/video/1234567890",
  "result": { "...": "raw response from btch-downloader" },
  "normalized": {
    "kind": "media",
    "title": "...",
    "thumbnail": "...",
    "author": null,
    "media": [{ "label": "Video (no watermark)", "type": "video", "url": "..." }]
  }
}
```

`normalized` is a consistent view built from the raw `result` (see `src/utils/normalizeResult.js`) — either `{ kind: "media", media: [...] }` for a single item, `{ kind: "list", items: [...] }` for search-style results, or `null` when nothing usable was found (the raw `result` is always present regardless).

Twelve platforms have handlers written against real captured responses. Six — `spotify`, `xiaohongshu`, `snackvideo`, `cocofun`, `threads`, `kuaishou` — use a **best-effort scan** instead (find every URL in the response, classify by extension/key name) and carry `"heuristic": true` in `normalized`. Treat those as a convenience, not a guarantee, and prefer the raw `result` if they disagree. Because a miss there may just be a wrong guess, an answer with no recognisable links is passed through rather than turned into a `502` (the verified platforms still `502` on an empty answer). `xiaohongshu-profile` has no normalizer; use `result`.

**Example with a limit**

```
GET /api/download/youtube-search?query=lofi+hip+hop&limit=3
```

```json
{
  "success": true,
  "platform": "youtube-search",
  "query": "lofi hip hop",
  "limit": 3,
  "result": { "...": "raw response, already trimmed to 3 entries" },
  "normalized": { "kind": "list", "items": [ "...", "...", "..." ] }
}
```

### `GET /api/fetch-media?url=...&filename=...`

Streams a direct media URL (one returned inside a `/api/download` result) back through this server with a `Content-Disposition: attachment` header, so a browser click triggers a real file save instead of opening the raw CDN link.

Safety rules:

- Loopback, private, link-local (incl. cloud-metadata `169.254.x.x`), CGNAT and reserved addresses are refused for IPv4 **and** IPv6, including IPv4-mapped forms like `::ffff:127.0.0.1`. The check runs on the address actually connected to (so DNS rebinding doesn't get around it), and again on every redirect hop (max 5).
- `FETCH_MEDIA_ALLOWED_HOSTS` can limit the route to a fixed set of CDN domains. Left unset, it will fetch from any *public* host, so if you expose this API publicly, consider setting it.
- `FETCH_MEDIA_MAX_BYTES` caps file size; the route also has its own, tighter rate limit (`FETCH_MEDIA_RATE_LIMIT_MAX`).
- HTML/JSON/text responses are rejected (they are CDN error pages, not media), filenames are sanitised, and the upstream connection is closed if the client disconnects.
- Error codes: `400` refused address/host, `413` too large, `502` upstream failure or bad redirect, `504` upstream too slow.

**Error response shape** (used consistently across the whole API):

```json
{
  "success": false,
  "error": { "message": "Missing required \"url\" query parameter. Example: ...", "statusCode": 400 }
}
```

### Supported platform keys

| Key                  | Source library function | Input type       |
| -------------------- | ------------------------ | ----------------- |
| `aio` ⚠️ deprecated upstream | `aio`              | url (auto-detects platform) |
| `tiktok`             | `ttdl`                    | url                |
| `instagram`          | `igdl`                    | url                |
| `facebook`           | `fbdown`                  | url                |
| `twitter`            | `twitter`                 | url                |
| `youtube`            | `youtube`                 | url                |
| `youtube-search`     | `yts`                     | query              |
| `spotify`            | `spotify`                 | url                |
| `soundcloud`         | `soundcloud`              | url                |
| `pinterest`          | `pinterest`               | url or search term |
| `mediafire` ⚠️ deprecated upstream | `mediafire`  | url                |
| `gdrive`             | `gdrive`                  | url                |
| `capcut`             | `capcut`                  | url                |
| `douyin`             | `douyin`                  | url                |
| `xiaohongshu`        | `xiaohongshu`             | url                |
| `xiaohongshu-profile`| `xiaohongshuProfile`      | url                |
| `snackvideo`         | `snackvideo`              | url                |
| `cocofun`            | `cocofun`                 | url                |
| `threads`            | `threads`                 | url                |
| `kuaishou`           | `kuaishou`                | url                |

---

## Testing

```bash
npm test
```

Uses Node's built-in test runner (no extra dependencies). The downloader library is stubbed, so the suite runs offline and never calls a real provider; the `fetch-media` streaming tests run against a throwaway local server. `npm run lint` syntax-checks every file. CI (`.github/workflows/ci.yml`) runs lint + tests on Node 20 and 22 for every push and pull request.

---

## Troubleshooting

**`502` — "…source answered but returned no downloadable links"**
The upstream provider replied successfully but with nothing usable (this is what issue #1 looked like). It's usually the provider failing or rate-limiting, not your URL. Wait a minute and retry. If it persists, update `btch-downloader` (`npm update btch-downloader`) — scrapers break whenever a site changes — and check `/api/health?deep=1`.

**`504` — "took too long to respond"**
The provider didn't answer within `DOWNLOAD_TIMEOUT_MS`. Retry, or raise the timeout.

**`429`**
You hit the rate limit (`RATE_LIMIT_MAX` per `RATE_LIMIT_WINDOW_MS`, or `FETCH_MEDIA_RATE_LIMIT_MAX` on `/api/fetch-media`).

**Everyone seems to share one rate limit / `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` in the logs**
You're behind a reverse proxy but Express isn't told to trust it. Set `TRUST_PROXY` to the number of proxy hops in front of the app (`1` for Railway/Render; Vercel is handled automatically).

**Browser says the request was blocked by CORS with several origins set**
`CORS_ORIGIN` takes a comma-separated list, e.g. `https://a.com,https://b.com` (older versions treated the whole string as a single origin).

**Reporting a bug**
Open an issue and include the **Request ID** shown under the error — it lets the maintainer find your request in the logs.

---

## Deploying

The Express app itself (`src/app.js`) is identical across every target below — only the entry point and platform config differ.

### Railway

1. Push this repo to GitHub and create a new Railway project from it (or run `railway up` with the Railway CLI).
2. Railway auto-detects Node via Nixpacks and reads `railway.json`, which sets the start command to `npm start` and points the health check at `/api/health`.
3. Add your environment variables (`PORT` is set automatically by Railway — leave it unset in your Railway env vars) from `.env.example` in the Railway dashboard.

### Render

1. Push to GitHub, then in Render choose **New → Blueprint** and point it at this repo — `render.yaml` defines the service, build command, start command, and health check automatically.
2. Alternatively, create a Web Service manually with build command `npm install` and start command `npm start`.

### Vercel (serverless)

1. Import the repo in Vercel. `vercel.json` routes `/api/*` to the serverless function at `api/index.js` (which just re-exports the same Express app) and serves `public/` as static files directly.
2. No build command needed — Vercel's `@vercel/node` builder bundles `api/index.js` and its dependencies automatically.
3. The in-memory cache is per serverless instance, so hit rates are low. Set `EDGE_CACHE_SECONDS` (e.g. `120`) to let Vercel's edge cache absorb repeat requests. Keep it short — media links expire.
4. Serverless functions have response-size and duration limits, so large files through `/api/fetch-media` may be cut off there; Railway, Render or Docker suit big downloads better.
