// ShopView Tax Calculator -- service worker.
// 1) Rate sync: keeps chrome.storage.local in step with the published rate data on GitHub Pages.
// 2) Update notifier: tells the user when a newer extension version is published on GitHub Pages.
//
// Storage keys (all prefixed stc_ so nothing collides with other ShopView tools):
//   stc_manifest      last good manifest   { generatedAt, format, states: { GA: { month, rows, hash, file } }, index: { file, hash } }
//   stc_zip3          { "303": ["GA"] }  -- index.json's ZIP-prefix part (small; read every time the panel opens)
//   stc_regions       [[name, state, [zips]]]  -- index.json's region-name part (large; read only when needed)
//   stc_rates_<ST>    { state, month, regions: [...], zips: { "30301": [[regionIdx, combined, state, county, city, special, risk]] } }
//   stc_canada        { country: "CA", month, provinces: { ON: { name, type: "HST", hst }, BC: { name, type: "GST", gst, pst } } }
//   stc_sync          { source: "bundled"|"remote", lastSuccess, lastAttempt, lastError }
//   stc_latestVersion newest extension version published (shown in the popup footer when newer)
// A failed sync only updates stc_sync; good data is never removed or half-replaced.

const RATES_SYNC_URL = "https://justmaxsview.github.io/shopview-tax-calc/";
const INSTALL_URL = "https://github.com/justmaxsview/shopview-tax-calc#update-the-extension";
const SYNC_ALARM = "stc-rate-sync", SYNC_MINUTES = 24 * 60;

// The lookup lives in Chrome's side panel so it stays open while you work (a toolbar popup closes on
// any outside click). Toolbar icon and the Alt+Shift+T shortcut both open it; its X closes it.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.commands.onCommand.addListener((cmd, tab) => {
  if (cmd === "open-panel" && tab && tab.windowId !== undefined) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
});

const local = {
  get: keys => chrome.storage.local.get(keys),
  set: obj => chrome.storage.local.set(obj),
  remove: keys => chrome.storage.local.remove(keys),
};

async function sha16(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

// ---------- shape checks (same rules for bundled and remote data) ----------
const ST_RE = /^[A-Z]{2}$/, HASH_RE = /^[0-9a-f]{16}$/;
function checkManifest(m) {
  if (!m || typeof m !== "object" || !m.states || typeof m.states !== "object") throw new Error("manifest has no states");
  const sts = Object.keys(m.states);
  if (!sts.length) throw new Error("manifest lists no states");
  for (const st of sts) {
    const s = m.states[st];
    if (!ST_RE.test(st) || !s || !/^\d{6}$/.test(s.month) || !(s.rows > 0) || !HASH_RE.test(s.hash) || s.file !== `rates_${st}.json`)
      throw new Error(`manifest entry for ${st} is malformed`);
  }
  if (!m.index || m.index.file !== "index.json" || !HASH_RE.test(m.index.hash)) throw new Error("manifest index entry is malformed");
  if (m.canada && (m.canada.file !== "canada.json" || !HASH_RE.test(m.canada.hash) || !/^\d{6}$/.test(m.canada.month)))
    throw new Error("manifest Canada entry is malformed");
}
const CA_CODES = ["AB", "BC", "MB", "NB", "NL", "NT", "NS", "NU", "ON", "PE", "QC", "SK", "YT"];
function checkCanada(c, entry) {
  if (!c || c.country !== "CA" || c.month !== entry.month || !c.provinces) throw new Error("Canada data doesn't match the manifest");
  const rate = x => typeof x === "number" && x >= 0 && x < 0.3;
  for (const code of CA_CODES) {
    const p = c.provinces[code];
    if (!p || typeof p.name !== "string" || !(p.type === "HST" ? rate(p.hst) : p.type === "GST" && rate(p.gst) && rate(p.pst)))
      throw new Error(`Canada entry for ${code} is malformed`);
  }
}
function checkState(d, st, entry) {
  if (!d || d.state !== st || d.month !== entry.month || !Array.isArray(d.regions) || !d.zips || typeof d.zips !== "object")
    throw new Error(`${st} data doesn't match the manifest`);
  let rows = 0;
  for (const [zip, list] of Object.entries(d.zips)) {
    if (!/^\d{5}$/.test(zip) || !Array.isArray(list) || !list.length) throw new Error(`${st} has a bad ZIP entry (${zip})`);
    for (const r of list) {
      if (!Array.isArray(r) || r.length !== 7 || !(r[0] >= 0 && r[0] < d.regions.length) || r.slice(1, 6).some(x => typeof x !== "number" || x < 0 || x >= 1))
        throw new Error(`${st} ZIP ${zip} has a malformed rate row`);
      rows++;
    }
  }
  if (rows !== entry.rows) throw new Error(`${st} has ${rows} rows, manifest says ${entry.rows}`);
}
function checkIndex(ix) {
  if (!ix || !ix.zip3 || typeof ix.zip3 !== "object" || !Array.isArray(ix.regions)) throw new Error("index is malformed");
  for (const r of ix.regions) if (!Array.isArray(r) || typeof r[0] !== "string" || !ST_RE.test(r[1]) || !Array.isArray(r[2])) throw new Error("index region entry is malformed");
}

// ---------- first run / offline fallback: seed storage from the bundled snapshot ----------
async function readBundled(file) { return (await fetch(chrome.runtime.getURL("rates/" + file))).text(); }
// 1.2.0 and older kept the whole index under one key; split it so the panel opens fast.
async function migrateIndex() {
  const { stc_index } = await local.get("stc_index");
  if (!stc_index) return;
  await local.set({ stc_zip3: stc_index.zip3, stc_regions: stc_index.regions });
  await local.remove("stc_index");
}
migrateIndex().catch(() => {});   // runs whenever the worker wakes, not only on install/startup
async function seedFromBundle() {
  const have = await local.get(["stc_manifest", "stc_sync"]);
  if (have.stc_manifest) return;
  const m = JSON.parse(await readBundled("manifest.json"));
  checkManifest(m);
  const out = { stc_manifest: m };
  const ix = JSON.parse(await readBundled("index.json")); checkIndex(ix); out.stc_zip3 = ix.zip3; out.stc_regions = ix.regions;
  for (const [st, entry] of Object.entries(m.states)) {
    const d = JSON.parse(await readBundled(entry.file)); checkState(d, st, entry); out["stc_rates_" + st] = d;
  }
  if (m.canada) { const c = JSON.parse(await readBundled(m.canada.file)); checkCanada(c, m.canada); out.stc_canada = c; }
  out.stc_sync = Object.assign({ source: "bundled", lastSuccess: null, lastAttempt: null, lastError: null }, have.stc_sync || {});
  await local.set(out);
}

// ---------- sync ----------
async function fetchText(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${url.replace(RATES_SYNC_URL, "")} returned ${r.status}`);
  return r.text();
}
async function fetchVerified(file, hash) {
  const text = await fetchText(RATES_SYNC_URL + file);
  if (await sha16(text) !== hash) throw new Error(`${file} doesn't match its published hash`);
  return JSON.parse(text);
}

let running = null;
function sync(reason) {
  if (!running) running = doSync(reason).finally(() => { running = null; });
  return running;
}
async function doSync(reason) {
  const now = new Date().toISOString();
  try { await migrateIndex(); await seedFromBundle(); } catch (e) { /* bundle problem: still try the network */ }
  const prev = (await local.get("stc_sync")).stc_sync || {};
  try {
    const remote = JSON.parse(await fetchText(RATES_SYNC_URL + "manifest.json"));
    checkManifest(remote);
    const cur = (await local.get("stc_manifest")).stc_manifest || { states: {}, index: {} };
    const out = {}, changed = [];
    for (const [st, entry] of Object.entries(remote.states)) {
      const old = cur.states[st];
      const stored = (await local.get("stc_rates_" + st))["stc_rates_" + st];
      if (old && old.hash === entry.hash && stored) continue;
      const d = await fetchVerified(entry.file, entry.hash);
      checkState(d, st, entry);
      out["stc_rates_" + st] = d; changed.push(st);
    }
    const storedIndex = (await local.get("stc_zip3")).stc_zip3;
    if (!cur.index || cur.index.hash !== remote.index.hash || !storedIndex) {
      const ix = await fetchVerified(remote.index.file, remote.index.hash); checkIndex(ix); out.stc_zip3 = ix.zip3; out.stc_regions = ix.regions;
    }
    if (remote.canada) {
      const storedCa = (await local.get("stc_canada")).stc_canada;
      if (!cur.canada || cur.canada.hash !== remote.canada.hash || !storedCa) {
        const c = await fetchVerified(remote.canada.file, remote.canada.hash); checkCanada(c, remote.canada); out.stc_canada = c; changed.push("Canada");
      }
    }
    const removed = Object.keys(cur.states).filter(st => !remote.states[st]);
    // Everything downloaded and checked -- now write it all in one go.
    out.stc_manifest = remote;
    out.stc_sync = { source: "remote", lastSuccess: now, lastAttempt: now, lastError: null };
    await local.set(out);
    if (removed.length) await local.remove(removed.map(st => "stc_rates_" + st));
    if (!remote.canada) await local.remove("stc_canada");
    return { ok: true, changed, removed, reason };
  } catch (e) {
    const msg = String(e && e.message || e).slice(0, 200);
    await local.set({ stc_sync: Object.assign({}, prev, { lastAttempt: now, lastError: msg }) });
    return { ok: false, error: msg, reason };
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_MINUTES });
  sync("install"); checkUpdate();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_MINUTES });
  sync("startup"); checkUpdate();
});
chrome.alarms.onAlarm.addListener(a => {
  if (a.name === SYNC_ALARM) sync("alarm");
  if (a.name === "stc-update-check") checkUpdate();
});
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "STC_SYNC_NOW") { checkUpdate(); sync("manual").then(sendResponse); return true; }
  if (msg && msg.type === "STC_SEED") { seedFromBundle().then(() => sendResponse({ ok: true }), e => sendResponse({ ok: false, error: String(e) })); return true; }
});

// ---------- extension update notifier (version.json convention from Shop's FIB) ----------
// The publish workflow puts extension/version.json on GitHub Pages. If it's newer than the running
// version, remember it (the popup footer shows it) and show one desktop notification per version.
function cmp(a, b) {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) > (pb[i] || 0)) return 1; if ((pa[i] || 0) < (pb[i] || 0)) return -1; }
  return 0;
}
async function checkUpdate() {
  try {
    const running = chrome.runtime.getManifest().version;
    const latest = JSON.parse(await fetchText(RATES_SYNC_URL + "version.json")).version;
    if (!/^\d+\.\d+\.\d+$/.test(latest)) return;
    await local.set({ stc_latestVersion: latest });
    if (cmp(latest, running) > 0) {
      const { stc_notifiedVersion } = await local.get("stc_notifiedVersion");
      if (stc_notifiedVersion !== latest) {
        chrome.notifications.create("stc-update", {
          type: "basic", iconUrl: chrome.runtime.getURL("icon128.png"), priority: 2,
          title: "ShopView Tax Calculator update available",
          message: `Version ${latest} is out (you have ${running}). Click for the 1-minute update steps.`,
        });
        await local.set({ stc_notifiedVersion: latest });
      }
    }
  } catch (e) { /* offline or not published yet; try again later */ }
}
chrome.alarms.create("stc-update-check", { periodInMinutes: 180 });
chrome.notifications.onClicked.addListener(id => { if (id === "stc-update") chrome.tabs.create({ url: INSTALL_URL }); });
