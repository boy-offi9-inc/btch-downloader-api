// Dependency-free "lint": syntax-checks every .js file under src/, api/,
// test/, public/ and scripts/ with `node --check`, so a typo fails CI before
// the server ever boots. (Swap in ESLint later if you want style rules.)
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const dirs = ["src", "api", "test", "public", "scripts"];
const files = [];

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith(".js")) files.push(full);
  }
}
dirs.forEach((d) => walk(path.join(root, d)));

let failed = 0;
for (const file of files) {
  const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (r.status !== 0) {
    failed += 1;
    console.error(`✗ ${path.relative(root, file)}\n${r.stderr}`);
  }
}
console.log(`${files.length - failed}/${files.length} files OK`);
process.exit(failed ? 1 : 0);
