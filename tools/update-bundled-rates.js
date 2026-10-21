#!/usr/bin/env node
/*
 * Copy the built dist/ into extension/rates/ (the bundled first-run/offline snapshot).
 *
 *   node scripts/build.js && node tools/update-bundled-rates.js
 *
 * Run from anywhere; paths are relative to this repo. Every file listed in dist/manifest.json is
 * checked against its hash before anything is copied; the old snapshot is replaced only if all pass.
 * Only needed for a fresher offline fallback in the next extension version; users get new rates through sync.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const repo = path.resolve(process.argv[2] || path.join(__dirname, ".."));
const dist = path.join(repo, "dist");
const target = path.join(__dirname, "..", "extension", "rates");
const sha = t => crypto.createHash("sha256").update(t).digest("hex").slice(0, 16);

function fail(msg) { console.error("Not updated: " + msg); process.exit(1); }

if (!fs.existsSync(path.join(dist, "manifest.json")))
  fail(`no ${path.join(dist, "manifest.json")}. Run "node scripts/build.js" first.`);
const manifest = JSON.parse(fs.readFileSync(path.join(dist, "manifest.json"), "utf8"));
const files = { "manifest.json": fs.readFileSync(path.join(dist, "manifest.json"), "utf8") };
const want = [[manifest.index.file, manifest.index.hash],
  ...Object.values(manifest.states).map(s => [s.file, s.hash]),
  ...(manifest.canada ? [[manifest.canada.file, manifest.canada.hash]] : [])];
for (const [file, hash] of want) {
  const p = path.join(dist, file);
  if (!fs.existsSync(p)) fail(`${file} is listed in the manifest but missing from dist/`);
  const text = fs.readFileSync(p, "utf8");
  if (sha(text) !== hash) fail(`${file} doesn't match its manifest hash. Run "node scripts/build.js" again.`);
  files[file] = text;
}

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(target, file), text);
for (const [st, s] of Object.entries(manifest.states)) console.log(`${st}  ${s.month}  ${s.rows} rows`);
console.log(`Bundled ${Object.keys(files).length} files into ${target}`);
