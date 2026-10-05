require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const downloaderRoutes = require("./routes/downloader");
const asyncHandler = require("./utils/asyncHandler");
const { downloadCache } = require("./controllers/downloaderController");
const { createHealthHandler } = require("./controllers/healthController");
const { notFound, errorHandler } = require("./middleware/errorHandler");
const requestId = require("./middleware/requestId");
const requestLogger = require("./middleware/requestLogger");
const requestTimeout = require("./middleware/requestTimeout");
const securityHeaders = require("./middleware/securityHeaders");

const app = express();
app.disable("x-powered-by");

// --- Core middleware ---
app.use(requestId); // must come first so every later log line / error has an id
app.use(requestLogger);
app.use(requestTimeout());
app.use(securityHeaders);
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "*",
    // Lets browser clients read these response headers.
    exposedHeaders: ["X-Request-Id", "X-Cache"],
  })
);
app.use(express.json());

// --- Rate limiting (protects the wrapped downloader endpoints from abuse) ---
const limiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
  max: Number(process.env.RATE_LIMIT_MAX) || 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { message: "Too many requests, please try again shortly.", statusCode: 429 } },
});
app.use("/api", limiter);

// --- Static frontend (simple endpoint tester) ---
// Short maxAge so active development picks up changes reasonably fast,
// while repeat visits within that window skip a full re-fetch. etag stays
// on (express.static default) so a change is still picked up immediately
// even within the cache window via a 304 revalidation.
app.use(
  express.static(path.join(__dirname, "..", "public"), {
    maxAge: "1h",
    etag: true,
  })
);

// --- Health check ---
// GET /api/health          -> cheap liveness (what platform health checks hit)
// GET /api/health?deep=1   -> also probes the upstream provider (cached 60s),
//                             503 if it is failing
app.get("/api/health", asyncHandler(createHealthHandler({ getCacheStats: () => downloadCache.stats() })));

// --- API routes ---
app.use("/api", downloaderRoutes);

// --- 404 + error handling (must be last) ---
app.use(notFound);
app.use(errorHandler);

module.exports = app;
