#!/usr/bin/env node
/*
 * Build the published rate data from the ZIP5 rate CSVs in csv/.
 *
 *   node scripts/build.js            -> writes dist/
 *   node scripts/build.js --check    -> validate only, write nothing
 *
 * Input:  csv/TAXRATES_ZIP5_<ST><YYYYMM>.csv, one file per US state,
 *         csv/CANADA_SALES_TAX_<YYYYMM>.csv, one province-level file for Canada.
 * Output: dist/rates_<ST>.json   one state's ZIP table (lazy-loaded by the extension)
 *         dist/index.json        small lookup index: ZIP prefix -> states, region name -> ZIPs
 *         dist/canada.json       province GST/HST/PST rates
 *         dist/manifest.json     { generatedAt, states: { GA: { month, rows, hash, file } }, index: { hash, file }, canada: { month, rows, hash, file } }
 *
 * Any problem in any file fails the whole build (exit 1) and nothing is written, so a bad upload
 * never gets published and the last good data stays live on GitHub Pages.
 * No external dependencies: Node 18+ only.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const CSV_DIR = path.join(ROOT, "csv");
const DIST = path.join(ROOT, "dist");
const HEADERS = ["State", "ZipCode", "TaxRegionName", "EstimatedCombinedRate", "StateRate",
  "EstimatedCountyRate", "EstimatedCityRate", "EstimatedSpecialRate", "RiskLevel"];
const NAME_RE = /^TAXRATES_ZIP5_([A-Z]{2})(\d{4})(\d{2})\.csv$/;
// Canada: one province-level file, e.g. CANADA_SALES_TAX_202610.csv, rates written as percents.
const CA_NAME_RE = /^CANADA_SALES_TAX_(\d{4})(\d{2})\.csv$/;
const CA_HEADERS = ["Province", "Code", "GST_HST", "PST"];
const CA_PROVINCES = { AB: "Alberta", BC: "British Columbia", MB: "Manitoba", NB: "New Brunswick", NL: "Newfoundland and Labrador",
  NT: "Northwest Territories", NS: "Nova Scotia", NU: "Nunavut", ON: "Ontario", PE: "Prince Edward Island", QC: "Quebec",
  SK: "Saskatchewan", YT: "Yukon" };
const MAX_ERRORS_PER_FILE = 10;

function parseCSV(text) {
  const rows = []; let f = "", row = [], q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
    else if (c !== "\r") f += c;
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ""));
}

// Rates are decimals: 0.077500 = 7.75%. Keep them as numbers rounded to 6 places.
function rate(v, label, where, errors) {
  const t = String(v).trim();
  if (!/^\d*\.?\d+$/.test(t)) { errors.push(`${where}: ${label} "${v}" is not a number`); return 0; }
  const n = Math.round(parseFloat(t) * 1e6) / 1e6;
  if (!(n >= 0 && n < 1)) errors.push(`${where}: ${label} ${t} must be a decimal between 0 and 1 (0.0775 = 7.75%)`);
  return n;
}

function buildState(file) {
  const errors = [], warnings = [];
  const m = NAME_RE.exec(file);
  if (!m) return { errors: [`${file}: file name must be TAXRATES_ZIP5_<ST><YYYYMM>.csv, e.g. TAXRATES_ZIP5_GA202610.csv`] };
  const state = m[1], month = m[2] + m[3];
  if (+m[3] < 1 || +m[3] > 12) return { errors: [`${file}: month ${m[3]} in the file name is not 01-12`] };

  const rows = parseCSV(fs.readFileSync(path.join(CSV_DIR, file), "utf8").replace(/^﻿/, ""));
  if (!rows.length) return { errors: [`${file}: file is empty`] };
  const hdr = rows[0].map(h => h.trim());
  if (hdr.join(",") !== HEADERS.join(","))
    return { errors: [`${file}: headers don't match the ZIP5 rate file layout.\n    expected: ${HEADERS.join(",")}\n    found:    ${hdr.join(",")}`] };

  const regions = [], regionIdx = new Map(), zips = {}, seen = new Set();
  let padded = 0;
  for (let i = 1; i < rows.length && errors.length < MAX_ERRORS_PER_FILE; i++) {
    const r = rows[i], where = `${file} line ${i + 1}`;
    if (r.length !== HEADERS.length) { errors.push(`${where}: expected ${HEADERS.length} columns, found ${r.length}`); continue; }
    if (r[0].trim() !== state) { errors.push(`${where}: State "${r[0]}" doesn't match the file name (${state})`); continue; }
    let zip = r[1].trim();
    if (/^\d{3,4}$/.test(zip)) { zip = zip.padStart(5, "0"); padded++; }   // Excel drops leading zeros
    if (!/^\d{5}$/.test(zip)) { errors.push(`${where}: ZipCode "${r[1]}" is not 5 digits`); continue; }
    const region = r[2].trim();
    if (!region) { errors.push(`${where}: TaxRegionName is empty`); continue; }
    const risk = r[8].trim();
    if (!/^\d+$/.test(risk)) { errors.push(`${where}: RiskLevel "${r[8]}" is not a whole number`); continue; }
    const key = zip + "|" + region;
    if (seen.has(key)) { errors.push(`${where}: ZIP ${zip} / ${region} appears twice`); continue; }
    seen.add(key);
    const comb = rate(r[3], "EstimatedCombinedRate", where, errors);
    const parts = [rate(r[4], "StateRate", where, errors), rate(r[5], "EstimatedCountyRate", where, errors),
      rate(r[6], "EstimatedCityRate", where, errors), rate(r[7], "EstimatedSpecialRate", where, errors)];
    let ri = regionIdx.get(region);
    if (ri === undefined) { ri = regions.length; regions.push(region); regionIdx.set(region, ri); }
    // row: [regionIndex, combined, state, county, city, special, riskLevel]
    (zips[zip] = zips[zip] || []).push([ri, comb, ...parts, +risk]);
  }
  if (errors.length >= MAX_ERRORS_PER_FILE) errors.push(`${file}: stopped after ${MAX_ERRORS_PER_FILE} errors`);
  if (!seen.size && !errors.length) errors.push(`${file}: no data rows`);
  if (padded) warnings.push(`${file}: ${padded} ZIP(s) had lost their leading zero and were padded to 5 digits`);
  return { state, month, file, rows: seen.size, regions, zips, errors, warnings };
}

// Canada file: Province,Code,GST_HST,PST with percents like 5%, 9.975%, 0% or N/A.
// PST "N/A" means the province charges HST (one harmonized rate in GST_HST).
function buildCanada(file) {
  const errors = [];
  const m = CA_NAME_RE.exec(file);
  const month = m[1] + m[2];
  if (+m[2] < 1 || +m[2] > 12) return { errors: [`${file}: month ${m[2]} in the file name is not 01-12`] };
  const rows = parseCSV(fs.readFileSync(path.join(CSV_DIR, file), "utf8").replace(/^﻿/, ""));
  if (!rows.length) return { errors: [`${file}: file is empty`] };
  const hdr = rows[0].map(h => h.trim());
  if (hdr.join(",") !== CA_HEADERS.join(","))
    return { errors: [`${file}: headers must be exactly ${CA_HEADERS.join(",")} (found ${hdr.join(",")})`] };
  const pctVal = (v, label, where, allowNA) => {
    const t = String(v).trim();
    if (allowNA && /^n\/?a$/i.test(t)) return null;
    const mm = /^(\d+(?:\.\d+)?)\s*%?$/.exec(t);
    if (!mm) { errors.push(`${where}: ${label} "${v}" must be a percent like 5% or 9.975%${allowNA ? ", or N/A" : ""}`); return 0; }
    const n = parseFloat(mm[1]);
    if (!(n >= 0 && n < 30)) errors.push(`${where}: ${label} ${t} looks wrong (expected 0% to 30%)`);
    return Math.round(n * 1e4) / 1e6;   // 9.975 -> 0.09975
  };
  const provinces = {};
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i], where = `${file} line ${i + 1}`;
    if (r.length !== CA_HEADERS.length) { errors.push(`${where}: expected ${CA_HEADERS.length} columns, found ${r.length}`); continue; }
    const code = r[1].trim().toUpperCase(), name = r[0].trim();
    if (!CA_PROVINCES[code]) { errors.push(`${where}: Code "${r[1]}" isn't a Canadian province or territory code`); continue; }
    if (provinces[code]) { errors.push(`${where}: ${code} appears twice`); continue; }
    if (name.toLowerCase() !== CA_PROVINCES[code].toLowerCase()) { errors.push(`${where}: Province "${name}" doesn't match code ${code} (${CA_PROVINCES[code]})`); continue; }
    const main = pctVal(r[2], "GST_HST", where, false), pst = pctVal(r[3], "PST", where, true);
    if (main === 0) { errors.push(`${where}: GST_HST can't be 0%`); continue; }
    provinces[code] = pst === null ? { name: CA_PROVINCES[code], type: "HST", hst: main }
      : { name: CA_PROVINCES[code], type: "GST", gst: main, pst };
  }
  const missing = Object.keys(CA_PROVINCES).filter(c => !provinces[c]);
  if (missing.length && !errors.length) errors.push(`${file}: missing ${missing.join(", ")}. List all 13 provinces and territories.`);
  return { file, month, provinces, rows: Object.keys(provinces).length, errors };
}

function sha(text) { return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16); }

function main() {
  const checkOnly = process.argv.includes("--check");
  if (!fs.existsSync(CSV_DIR)) { console.error("No csv/ folder."); process.exit(1); }
  const files = fs.readdirSync(CSV_DIR).filter(f => !f.startsWith(".") && f.toLowerCase() !== "readme.md").sort();
  const errors = [], warnings = [], built = [], byState = {};

  let canada = null;
  for (const f of files) {
    if (!f.toLowerCase().endsWith(".csv")) { errors.push(`${f}: only .csv files belong in csv/`); continue; }
    if (CA_NAME_RE.test(f)) {
      const c = buildCanada(f);
      errors.push(...c.errors);
      if (c.errors.length) continue;
      if (canada) { errors.push(`Two Canada files: ${canada.file} and ${f}. Delete the old one.`); continue; }
      canada = c; continue;
    }
    const s = buildState(f);
    errors.push(...s.errors); warnings.push(...(s.warnings || []));
    if (s.errors.length) continue;
    if (byState[s.state]) { errors.push(`Two files for ${s.state}: ${byState[s.state]} and ${f}. Delete the old one so each state has exactly one file.`); continue; }
    byState[s.state] = f;
    built.push(s);
  }
  if (!built.length && !errors.length) errors.push("csv/ has no rate files.");

  warnings.forEach(w => console.warn("warning: " + w));
  if (errors.length) {
    console.error(`\nBuild FAILED: ${errors.length} problem(s). Nothing was published; the last good data stays live.\n`);
    errors.forEach(e => console.error("  - " + e));
    process.exit(1);
  }

  const out = {}, manifest = { generatedAt: new Date().toISOString(), format: 1, states: {}, index: null };
  const index = { zip3: {}, regions: [] };   // regions: [name, state, [zips]]
  for (const s of built) {
    const json = JSON.stringify({ state: s.state, month: s.month, regions: s.regions, zips: s.zips });
    const file = `rates_${s.state}.json`;
    out[file] = json;
    manifest.states[s.state] = { month: s.month, rows: s.rows, hash: sha(json), file, source: s.file };
    const regionZips = s.regions.map(() => []);
    for (const [zip, list] of Object.entries(s.zips)) {
      const z3 = zip.slice(0, 3);
      const st = index.zip3[z3] = index.zip3[z3] || [];
      if (!st.includes(s.state)) st.push(s.state);
      list.forEach(row => regionZips[row[0]].push(zip));
    }
    s.regions.forEach((name, i) => index.regions.push([name, s.state, regionZips[i].sort()]));
  }
  index.regions.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  out["index.json"] = JSON.stringify(index);
  manifest.index = { file: "index.json", hash: sha(out["index.json"]) };
  if (canada) {
    out["canada.json"] = JSON.stringify({ country: "CA", month: canada.month, provinces: canada.provinces });
    manifest.canada = { month: canada.month, rows: canada.rows, hash: sha(out["canada.json"]), file: "canada.json", source: canada.file };
    console.log(`ok  Canada  ${canada.month}  ${canada.rows} provinces/territories  ${canada.file}`);
  }
  out["manifest.json"] = JSON.stringify(manifest, null, 2) + "\n";

  for (const s of built) console.log(`ok  ${s.state}  ${s.month}  ${String(s.rows).padStart(5)} rows  ${s.regions.length} regions  ${s.file}`);
  if (checkOnly) { console.log("\nCheck passed (nothing written)."); return; }

  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
  for (const [f, text] of Object.entries(out)) fs.writeFileSync(path.join(DIST, f), text);
  fs.writeFileSync(path.join(DIST, ".nojekyll"), "");
  console.log(`\nWrote ${Object.keys(out).length} files to dist/.`);
}

main();
