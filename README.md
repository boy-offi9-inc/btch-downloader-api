# @boy-offi9-inc/btch-downloader-api

A small, well-structured REST API that wraps the [`btch-downloader`](https://www.npmjs.com/package/btch-downloader) library, plus a built-in browser page for testing every endpoint without needing Postman.

Fetch public media info/download links from TikTok, Instagram, YouTube, Spotify, Pinterest, SoundCloud, Facebook, Twitter/X, Google Drive, MediaFire, CapCut, Douyin, Xiaohongshu, SnackVideo, Cocofun, Threads, and Kuaishou — all through one consistent JSON API.

---

## Features

- 🎯 One generic route (`/api/download/:platform`) handles all 18 supported platforms
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
│   │   └── errorHandler.js  # 404 + centralized error responses
│   ├── routes/
│   │   └── downloader.js
│   ├── utils/
│   │   ├── ApiError.js
│   │   └── asyncHandler.js
│   ├── app.js               # Express app factory (no listen — reused by every deploy target)
│   └── index.js             # Local/Railway/Render entry point (calls app.listen)
├── .github/workflows/
│   └── ci.yml                # Syntax check + smoke test on push/PR
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

### 3. Run it

```bash
npm start        # production
npm run dev       # auto-restart on changes (nodemon)
```

Then open **http://localhost:3000** to use the frontend tester, or call the API directly.

---

## API reference

### `GET /api/health`

Simple liveness check.

```json
{ "success": true, "status": "ok", "uptime": 12.4 }
```

### `GET /api/platforms`

Lists every supported platform, its expected query type, and an example input. The frontend uses this to build its dropdown.

```json
{
  "success": true,
  "count": 18,
  "platforms": [
    { "key": "tiktok", "queryType": "url", "example": "https://www.tiktok.com/@user/video/1234567890" },
    { "key": "youtube-search", "queryType": "query", "example": "Somewhere Only We Know" }
  ]
}
```

### `GET /api/download/:platform?url=...`

Fetches media info/download links for the given platform. Most platforms expect a `url` query param; search-based platforms (like YouTube Search) expect `query` instead — check `queryType` from `/api/platforms`.

**Example**

```
GET /api/download/tiktok?url=https://www.tiktok.com/@user/video/1234567890
```

```json
{
  "success": true,
  "platform": "tiktok",
  "query": "https://www.tiktok.com/@user/video/1234567890",
  "result": { "...": "raw response from btch-downloader" }
}
```

**Error response shape** (used consistently across the whole API):

```json
{
  "success": false,
  "error": { "message": "Missing required \"url\" query parameter. Example: ...", "statusCode": 400 }
}
```

### Supported platform keys

| Key              | Source library function | Input type       |
| ----------------- | ------------------------ | ----------------- |
| `aio`               | `aio`                     | url (auto-detects platform) |
| `tiktok`           | `ttdl`                    | url                |
| `instagram`        | `igdl`                    | url                |
| `facebook`         | `fbdown`                  | url                |
| `twitter`          | `twitter`                 | url                |
| `youtube`          | `youtube`                 | url                |
| `youtube-search`   | `yts`                     | query              |
| `spotify`          | `spotify`                 | url                |
| `soundcloud`       | `soundcloud`              | url                |
| `pinterest`        | `pinterest`               | url or search term |
| `mediafire`        | `mediafire`               | url                |
| `gdrive`           | `gdrive`                  | url                |
| `capcut`           | `capcut`                  | url                |
| `douyin`           | `douyin`                  | url                |
| `xiaohongshu`      | `xiaohongshu`             | url                |
| `snackvideo`       | `snackvideo`              | url                |
| `cocofun`          | `cocofun`                 | url                |

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
3. Add environment variables from `.env.example` in the Vercel project settings. Note: serverless functions are stateless per-invocation, so the in-memory rate limiter resets between cold starts — fine for personal/testing use, but swap in a shared store (e.g. Redis) if you need strict limits in production.

### Docker (self-hosted / any provider)

```bash
docker build -t btch-downloader-api .
docker run -p 3000:3000 --env-file .env btch-downloader-api
```

The image includes a container-level health check that pings `/api/health`.

---

## Adding a new platform

1. Add an entry to `src/config/platforms.js` with the library's exported function name.
2. That's it — the route, controller, error handling, and frontend dropdown all read from that config automatically.

---

## Notes & disclaimers

- Only works with **publicly accessible** media. It cannot bypass private accounts or login walls.
- This project isn't affiliated with or endorsed by TikTok, Instagram, YouTube, Spotify, or any other platform listed above.
- Make sure you have the right or permission to download any media you fetch through this API.
- `btch-downloader` is a third-party library; if a platform changes its internal API, that specific downloader may temporarily break upstream.

## License

MIT
