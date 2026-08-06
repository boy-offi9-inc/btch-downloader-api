// Vercel wraps this exported Express app as a serverless function.
// It reuses the exact same app as the local/Railway/Render server (src/app.js),
// so behavior stays identical across every deployment target.
const app = require("../src/app");

module.exports = app;
