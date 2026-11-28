#!/usr/bin/env node
// Builds the public star data:
//
//   web/public/stars.bin        every star of the Yale Bright Star Catalogue (BSC5, public domain)
//   web/public/near-stars.json  distances for the brighter, nearer stars, from the HYG database
//                               (CC BY-SA 4.0, https://github.com/astronexus/HYG-Database); used to
//                               find "her star", whose light left it around the year she was born.
//
//   node tools/build-catalog.mjs [--bsc bsc5-short.json] [--hyg hygdata_v41.csv]
//
// Missing inputs are downloaded. stars.bin record (12 bytes, little-endian), brightest first:
//   f32 RA (rad, J2000) | f32 Dec (rad) | i16 V magnitude ×100 | u16 temperature (K, 0 = unknown)
// near-stars.json: [{ "i": index in stars.bin, "n": name, "d": distance in light-years }]
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const BSC_URL = "https://raw.githubusercontent.com/brettonw/YaleBrightStarCatalog/master/bsc5-short.json";
const HYG_URL = "https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv";
const out = (p) => fileURLToPath(new URL(`../web/public/${p}`, import.meta.url));

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const load = async (path, url) => (path ? readFile(path, "utf8") : (await fetch(url)).text());

// ---------- stars.bin (BSC5) ----------

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

const rows = JSON.parse(await load(arg("--bsc"), BSC_URL))
  .filter((s) => s.RA && s.Dec && s.V !== undefined && Number.isFinite(+s.V))
  .map((s) => ({ hr: +s.HR, ra: ra(s.RA), dec: dec(s.Dec), v: +s.V, k: Math.min(65535, Math.max(0, Math.round(+s.K || 0))) }))
  .sort((a, b) => a.v - b.v); // stable: equal magnitudes keep catalogue order

const buf = Buffer.alloc(rows.length * 12);
rows.forEach((r, i) => {
  const o = i * 12;
  buf.writeFloatLE(r.ra, o);
  buf.writeFloatLE(r.dec, o + 4);
  buf.writeInt16LE(Math.round(r.v * 100), o + 8);
  buf.writeUInt16LE(r.k, o + 10);
});
await writeFile(out("stars.bin"), buf);
console.log(`${rows.length} stars → web/public/stars.bin (${(buf.length / 1024).toFixed(0)} KiB)`);

// ---------- near-stars.json (HYG distances, matched by HR number) ----------

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const split = (line) => {
    const cells = [];
    let cur = "";
    let q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === "," && !q) {
        cells.push(cur);
        cur = "";
      } else cur += ch;
    }
    cells.push(cur);
    return cells;
  };
  const head = split(lines[0]);
  return lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [head[i], v])));
}

const GREEK = {
  Alp: "α", Bet: "β", Gam: "γ", Del: "δ", Eps: "ε", Zet: "ζ", Eta: "η", The: "θ", Iot: "ι", Kap: "κ", Lam: "λ", Mu: "μ",
  Nu: "ν", Xi: "ξ", Omi: "ο", Pi: "π", Rho: "ρ", Sig: "σ", Tau: "τ", Ups: "υ", Phi: "φ", Chi: "χ", Psi: "ψ", Ome: "ω",
};
const LY_PER_PC = 3.26156;

const byHr = new Map();
for (const s of parseCsv(await load(arg("--hyg"), HYG_URL))) {
  if (s.hr && +s.dist > 0 && +s.dist < 100000) byHr.set(+s.hr, s);
}

const near = [];
rows.forEach((r, i) => {
  const s = byHr.get(r.hr);
  if (!s || r.v > 4.5) return;
  const ly = +s.dist * LY_PER_PC;
  if (ly > 400) return;
  const bayer = s.bayer ? `${GREEK[s.bayer.replace(/-?\d+$/, "")] ?? s.bayer}${(s.bayer.match(/\d+$/) || [""])[0]} ${s.con}` : "";
  const name = s.proper || bayer || (s.flam ? `${s.flam} ${s.con}` : `HR ${r.hr}`);
  near.push({ i, n: name, d: Math.round(ly * 10) / 10 });
});
await writeFile(out("near-stars.json"), JSON.stringify(near));
console.log(`${near.length} stars with distances → web/public/near-stars.json`);
