const app = require("./app");

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 btch-downloader-api running at http://localhost:${PORT}`);
});
