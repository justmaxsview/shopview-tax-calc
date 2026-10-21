/* ShopView Tax Calculator -- side panel (stays open until closed, unlike a toolbar popup).
 * US: Country -> ZIP -> State (filled in from the ZIP) -> Tax region (filled in when there's only one;
 * otherwise you pick). Typing a city or region name instead of a ZIP searches region names.
 * Canada: Country -> Province. Canada is taxed province-wide, so the ZIP and Tax region boxes are hidden.
 * Opens fast: reads only the manifest, index and the small Canada table from chrome.storage.local
 * (seeded from the bundled snapshot, kept current by background.js). A US state's ZIP table is
 * loaded the first time a lookup needs it and kept in memory while the panel is open.
 */
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const NOTE = "Estimated tax";
  const SYNC_STALE_DAYS = 7, DATA_STALE_MONTHS = 2, RECENT_MAX = 5, LIST_MAX = 8;
  const UPDATE_URL = "https://github.com/justmaxsview/shopview-tax-calc#update-the-extension";

  const STATES = {
    AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
    DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
    IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
    MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
    NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
    NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
    RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
    VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
    PR: "Puerto Rico",
  };
  const PROVINCES = {
    AB: "Alberta", BC: "British Columbia", MB: "Manitoba", NB: "New Brunswick", NL: "Newfoundland and Labrador",
    NT: "Northwest Territories", NS: "Nova Scotia", NU: "Nunavut", ON: "Ontario", PE: "Prince Edward Island",
    QC: "Quebec", SK: "Saskatchewan", YT: "Yukon",
  };
  // USPS ZIP prefix ranges, used only to pick/name the state when no rates are loaded for it yet.
  const ZIP3 = [[5, 5, "NY"], [6, 9, "PR"], [10, 27, "MA"], [28, 29, "RI"], [30, 38, "NH"], [39, 49, "ME"], [50, 59, "VT"], [55, 55, "MA"],
    [60, 69, "CT"], [70, 89, "NJ"], [100, 149, "NY"], [150, 196, "PA"], [197, 199, "DE"], [200, 205, "DC"], [201, 201, "VA"],
    [206, 219, "MD"], [220, 246, "VA"], [247, 268, "WV"], [270, 289, "NC"], [290, 299, "SC"], [300, 319, "GA"], [398, 399, "GA"],
    [320, 349, "FL"], [350, 369, "AL"], [370, 385, "TN"], [386, 397, "MS"], [400, 427, "KY"], [430, 458, "OH"], [460, 479, "IN"],
    [480, 499, "MI"], [500, 528, "IA"], [530, 549, "WI"], [550, 567, "MN"], [570, 577, "SD"], [580, 588, "ND"], [590, 599, "MT"],
    [600, 629, "IL"], [630, 658, "MO"], [660, 679, "KS"], [680, 693, "NE"], [700, 714, "LA"], [716, 729, "AR"], [730, 749, "OK"],
    [733, 733, "TX"], [750, 799, "TX"], [885, 885, "TX"], [800, 816, "CO"], [820, 831, "WY"], [832, 838, "ID"], [840, 847, "UT"],
    [850, 865, "AZ"], [870, 884, "NM"], [889, 898, "NV"], [900, 961, "CA"], [967, 968, "HI"], [970, 979, "OR"], [980, 994, "WA"],
    [995, 999, "AK"]];
  function stateForZip(zip) {
    const n = +zip.slice(0, 3); let hit = null;
    for (const [a, b, st] of ZIP3) if (n >= a && n <= b) hit = st;   // later, narrower ranges win
    return hit;
  }
  const S = {
    country: "US", manifest: null, index: null, canada: null, sync: null, recent: [], latestVersion: null,
    data: new Map(), current: null, list: [], active: -1, seq: 0,
    zipRows: null,   // rows for the ZIP in the field (US), shown as Tax region options
  };

  // ---------- formatting ----------
  // Region names in the rate files are ALL CAPS; show them in title case.
  const KEEP_CAPS = new Set(["NASCAR", "TSPLOST", "SPLOST", "ESPLOST", "LOST", "ELOST", "FLOST", "HOST", "MOST", "MARTA", "TSP", "TAD", "CID", "US", "II", "III", "IV"]);
  function titleName(s) {
    return String(s).toLowerCase().split(" ").map((w, i) => {
      const up = w.toUpperCase();
      if (KEEP_CAPS.has(up) || (up.length <= 3 && /^[A-Z]+$/.test(up) && !/[AEIOUY]/.test(up))) return up;
      if (i > 0 && (w === "of" || w === "and")) return w;
      return w.replace(/(^|[-'])([a-z])/g, (m, p, c) => p + c.toUpperCase()).replace(/^Mc([a-z])/, (m, c) => "Mc" + c.toUpperCase())
        .replace(/'S\b/, "'s");
    }).join(" ");
  }
  // 0.0775 -> "7.75", 0.07125 -> "7.125", 0.09975 -> "9.975"
  function pctNum(dec) {
    const v = Math.round(dec * 1e6) / 1e4;
    const s = v.toFixed(4).replace(/0+$/, "");
    return /\.\d?$/.test(s) ? v.toFixed(2) : s;
  }
  const pct = dec => pctNum(dec) + "%";
  const money = (n, country) => n.toLocaleString("en-US", { style: "currency", currency: country === "CA" ? "CAD" : "USD" });
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const monthName = m => `${MONTHS[+m.slice(4) - 1]} ${m.slice(0, 4)}`;
  const monthIdx = m => +m.slice(0, 4) * 12 + (+m.slice(4) - 1);
  function monthsOld(m) { const d = new Date(); return d.getFullYear() * 12 + d.getMonth() - monthIdx(m); }
  function ago(iso) {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return "just now";
    const m = Math.round(s / 60); if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
    const h = Math.round(m / 60); if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
    const d = Math.round(h / 24); return `${d} days ago`;
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const placeName = (country, st) => (country === "CA" ? PROVINCES[st] : STATES[st]) || st;

  // ---------- data ----------
  async function bundled(file) { return (await fetch("rates/" + file)).json(); }
  async function loadBase() {
    // Only the small pieces: the region-name list (hundreds of KB with every state) loads on demand.
    const g = await chrome.storage.local.get(["stc_manifest", "stc_zip3", "stc_canada", "stc_sync", "stc_recent", "stc_latestVersion", "stc_country"]);
    S.sync = g.stc_sync || null;
    S.latestVersion = g.stc_latestVersion || null;
    S.recent = Array.isArray(g.stc_recent) ? g.stc_recent : [];
    S.country = g.stc_country === "CA" ? "CA" : "US";
    if (g.stc_manifest && g.stc_zip3) {
      S.manifest = g.stc_manifest; S.zip3 = g.stc_zip3; S.canada = g.stc_canada || null;
    } else {
      // First open before the worker has seeded storage: read the bundled snapshot directly.
      let ix;
      [S.manifest, ix] = await Promise.all([bundled("manifest.json"), bundled("index.json")]);
      S.zip3 = ix.zip3; S.regionsP = Promise.resolve(ix.regions);
      S.canada = S.manifest.canada ? await bundled(S.manifest.canada.file).catch(() => null) : null;
      chrome.runtime.sendMessage({ type: "STC_SEED" }, () => void chrome.runtime.lastError);
    }
  }
  function stateData(st) {
    if (!S.data.has(st)) S.data.set(st, (async () => {
      const k = "stc_rates_" + st, g = await chrome.storage.local.get(k);
      if (g[k]) return g[k];
      const entry = S.manifest.states[st];
      return entry ? bundled(entry.file) : null;
    })().catch(() => null));
    return S.data.get(st);
  }
  const hasData = st => !!(S.manifest && S.manifest.states[st]);
  function regionList() {
    if (!S.regionsP) S.regionsP = chrome.storage.local.get(["stc_regions", "stc_index"])
      .then(g => g.stc_regions || (g.stc_index && g.stc_index.regions) || bundled("index.json").then(ix => ix.regions))
      .catch(() => []);
    return S.regionsP;
  }

  // ---------- small view helpers ----------
  function msg(text, isErr) { const m = $("msg"); m.textContent = text || ""; m.classList.toggle("err", !!isErr); }
  function hideList() { $("list").hidden = true; $("listHead").hidden = true; $("q").setAttribute("aria-expanded", "false"); S.list = []; S.active = -1; }
  function showList(head, items) {
    S.list = items; S.active = -1;
    $("listHead").textContent = head || ""; $("listHead").hidden = !head;
    const ul = $("list");
    ul.innerHTML = items.map((it, i) => `<li role="option" id="opt${i}" aria-selected="false" data-i="${i}">
      <span class="li-name">${esc(it.name)}</span><span class="li-rate">${esc(it.rate || "")}</span><span class="li-meta">${esc(it.meta || "")}</span></li>`).join("");
    ul.hidden = !items.length;
    $("q").setAttribute("aria-expanded", items.length ? "true" : "false");
  }
  function setActive(i) {
    const lis = $("list").querySelectorAll("li");
    if (!lis.length) return;
    S.active = (i + lis.length) % lis.length;
    lis.forEach((li, j) => li.setAttribute("aria-selected", j === S.active ? "true" : "false"));
    lis[S.active].scrollIntoView({ block: "nearest" });
    $("q").setAttribute("aria-activedescendant", "opt" + S.active);
  }
  function clearResult() { $("result").hidden = true; S.current = null; }
  function showIdle() { clearResult(); hideList(); renderRecent(); }

  // Tax region select: options = [{ value, label }], selected value or "" for a prompt.
  function setRegions(options, selected, prompt) {
    const rg = $("rg");
    if (!options) { rg.innerHTML = `<option value="">${esc(prompt || "")}</option>`; rg.disabled = true; return; }
    rg.innerHTML = (prompt ? `<option value="">${esc(prompt)}</option>` : "") +
      options.map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join("");
    rg.disabled = false;
    rg.value = selected || "";
  }
  function setState(st) { $("st").value = st || ""; }

  // ---------- country ----------
  function applyCountry() {
    const us = S.country === "US";
    $("country").value = S.country;
    $("fQ").hidden = !us;            // Canada: province only
    $("fRg").hidden = !us;
    $("stLabel").textContent = us ? "State" : "Province";
    populateStates();
    S.zipRows = null;
    setRegions(null, "", "Enter a ZIP first");
  }
  function populateStates() {
    const sel = $("st");
    if (S.country === "CA") {
      sel.innerHTML = `<option value="">Pick a province</option>` +
        Object.keys(PROVINCES).sort((a, b) => PROVINCES[a].localeCompare(PROVINCES[b])).map(c => `<option value="${c}">${PROVINCES[c]}</option>`).join("");
      return;
    }
    const loaded = Object.keys(STATES).filter(hasData), rest = Object.keys(STATES).filter(s => !hasData(s));
    sel.innerHTML = `<option value="">Pick a state</option>` +
      loaded.map(s => `<option value="${s}">${STATES[s]}</option>`).join("") +
      (rest.length ? `<optgroup label="No rates loaded yet">${rest.map(s => `<option value="${s}">${STATES[s]}</option>`).join("")}</optgroup>` : "");
  }

  // ---------- US: ZIP -> state -> tax region ----------
  async function lookupZip(zip, opts) {
    const my = ++S.seq, forceSt = opts && opts.state, preferRegion = opts && opts.region;
    hideList(); msg("");
    let sts = (S.zip3[zip.slice(0, 3)] || []).slice();
    if (forceSt) sts = sts.filter(s => s === forceSt);
    const rows = [];
    for (const st of sts) {
      const d = await stateData(st);
      if (d && d.zips[zip]) d.zips[zip].forEach(r => rows.push({ country: "US", st, zip, zips: [zip], region: d.regions[r[0]], r, month: d.month }));
    }
    if (my !== S.seq) return;
    S.zipRows = rows.length ? rows : null;
    if (!rows.length) {
      clearResult();
      const guess = forceSt || stateForZip(zip);
      setState(guess);
      setRegions(null, "", "No tax regions");
      if (guess && !hasData(guess)) return msg(`No rates loaded for ${STATES[guess]} yet.`);
      return msg(`No rates for ZIP ${zip}${forceSt ? ` in ${STATES[forceSt]}` : ""}. Check the ZIP or pick a region.`, true);
    }
    const sameState = rows.every(x => x.st === rows[0].st);
    setState(sameState ? rows[0].st : "");
    const opts2 = rows.map((x, i) => ({ value: String(i), label: `${titleName(x.region)}${sameState ? "" : ", " + x.st} · ${pct(x.r[1])}` }));
    const pref = preferRegion ? rows.findIndex(x => x.region === preferRegion) : -1;
    if (rows.length === 1 || pref >= 0) {
      const i = pref >= 0 ? pref : 0;
      setRegions(opts2, String(i));
      return showResult(rows[i]);
    }
    clearResult();
    setRegions(opts2, "", `Pick one of ${rows.length} regions`);
    msg(`ZIP ${zip} is in ${rows.length} tax regions. Pick one under Tax region.`);
    $("rg").focus();
  }

  // State picked without a ZIP: offer all its regions.
  async function offerStateRegions(st) {
    S.zipRows = null;
    if (!st) { setRegions(null, "", "Enter a ZIP first"); return; }
    if (!hasData(st)) { setRegions(null, "", "No tax regions"); clearResult(); return msg(`No rates loaded for ${STATES[st]} yet.`); }
    const names = (await regionList()).filter(r => r[1] === st).map(r => r[0]);
    setRegions(names.map(n => ({ value: "name:" + n, label: titleName(n) })), "", `Pick a region (${names.length})`);
  }

  // Region by name: one result if every ZIP in it has the same rates, else list the ZIPs.
  async function lookupRegion(name, st) {
    const my = ++S.seq;
    hideList(); msg("");
    const d = await stateData(st);
    if (my !== S.seq) return;
    if (!d) { clearResult(); return msg(`No rates loaded for ${STATES[st] || st} yet.`); }
    const ri = d.regions.indexOf(name);
    const rows = [];
    for (const [zip, list] of Object.entries(d.zips)) list.forEach(r => { if (r[0] === ri) rows.push({ zip, r }); });
    if (!rows.length) { clearResult(); return msg(`No rates for ${titleName(name)}. Pick another region.`, true); }
    const groups = new Map();
    rows.forEach(x => { const k = x.r.slice(1).join("|"); (groups.get(k) || groups.set(k, []).get(k)).push(x); });
    if (groups.size === 1) {
      const zips = rows.map(x => x.zip).sort();
      return showResult({ country: "US", st, zip: zips.length === 1 ? zips[0] : null, zips, region: name, r: rows[0].r, month: d.month });
    }
    clearResult();
    const sameTotal = new Set(rows.map(x => x.r[1])).size === 1;
    showList(sameTotal ? `${titleName(name)} is ${pct(rows[0].r[1])} everywhere, but the breakdown differs by ZIP. Pick one:`
      : `${titleName(name)} has different rates by ZIP. Pick one:`, rows.sort((a, b) => a.zip.localeCompare(b.zip)).map(x => ({
      name: x.zip, meta: `${titleName(name)}, ${st}`, rate: pct(x.r[1]),
      pick: () => { $("q").value = x.zip; lookupZip(x.zip, { region: name }); },
    })));
    setActive(0);
  }

  // Typing a name instead of a ZIP.
  async function typeahead(text) {
    const my = ++S.seq;
    const q = text.trim().toLowerCase();
    msg(""); clearResult();
    const regions = await regionList();
    if (my !== S.seq) return;
    const hits = [];
    for (const r of regions) {
      const n = r[0].toLowerCase(), at = n.indexOf(q);
      if (at < 0) continue;
      hits.push({ r, score: (at === 0 ? 0 : n[at - 1] === " " ? 1 : 2) });
    }
    hits.sort((a, b) => a.score - b.score || a.r[0].localeCompare(b.r[0]) || a.r[1].localeCompare(b.r[1]));
    const top = hits.slice(0, LIST_MAX);
    if (!top.length) { hideList(); return msg(`No tax region matches "${text.trim()}". Check the spelling or enter a ZIP.`, true); }
    const items = top.map(({ r: [name, st, zips] }) => ({
      name: titleName(name), meta: `${st} · ${zips.length} ZIP${zips.length === 1 ? "" : "s"}`, rate: "",
      key: [name, st], pick: () => pickRegionByName(name, st),
    }));
    showList(hits.length > LIST_MAX ? `${hits.length} matches. Keep typing to narrow.` : "", items);
    const sts = [...new Set(top.map(h => h.r[1]))];
    for (const st of sts) {
      const d = await stateData(st);
      if (my !== S.seq || !d) continue;
      items.forEach((it, i) => {
        if (it.key[1] !== st) return;
        const ri = d.regions.indexOf(it.key[0]);
        const rates = new Set();
        for (const z of regions.find(r => r[0] === it.key[0] && r[1] === st)[2]) (d.zips[z] || []).forEach(r => { if (r[0] === ri) rates.add(r[1]); });
        const v = [...rates].sort((a, b) => a - b);
        it.rate = v.length === 1 ? pct(v[0]) : v.length ? `${pctNum(v[0])}–${pct(v[v.length - 1])}` : "";
        const el = $("list").querySelector(`li[data-i="${i}"] .li-rate`); if (el) el.textContent = it.rate;
      });
    }
  }
  async function pickRegionByName(name, st) {
    setState(st); await offerStateRegions(st); $("rg").value = "name:" + name;
    lookupRegion(name, st);
  }

  // ---------- Canada: province ----------
  function caResult(code) {
    hideList(); msg("");
    if (!code) { clearResult(); return; }
    if (!S.canada) { clearResult(); return msg("No rates loaded for Canada yet."); }
    const p = S.canada.provinces[code];
    if (!p) { clearResult(); return msg(`No rates loaded for ${PROVINCES[code] || code} yet.`); }
    setState(code);
    showResult({ country: "CA", st: code, zip: null, zips: [], region: p.name, p, month: S.canada.month });
  }

  // ---------- result ----------
  // Breakdown labels are the exact column headers of the rate files.
  // US: TAXRATES_ZIP5_<ST><YYYYMM>.csv. Canada: CANADA_SALES_TAX_<YYYYMM>.csv (PST is N/A where HST applies).
  function partsOf(x) {
    if (x.country === "CA") {
      return x.p.type === "HST" ? [{ label: "GST_HST", v: x.p.hst, cls: "s-state" }, { label: "PST", v: null, cls: "s-county" }]
        : [{ label: "GST_HST", v: x.p.gst, cls: "s-state" }, { label: "PST", v: x.p.pst, cls: "s-county" }];
    }
    const [, , sR, coR, ciR, spR] = x.r;
    return [{ label: "StateRate", v: sR, cls: "s-state" }, { label: "EstimatedCountyRate", v: coR, cls: "s-county" },
      { label: "EstimatedCityRate", v: ciR, cls: "s-city" }, { label: "EstimatedSpecialRate", v: spR, cls: "s-special" }];
  }
  const partVal = p => p.v === null ? "N/A" : pct(p.v);
  const combOf = x => x.country === "CA" ? (x.p.type === "HST" ? x.p.hst : x.p.gst + x.p.pst) : x.r[1];
  const riskOf = x => x.country === "US" && x.r[6] > 1;

  function countUp(el, target) {
    const end = pctNum(target);
    if (reduceMotion()) { el.textContent = end; return; }
    const dp = (end.split(".")[1] || "").length, goal = target * 100, t0 = performance.now(), dur = 240;
    const step = t => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = k < 1 ? (goal * e).toFixed(dp) : end;
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  function showResult(x) {
    hideList(); msg("");
    S.current = x;
    const comb = combOf(x), parts = partsOf(x);
    $("rRegion").textContent = x.country === "CA" ? x.region : titleName(x.region);
    const place = placeName(x.country, x.st);
    $("rWhere").textContent = x.country === "CA" ? "Canada · province-wide"
      : x.zip ? `${place} ${x.zip}` : `${place} · ${x.zips.length} ZIPs: ${x.zips.slice(0, 4).join(", ")}${x.zips.length > 4 ? "…" : ""}`;
    countUp($("rRate"), comb);
    const total = parts.reduce((a, b) => a + (b.v || 0), 0) || 1;
    $("stack").innerHTML = parts.filter(p => p.v > 0).map(p => `<span class="seg ${p.cls}" style="flex-grow:${p.v / total}"></span>`).join("");
    const st = $("stack"); st.classList.remove("grow"); void st.offsetWidth; st.classList.add("grow");
    $("parts").innerHTML = parts.map(p => `<div><dt><i class="sw ${p.cls}"></i>${p.label}</dt><dd>${partVal(p)}</dd></div>`).join("") +
      (x.country === "US" ? `<div class="total"><dt>EstimatedCombinedRate</dt><dd>${pct(comb)}</dd></div>` : "");
    $("risk").hidden = !riskOf(x);
    $("rNote").textContent = NOTE;
    $("rMonth").textContent = `${x.country === "CA" ? "Canada" : place} rates from ${monthName(x.month)}`;
    $("copied").textContent = "";
    updateAmount();
    $("result").hidden = false;
    $("recent").hidden = true;
    remember({ c: x.country, st: x.st, zip: x.zip, region: x.region, comb });
  }
  function parseAmount() {
    const v = $("amt").value.replace(/[$,\s]/g, "");
    if (!/^\d*\.?\d+$/.test(v)) return null;
    return parseFloat(v);
  }
  function updateAmount() {
    const out = $("amtOut"), a = parseAmount();
    if (!S.current || a == null) { out.textContent = ""; return; }
    const tax = Math.round(a * combOf(S.current) * 100) / 100, c = S.current.country;
    out.textContent = `Tax ${money(tax, c)} · Total ${money(a + tax, c)}`;
  }
  function breakdownText() {
    const x = S.current; if (!x) return "";
    const comb = combOf(x), c = x.country;
    const where = c === "CA" ? `${x.region}, Canada` : `${titleName(x.region)}, ${x.st}${x.zip ? " " + x.zip : ""}`;
    const lines = [where, `${c === "US" ? "EstimatedCombinedRate" : "Combined rate"}: ${pct(comb)}`, partsOf(x).map(p => `${p.label} ${partVal(p)}`).join(" | ")];
    const a = parseAmount();
    if (a != null) { const tax = Math.round(a * comb * 100) / 100; lines.push(`Amount ${money(a, c)} | Tax ${money(tax, c)} | Total ${money(a + tax, c)}`); }
    if (riskOf(x)) lines.push("This ZIP crosses city or county lines; the rate can differ by street address.");
    lines.push(`${c === "CA" ? "Canada" : placeName(c, x.st)} rates from ${monthName(x.month)}. ${NOTE}.`);
    return lines.join("\n");
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); $("copied").textContent = "Copied"; }
    catch (e) { $("copied").textContent = "Couldn't copy. Select the text and press Ctrl+C."; }
    clearTimeout(copy.t); copy.t = setTimeout(() => { $("copied").textContent = ""; }, 1800);
  }

  // ---------- recent ----------
  function remember(item) {
    S.recent = [item, ...S.recent.filter(r => !((r.c || "US") === item.c && r.zip === item.zip && r.region === item.region && r.st === item.st))].slice(0, RECENT_MAX);
    chrome.storage.local.set({ stc_recent: S.recent });
  }
  function renderRecent() {
    const sec = $("recent");
    if (!S.recent.length || S.current) { sec.hidden = true; return; }
    $("recentList").innerHTML = S.recent.map((r, i) => {
      const c = r.c || "US";
      const name = c === "CA" ? r.region : titleName(r.region);
      const meta = c === "CA" ? "Canada" : STATES[r.st] || r.st;
      return `<li><button type="button" data-r="${i}">
      <span class="li-name">${r.zip && c === "US" ? `<span class="rec-zip">${esc(r.zip)}</span>` : ""}${esc(name)}</span>
      <span class="li-rate">${esc(pct(r.comb))}</span><span class="li-meta">${esc(meta)}</span></button></li>`;
    }).join("");
    sec.hidden = false;
  }
  function openRecent(r) {
    const c = r.c || "US";
    if (c !== S.country) { S.country = c; chrome.storage.local.set({ stc_country: c }); applyCountry(); }
    if (c === "CA") return caResult(r.st);
    if (r.zip) { $("q").value = r.zip; lookupZip(r.zip, { region: r.region }); }
    else { $("q").value = ""; pickRegionByName(r.region, r.st); }
  }

  // ---------- footer: data month, sync status, warnings ----------
  function renderFooter() {
    const months = Object.values(S.manifest.states).map(s => s.month);
    if (S.manifest.canada) months.push(S.manifest.canada.month);
    months.sort();
    const lo = months[0], hi = months[months.length - 1];
    $("fMonth").textContent = lo === hi ? `Rates from ${monthName(hi)}` : `Rates from ${monthName(lo)} to ${monthName(hi)}`;
    const sy = S.sync || {};
    $("fSync").textContent = sy.lastSuccess ? `Synced ${ago(sy.lastSuccess)}` : "Not synced yet. Using built-in rates.";

    const warn = [];
    if (sy.lastSuccess && (Date.now() - Date.parse(sy.lastSuccess)) > SYNC_STALE_DAYS * 864e5)
      warn.push(`Last successful sync was ${ago(sy.lastSuccess)}. Rates may be out of date.`);
    const old = Object.entries(S.manifest.states).filter(([, s]) => monthsOld(s.month) > DATA_STALE_MONTHS).map(([st]) => st);
    if (S.manifest.canada && monthsOld(S.manifest.canada.month) > DATA_STALE_MONTHS) old.push("Canada");
    if (old.length) warn.push(`${old.join(", ")} rates are more than ${DATA_STALE_MONTHS} months old.`);
    $("fWarn").textContent = warn.join(" "); $("fWarn").hidden = !warn.length;

    const failed = sy.lastError && (!sy.lastSuccess || Date.parse(sy.lastAttempt) > Date.parse(sy.lastSuccess));
    const using = sy.lastSuccess ? `Using rates synced ${ago(sy.lastSuccess)}.` : "Using built-in rates.";
    const offline = /failed to fetch|networkerror|network error|load failed/i.test(sy.lastError || "");
    $("fErr").textContent = !failed ? ""
      : offline ? `Couldn't reach the rate server. ${using} Check your internet connection, then try again.`
      : `Couldn't update rates (${sy.lastError}). ${using} Try again later.`;
    $("fErr").hidden = !failed;
    $("syncBtn").textContent = failed ? "Try again" : "Sync now";

    const running = chrome.runtime.getManifest().version, latest = S.latestVersion;
    const newer = latest && latest.split(".").map(Number).reduce((r, n, i) => r || Math.sign(n - (+running.split(".")[i] || 0)), 0) > 0;
    $("fUpd").innerHTML = newer ? `Version ${esc(latest)} is available (you have ${esc(running)}). <a href="${UPDATE_URL}" target="_blank" rel="noopener">How to update</a>` : "";
    $("fUpd").hidden = !newer;
  }
  async function syncNow() {
    const b = $("syncBtn");
    b.disabled = true; b.textContent = "Syncing";
    const res = await new Promise(r => chrome.runtime.sendMessage({ type: "STC_SYNC_NOW" }, x => { void chrome.runtime.lastError; r(x || { ok: false, error: "the background worker didn't answer" }); }));
    const g = await chrome.storage.local.get(["stc_manifest", "stc_zip3", "stc_canada", "stc_sync"]);
    if (g.stc_manifest && g.stc_zip3) { S.manifest = g.stc_manifest; S.zip3 = g.stc_zip3; S.canada = g.stc_canada || S.canada; S.regionsP = null; }
    S.sync = g.stc_sync || S.sync;
    if (res.ok && (res.changed.length || res.removed.length)) S.data.clear();
    b.disabled = false;
    renderFooter();
    if (S.country === "US") { const st = $("st").value; populateStates(); setState(st); }
    if (res.ok) $("fSync").textContent = res.changed.length ? `Synced just now. Updated ${res.changed.join(", ")}.` : "Synced just now. Already up to date.";
    if (S.current && res.ok && res.changed.some(c => c === S.current.st || (c === "Canada" && S.current.country === "CA"))) route();
  }

  // ---------- input routing + keyboard ----------
  function route() {
    if (S.country === "CA") return;   // Canada has no code field; the Province select drives it
    const v = $("q").value.trim();
    if (!v) { ++S.seq; msg(""); S.zipRows = null; return showIdle(); }
    if (/^\d[\d\s-]*$/.test(v)) {
      const digits = v.replace(/\D/g, "");
      if (digits.length >= 5) return lookupZip(digits.slice(0, 5));
      ++S.seq; clearResult(); hideList(); msg(""); return;   // still typing a ZIP
    }
    if (v.length >= 2) return typeahead(v);
    ++S.seq; hideList(); msg("");
  }
  let routeT = null;
  function onInput() { clearTimeout(routeT); routeT = setTimeout(route, /^\d/.test($("q").value.trim()) ? 0 : 60); }
  function onKey(e) {
    const open = !$("list").hidden && S.list.length;
    if (e.key === "ArrowDown" && open) { e.preventDefault(); setActive(S.active + 1); }
    else if (e.key === "ArrowUp" && open) { e.preventDefault(); setActive(S.active - 1); }
    else if (e.key === "Enter") {
      if (open) { e.preventDefault(); S.list[Math.max(0, S.active)].pick(); }
      else { clearTimeout(routeT); route(); }
    } else if (e.key === "Escape" && $("q").value) { e.preventDefault(); $("q").value = ""; route(); }
  }
  function onStateChange() {
    const st = $("st").value;
    hideList();
    if (S.country === "CA") { if (!st) showIdle(); return caResult(st); }
    const zip = $("q").value.replace(/\D/g, "");
    if (zip.length >= 5 && /^\d[\d\s-]*$/.test($("q").value.trim())) return lookupZip(zip.slice(0, 5), { state: st || null });
    clearResult(); msg("");
    if (st) $("q").value = "";
    offerStateRegions(st);
    if (!st) showIdle();
  }
  function onRegionChange() {
    const v = $("rg").value;
    if (!v) return;
    if (v.startsWith("name:")) return lookupRegion(v.slice(5), $("st").value);
    if (S.zipRows && S.zipRows[+v]) showResult(S.zipRows[+v]);
  }

  // Light / Dark: saved in localStorage (read by theme.js before paint). Until one is picked, the
  // panel follows the system setting and the matching button shows as pressed.
  function applyTheme(t) {
    if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
    const cur = t || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.querySelectorAll("[data-theme-pick]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.themePick === cur)));
  }
  function initTheme() {
    let saved = null; try { saved = localStorage.getItem("stc_theme"); } catch (e) {}
    applyTheme(saved === "light" || saved === "dark" ? saved : null);
    document.querySelectorAll("[data-theme-pick]").forEach(b => b.addEventListener("click", () => {
      try { localStorage.setItem("stc_theme", b.dataset.themePick); } catch (e) {}
      applyTheme(b.dataset.themePick);
    }));
  }

  function focusFirst() { (S.country === "CA" ? $("st") : $("q")).focus(); }

  async function boot() {
    initTheme();
    await loadBase();
    applyCountry();
    renderFooter();
    renderRecent();
    $("country").addEventListener("change", () => {
      S.country = $("country").value; chrome.storage.local.set({ stc_country: S.country });
      ++S.seq; $("q").value = ""; msg(""); applyCountry(); showIdle(); focusFirst();
    });
    $("closeBtn").addEventListener("click", () => window.close());
    $("q").addEventListener("input", onInput);
    $("q").addEventListener("keydown", onKey);
    $("list").addEventListener("mousedown", e => e.preventDefault());   // keep focus in the search box
    $("list").addEventListener("click", e => { const li = e.target.closest("li"); if (li) S.list[+li.dataset.i].pick(); });
    $("st").addEventListener("change", onStateChange);
    $("rg").addEventListener("change", onRegionChange);
    $("recentList").addEventListener("click", e => {
      const b = e.target.closest("button[data-r]"); if (b) openRecent(S.recent[+b.dataset.r]);
    });
    $("amt").addEventListener("input", updateAmount);
    $("copyRate").addEventListener("click", () => S.current && copy(pct(combOf(S.current))));
    $("copyAll").addEventListener("click", () => copy(breakdownText()));
    $("syncBtn").addEventListener("click", syncNow);
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== "local") return;
      if (ch.stc_sync) S.sync = ch.stc_sync.newValue;
      if (ch.stc_latestVersion) S.latestVersion = ch.stc_latestVersion.newValue;
      if (ch.stc_canada && ch.stc_canada.newValue) S.canada = ch.stc_canada.newValue;
      if (ch.stc_sync || ch.stc_latestVersion) renderFooter();
    });
    focusFirst();
    performance.mark("stc-ready");
  }

  boot().catch(e => { msg(`Couldn't load rate data (${e.message}). Reinstall the extension or click Sync now.`, true); });
})();
