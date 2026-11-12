// node test-version.mjs — every local module URL carries the same ?v= version as index.html,
// so a browser can never link an old cached module into a new release (blank-board bug in v3).
import assert from "assert";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

const ROOT = new URL(".", import.meta.url).pathname;
const html = readFileSync(join(ROOT, "index.html"), "utf8");
const version = (html.match(/<meta name="boardle-version" content="([^"]+)">/) || [])[1];
assert.ok(version, "index.html needs <meta name=boardle-version>");
assert.ok(html.includes(`src="app.js?v=${version}"`), "app.js script tag is versioned");
assert.ok(html.includes(`href="style.css?v=${version}"`), "style.css link is versioned");
assert.ok(html.includes("__boardleBootFailed"), "boot guard present");

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (["vendor", "node_modules", "tests", "tools", "boardle_backend"].includes(n) || n.startsWith(".")) return [];
    return statSync(p).isDirectory() ? walk(p) : (/\.m?js$/.test(n) ? [p] : []);
  });
}
const spec = /(?:\bfrom|\bimport)\s*\(?\s*(["'])(\.\.?\/[^"']+)\1/g;
let checked = 0;
const browserModules = new Set();
for (const file of walk(ROOT)) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(spec)) {
    checked++;
    assert.ok(m[2].endsWith(`?v=${version}`), `${relative(ROOT, file)}: import "${m[2]}" must end with ?v=${version} (run python3 tools/stamp_version.py ${version})`);
  }
  if (file.endsWith(".js")) browserModules.add(relative(ROOT, file));
}
assert.ok(checked > 20, `found ${checked} local imports`);
// The boot guard's "Reload fresh copy" list must cover every browser module
for (const m of browserModules) assert.ok(html.includes(`"${m}"`), `boot guard FILES list is missing ${m}`);
console.log(`version ${version}: ${checked} local imports stamped, ${browserModules.size} modules in boot guard list ✓`);
