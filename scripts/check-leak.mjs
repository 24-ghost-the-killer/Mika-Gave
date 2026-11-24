#!/usr/bin/env node
// Fails if any plaintext from content/gift.toml ended up in the public build (web/dist).
// Only the ciphertext in dist/v/ may relate to the gift; nothing readable may.
//
//   node scripts/check-leak.mjs [content/gift.toml] [web/dist]
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const [toml = join(root, "content/gift.toml"), dist = join(root, "web/dist")] = process.argv.slice(2);

if (!existsSync(toml)) {
  console.log(`check-leak: ${toml} not found; nothing to check against (fine for CI).`);
  process.exit(0);
}

// Every quoted string value in the TOML, plus its words of 5+ letters. Comments are ignored.
const text = (await readFile(toml, "utf8")).replace(/^\s*#.*$/gm, "");
const values = [...text.matchAll(/"""([\s\S]*?)"""|"((?:[^"\\]|\\.)*)"/g)].map((m) => (m[1] ?? m[2]).trim()).filter(Boolean);
const IGNORE = new Set(["photos", "jpg", "jpeg", "png", "webp"]);
const needles = new Set();
for (const v of values) {
  if (v.length >= 4 && !/^photos\//.test(v)) needles.add(v.toLowerCase());
  for (const w of v.toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (w.length >= 5 && !IGNORE.has(w)) needles.add(w);
}
// Words the app's own Danish UI uses (web/src/strings.da.ts) are public anyway.
const ui = (await readFile(join(root, "web/src/strings.da.ts"), "utf8")).toLowerCase();
for (const w of ui.split(/[^\p{L}\p{N}]+/u)) needles.delete(w);

async function* files(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (p === join(dist, "v")) continue; // ciphertext
      yield* files(p);
    } else if (/\.(html|js|css|json|txt|svg|xml|webmanifest|map)$/.test(e.name)) yield p;
  }
}

let hits = 0;
for await (const f of files(dist)) {
  const body = (await readFile(f, "utf8")).toLowerCase();
  for (const n of needles) {
    // Whole-word match, so short names don't hit inside unrelated identifiers.
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}\\p{N}]|$)`, "u");
    if (re.test(body)) {
      console.error(`LEAK: "${n}" found in ${f}`);
      hits++;
    }
  }
}
if (hits) {
  console.error(`\ncheck-leak: ${hits} plaintext hit(s) in the public build. Fix before deploying.`);
  process.exit(1);
}
console.log(`check-leak: OK (${needles.size} phrases checked, none in ${dist}).`);
