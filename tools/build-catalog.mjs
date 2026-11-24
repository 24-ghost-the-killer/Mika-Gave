#!/usr/bin/env node
// Builds web/public/stars.bin from the Yale Bright Star Catalogue (BSC5, public domain).
//
//   node tools/build-catalog.mjs [bsc5-short.json] [out.bin]
//
// Without an input file it downloads the JSON from brettonw/YaleBrightStarCatalog.
// Record layout (12 bytes, little-endian), sorted brightest first:
//   f32 RA (rad, J2000) | f32 Dec (rad) | i16 V magnitude ×100 | u16 temperature (K, 0 = unknown)
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const SRC = "https://raw.githubusercontent.com/brettonw/YaleBrightStarCatalog/master/bsc5-short.json";
const [input, out = fileURLToPath(new URL("../web/public/stars.bin", import.meta.url))] = process.argv.slice(2);

const text = input ? await readFile(input, "utf8") : await (await fetch(SRC)).text();
const stars = JSON.parse(text);

const ra = (s) => {
  const m = /^(\d+)h (\d+)m ([\d.]+)s$/.exec(s);
  if (!m) throw new Error(`bad RA ${s}`);
  return ((+m[1] + +m[2] / 60 + +m[3] / 3600) * 15 * Math.PI) / 180;
};
const dec = (s) => {
  const m = /^([+-])(\d+)° (\d+)′ ([\d.]+)″$/.exec(s);
  if (!m) throw new Error(`bad Dec ${s}`);
  const v = +m[2] + +m[3] / 60 + +m[4] / 3600;
  return ((m[1] === "-" ? -v : v) * Math.PI) / 180;
};

const rows = stars
  .filter((s) => s.RA && s.Dec && s.V !== undefined && Number.isFinite(+s.V))
  .map((s) => ({ ra: ra(s.RA), dec: dec(s.Dec), v: +s.V, k: Math.min(65535, Math.max(0, Math.round(+s.K || 0))) }))
  .sort((a, b) => a.v - b.v);

const buf = Buffer.alloc(rows.length * 12);
rows.forEach((r, i) => {
  const o = i * 12;
  buf.writeFloatLE(r.ra, o);
  buf.writeFloatLE(r.dec, o + 4);
  buf.writeInt16LE(Math.round(r.v * 100), o + 8);
  buf.writeUInt16LE(r.k, o + 10);
});
await writeFile(out, buf);
console.log(`${rows.length} stars → ${out} (${(buf.length / 1024).toFixed(0)} KiB), mag ${rows[0].v}…${rows.at(-1).v}`);
