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
- 🛡️ Centralized error handling, input validation, and rate limiting
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
│   │   └── ttlCache.js      # in-memory response cache
│   ├── app.js               # Express app factory (no listen — reused by every deploy target)
│   └── index.js             # Local/Railway/Render entry point (calls app.listen)
├── test/                     # node:test suite (npm test)
├── .github/
│   ├── workflows/ci.yml      # Tests + smoke test on push/PR
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
| `CORS_ORIGIN`              | `*`     | Allowed CORS origin(s)                    |
| `RATE_LIMIT_WINDOW_MS`     | `60000` | Rate limit window, in milliseconds        |
| `RATE_LIMIT_MAX`           | `30`    | Max requests per IP per window            |
| `DOWNLOAD_TIMEOUT_MS`      | `25000` | Max wait for the downloader library       |
| `CACHE_TTL_MS`             | `300000`| Cache successful downloads this long (`0` = off) |
| `CACHE_MAX_ENTRIES`        | `200`   | Max cached responses (oldest evicted)     |

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
{ "success": true, "status": "ok", "version": "1.1.0", "uptime": 12.4, "cache": { "size": 3, "hits": 5, "misses": 8 } }
```

`GET /api/health?deep=1` also runs one real search through the downloader library to check the **upstream provider** is answering. The result is reused for 60 seconds. If the probe fails you get `503` with `"status": "degraded"` and the reason — point an uptime monitor at this URL to be alerted when scraping breaks.

```json
{ "success": false, "status": "degraded", "upstream": { "ok": false, "error": "Upstream answered but returned no results.", "latencyMs": 812 } }
```

### Request IDs and caching

- Every response carries an `X-Request-Id` header (a caller-supplied one is kept if it looks sane). Errors repeat it as `error.requestId`, and it's in the server log line, so a user's report can be matched to the exact request.
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

`normalized` is a consistent, per-platform-verified view built from the raw `result` (see `src/utils/normalizeResult.js`) — either `{ kind: "media", media: [...] }` for a single item, `{ kind: "list", items: [...] }` for search-style results, or `null` for a platform without a dedicated handler yet (the raw `result` is always present regardless).

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

Streams a direct media URL (one returned inside a `/api/download` result) back through this server with a `Content-Disposition: attachment` header, so a browser click triggers a real file save instead of opening the raw CDN link. Also blocks requests to loopback/private-network hosts so the route can't be used as an open internal-network proxy.

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

Uses Node's built-in test runner (no extra dependencies). The downloader library is stubbed, so the suite runs offline and never calls a real provider. CI (`.github/workflows/ci.yml`) runs it on Node 20 and 22 for every push and pull request.

---

## Troubleshooting

**`502` — "…source answered but returned no downloadable links"**
The upstream provider replied successfully but with nothing usable (this is what issue #1 looked like). It's usually the provider failing or rate-limiting, not your URL. Wait a minute and retry. If it persists, update `btch-downloader` (`npm update btch-downloader`) — scrapers break whenever a site changes — and check `/api/health?deep=1`.

**`504` — "took too long to respond"**
The provider didn't answer within `DOWNLOAD_TIMEOUT_MS`. Retry, or raise the timeout.

**`429`**
You hit the rate limit (`RATE_LIMIT_MAX` per `RATE_LIMIT_WINDOW_MS`).

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
