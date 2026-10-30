"use strict";
// Background Studio UI. Talks only to the local server it was loaded from.

const TOKEN = document.querySelector('meta[name="studio-token"]').content;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const EXTS = new Set(["jpg", "jpeg", "png", "webp", "bmp", "tif", "tiff", "heic", "heif"]);
const MODE_LABEL = { auto: "Auto", item: "Cut-out item", ink: "Ink only", photo: "Photo subject", card: "Card", keep: "Kept as is" };
const MODE_HINT = {
  auto: "For scans. Decides per image: stickers and tags on a surface are cut out whole, items on blank white become ink only, and cards that fill the scan are kept, with thin scanner edges trimmed and tilt straightened. Click any image to fine-tune it.",
  item: "Cuts the whole sticker, label, tag or card out of its surface. Nothing printed on the item is removed.",
  ink: "Makes the paper transparent and keeps only the ink. Best for stamps, calligraphy, sketches and receipts.",
  photo: "Classic AI cut-out of the main subject in a photo.",
};
const STATUS_LABEL = { queued: "Queued", processing: "Working", done: "Done", skipped: "Skipped", failed: "Failed" };

const S = { version: null, items: [], byId: new Map(), settings: null, models: [], run: null, counts: {}, network: null };
let busy = false;           // an import is in progress
let summaryShownFor = null; // run.started_at of the summary currently shown
let summaryDismissed = null;
let lost = false;

// ---------- helpers ----------
async function api(path, body) {
  const opt = { method: body === undefined ? "GET" : "POST", headers: { "X-Studio-Token": TOKEN } };
  if (body instanceof FormData) opt.body = body;
  else if (body !== undefined) {
    opt.headers["Content-Type"] = "application/json";
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(path, opt);
  let data = null;
  try { data = await r.json(); } catch { /* not JSON */ }
  if (!r.ok) {
    const err = new Error((data && data.error) || `Request failed (${r.status})`);
    err.status = r.status;
    throw err;
  }
  return data;
}
const imgUrl = (id, kind, extra = "") => `/api/image/${id}/${kind}?t=${encodeURIComponent(TOKEN)}${extra}`;
const ext = (name) => (name.split(".").pop() || "").toLowerCase();
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

function fmtDuration(s) {
  if (s == null) return "";
  s = Math.round(s);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
function shortPath(p, max = 0) {
  p = p.replace(/^\/Users\/[^/]+/, "~").replace(/\/+$/, "");
  if (!max || p.length <= max) return p;
  // Keep the start and, above all, the end (the folder/file name) visible.
  const tail = p.slice(-(max - 12));
  return `${p.slice(0, 10)}…${tail.slice(tail.indexOf("/") > 0 ? tail.indexOf("/") : 0)}`;
}
function toast(msg, kind = "info", ms = 4200) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), ms);
  return el;
}
async function act(fn) {
  try { return await fn(); } catch (e) { toast(e.message, "error", 7000); }
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ---------- polling ----------
async function poll() {
  try {
    const d = await api(`/api/state?v=${S.version ?? ""}`);
    if (lost) { lost = false; $("#lostBanner").hidden = true; }
    if (!d.unchanged) {
      Object.assign(S, d);
      S.byId = new Map(S.items.map((it) => [it.id, it]));
      render();
    }
  } catch (e) {
    if (e.status === 403) { location.reload(); return; } // app was restarted: get the new session token
    lost = true;
    $("#lostBanner").hidden = false;
    $("#startBtn").disabled = true;
  }
  setTimeout(poll, S.run && S.run.running ? 400 : 1200);
}

// ---------- steps ----------
let step = 0; // 0 = not decided yet (first state from the server picks it)
let startedHere = false;
const hasRun = () => startedHere || !!S.run || S.items.some((it) => it.status !== "queued");
const STEP_NEEDS = {
  2: () => (S.items.length ? "" : "Add some pictures first."),
  3: () => (!S.items.length ? "Add some pictures first." : hasRun() ? "" : "Start removing backgrounds first (step 2)."),
};
function goStep(n) {
  const why = STEP_NEEDS[n] ? STEP_NEEDS[n]() : "";
  if (why) { toast(why); return; }
  step = n;
  // The picture grid is shared: under "Add images" it shows what's been added; under "Results", the results.
  const slot = $(n === 1 ? "#slot1" : "#slot3");
  for (const id of ["#toolbar", "#grid", "#empty"]) slot.append($(id));
  render();
  $(`.page[data-page="${n}"] .page-body`).scrollTop = 0;
}
function renderSteps() {
  if (!step) { step = 1; goStep(S.run && S.run.running || hasRun() ? 3 : 1); return; }
  if (STEP_NEEDS[step] && STEP_NEEDS[step]()) { goStep(1); return; }
  const c = S.counts;
  const results = (c.done || 0) + (c.skipped || 0);
  const sub = {
    1: S.items.length ? plural(S.items.length, "picture") : "",
    2: S.settings ? (MODE_LABEL[S.settings.mode] || "") : "",
    3: S.run && S.run.running ? `${S.run.completed} of ${S.run.total}…` : results ? `${results.toLocaleString()} ready` : "",
  };
  $$(".step-tab").forEach((b) => {
    const n = Number(b.dataset.step);
    b.classList.toggle("current", n === step);
    b.classList.toggle("done", n < step || (n === 1 && S.items.length > 0) || (n === 3 && results > 0 && step !== 3));
    b.classList.toggle("locked", !!(STEP_NEEDS[n] && STEP_NEEDS[n]()));
    b.setAttribute("aria-current", n === step ? "step" : "false");
    $(`#st${n}`).textContent = sub[n];
  });
  $$(".page").forEach((pg) => { pg.hidden = Number(pg.dataset.page) !== step; });
  $("#next1").disabled = !S.items.length;
  $("#foot1").textContent = S.items.length ? `${plural(S.items.length, "picture")} added` : "Add some pictures to continue";
  $("#foot3").textContent = (c.failed || 0) ? `${plural(c.failed, "picture")} failed. See the Failed filter` : "";
  document.body.dataset.step = step;
}

function render() {
  renderSteps();
  renderSettings();
  renderPrivacy();
  renderProgress();
  renderSummary();
  renderGrid();
  renderToolbar();
  renderStart();
  if ($("#inspector").open) inspectorStateChanged();
}

// ---------- settings ----------
function renderSettings() {
  const s = S.settings;
  if (!s) return;
  const running = !!(S.run && S.run.running);
  $("#outDir").textContent = shortPath(s.output_dir, 34);
  $("#outDir").title = s.output_dir;
  $$("#bgSeg button").forEach((b) => {
    b.classList.toggle("active", b.dataset.bg === s.background);
    b.setAttribute("aria-checked", b.dataset.bg === s.background);
    b.disabled = running;
  });
  $("#customRow").hidden = s.background !== "custom";
  $("#customSw").style.background = s.custom_color;
  $("#bdCustomSw").style.background = s.custom_color;
  if (document.activeElement !== $("#customColor")) $("#customColor").value = s.custom_color;
  if (document.activeElement !== $("#customHex")) $("#customHex").value = s.custom_color;
  const variant = s.background === "transparent" ? null
    : s.background === "custom" ? `on-${s.custom_color.slice(1).toLowerCase()}` : `on-${s.background}`;
  $("#bgHint").textContent = variant
    ? `Transparent PNGs are always saved. A copy on this colour goes in the “${variant}” subfolder.`
    : "Saves transparent PNGs with the original file names.";

  const sel = $("#model");
  if (sel.options.length !== S.models.length) {
    sel.replaceChildren(...S.models.map((m) => {
      const o = el("option", null, `${m.label}${m.installed ? "" : " — not installed"}`);
      o.value = m.name;
      o.disabled = !m.installed;
      return o;
    }));
  }
  sel.value = s.model;
  sel.disabled = running;
  const m = S.models.find((x) => x.name === s.model);
  const missing = S.models.filter((x) => !x.installed);
  $("#modelHint").textContent = (s.mode === "ink" ? "Not used for ink only. " : "") + (m ? m.blurb : "") +
    (missing.length ? ` More models can be added with ./setup.sh --model ${missing[0].name}` : "");
  if (document.activeElement !== $("#mode")) $("#mode").value = s.mode;
  $("#mode").disabled = running;
  $("#modeHint").textContent = MODE_HINT[s.mode] || "";
  $("#skip").checked = s.skip_existing;
  $("#clean").checked = s.clean_edges;
  $("#trim").checked = s.trim;
  ["#skip", "#clean", "#trim", "#chooseOut", "#customColor", "#customHex"].forEach((q) => ($(q).disabled = running));
}

async function saveSettings(changes) {
  await act(async () => {
    const r = await api("/api/settings", changes);
    S.settings = r.settings;
    S.version = null; // force a full refresh
    renderSettings();
    renderStart();
  });
  renderSettings();
}

function renderPrivacy() {
  const n = S.network;
  if (!n) return;
  const btn = $("#privacy");
  btn.classList.toggle("alert", n.blocked > 0);
  $("#privacyText").textContent = n.blocked > 0
    ? `Offline · ${n.blocked} connection${n.blocked === 1 ? "" : "s"} blocked`
    : "Offline · on this Mac only";
  $("#guardLine").textContent = n.active
    ? `Network guard active: outbound connections are blocked (${n.blocked} attempted so far).`
    : "Network guard is not active.";
}

// ---------- progress & summary ----------
function renderProgress() {
  const r = S.run;
  const card = $("#progressCard");
  if (!r || !r.running) { card.hidden = true; return; }
  card.hidden = false;
  const pct = r.total ? Math.round((r.completed / r.total) * 100) : 0;
  const bar = $("#bar");
  bar.classList.toggle("indeterminate", r.phase === "loading-model" || r.phase === "starting");
  $("#barFill").style.width = `${pct}%`;
  bar.setAttribute("aria-valuenow", pct);
  $("#progTitle").textContent = r.cancel_requested ? "Cancelling after the current image…"
    : r.phase === "loading-model" ? "Loading the model (first image only)…"
    : `Processing ${r.completed.toLocaleString()} of ${r.total.toLocaleString()}`;
  $("#progEta").textContent = r.eta_seconds != null ? `about ${fmtDuration(r.eta_seconds)} left` : "";
  $("#stDone").textContent = r.done.toLocaleString();
  $("#stSkip").textContent = r.skipped.toLocaleString();
  $("#stFail").textContent = r.failed.toLocaleString();
  $("#stLeft").textContent = Math.max(r.total - r.completed, 0).toLocaleString();
  $("#progCurrent").textContent = r.current ? `Now: ${r.current}` : "";
}

function renderSummary() {
  const r = S.run;
  const card = $("#summaryCard");
  if (!r || r.running || summaryDismissed === r.started_at) { card.hidden = true; return; }
  card.hidden = false;
  if (summaryShownFor !== r.started_at) {
    summaryShownFor = r.started_at;
    card.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  const failed = S.counts.failed || 0;
  const icon = $("#sumIcon");
  icon.className = "summary-icon" + (failed || r.cancelled || r.fatal ? " warn" : "");
  icon.textContent = failed || r.cancelled || r.fatal ? "!" : "✓";
  $("#sumTitle").textContent = r.fatal ? "Stopped"
    : r.cancelled ? "Batch cancelled"
    : failed ? "Finished, with some problems" : "All done";
  const parts = [];
  if (r.done) parts.push(`${plural(r.done, "image")} processed`);
  if (r.skipped) parts.push(`${r.skipped.toLocaleString()} already done (skipped)`);
  if (r.failed) parts.push(`${r.failed.toLocaleString()} failed`);
  const left = r.total - r.completed;
  if (r.cancelled && left > 0) parts.push(`${left.toLocaleString()} not started`);
  $("#sumText").textContent = `${parts.join(" · ") || "Nothing to do"} in ${fmtDuration(r.elapsed)}. ` +
    `Saved to ${shortPath(S.settings.output_dir, 70)}`;
  $("#sumFatal").hidden = !r.fatal;
  $("#sumFatal").textContent = r.fatal || "";
  $("#sumRetry").hidden = !failed;
  $("#sumRetry").textContent = `Retry ${plural(failed, "failed image")}`;
  $("#sumZip").disabled = !((S.counts.done || 0) + (S.counts.skipped || 0));
}

// ---------- grid ----------
const cards = new Map(); // id -> { el, sig }

function makeCard(it) {
  const card = el("div", "card");
  card.tabIndex = 0;
  card.dataset.id = it.id;
  const thumb = el("div", "thumb");
  const img = el("img");
  img.loading = "lazy";
  img.decoding = "async";
  img.alt = "";
  img.addEventListener("error", () => { img.hidden = true; thumb.classList.add("no-preview"); });
  img.addEventListener("load", () => { img.hidden = false; thumb.classList.remove("no-preview"); });
  const badge = el("span", "badge");
  const rm = el("button", "remove", "×");
  rm.type = "button";
  rm.title = "Remove from list (the file itself is not touched)";
  rm.addEventListener("click", (e) => {
    e.stopPropagation();
    act(() => api("/api/remove", { ids: [it.id] })).then(() => { S.version = null; });
  });
  thumb.append(img, badge, rm);
  const body = el("div", "card-body");
  body.append(el("div", "name"), el("div", "sub"));
  card.append(thumb, body);
  card.addEventListener("click", () => openInspector(it.id));
  card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openInspector(it.id); } });
  return card;
}

function updateCard(card, it) {
  card.dataset.status = it.status;
  const hasResult = it.status === "done" || it.status === "skipped";
  const thumb = $(".thumb", card);
  thumb.classList.toggle("checker", hasResult);
  const img = $("img", card);
  const want = hasResult ? imgUrl(it.id, "result", `&v=${it.finished_at}`) : imgUrl(it.id, "original");
  if (img.dataset.src !== want) {
    img.dataset.src = want;
    img.src = want;
  }
  $(".badge", card).textContent = STATUS_LABEL[it.status] || it.status;
  $(".remove", card).hidden = it.status === "processing";
  $(".name", card).textContent = it.name;
  $(".name", card).title = it.rel;
  let sub = "";
  if (it.status === "queued") sub = `→ ${it.out_rel}`;
  else if (it.status === "processing") sub = "Removing background…";
  else if (it.status === "done") sub = `${MODE_LABEL[it.used_mode] || ""} · ${it.seconds.toFixed(1)}s`;
  else if (it.status === "skipped") sub = it.note || "Already processed";
  else if (it.status === "failed") sub = it.error;
  $(".sub", card).textContent = sub;
  $(".sub", card).title = sub;
}

function renderGrid() {
  const grid = $("#grid");
  const seen = new Set();
  let prev = null;
  for (const it of S.items) {
    seen.add(it.id);
    let c = cards.get(it.id);
    if (!c) { c = { el: makeCard(it), sig: "" }; cards.set(it.id, c); }
    const sig = `${it.status}|${it.finished_at}|${it.error}|${it.note}`;
    if (sig !== c.sig) { updateCard(c.el, it); c.sig = sig; }
    const expected = prev ? prev.nextSibling : grid.firstChild;
    if (expected !== c.el) grid.insertBefore(c.el, expected);
    prev = c.el;
  }
  for (const [id, c] of cards) if (!seen.has(id)) { c.el.remove(); cards.delete(id); }
  $("#empty").hidden = S.items.length > 0;
}

function renderToolbar() {
  $("#toolbar").hidden = S.items.length === 0;
  const c = S.counts;
  const n = { all: S.items.length, queued: (c.queued || 0) + (c.processing || 0), done: c.done || 0, skipped: c.skipped || 0, failed: c.failed || 0 };
  $$("#filters button").forEach((b) => { $("span", b).textContent = n[b.dataset.filter] || ""; });
  const results = (c.done || 0) + (c.skipped || 0);
  $("#zipBtn").disabled = !results;
  const running = !!(S.run && S.run.running);
  $("#clearBtn").disabled = running;
}

function renderStart() {
  const running = !!(S.run && S.run.running);
  $("#startBtn").hidden = running;
  $("#cancelBtn").hidden = !running;
  $("#cancelBtn").disabled = !!(S.run && S.run.cancel_requested);
  const queued = S.counts.queued || 0;
  const total = S.items.length;
  const btn = $("#startBtn");
  btn.disabled = lost || busy || total === 0;
  if (queued > 0) btn.textContent = `Remove backgrounds · ${plural(queued, "image")}`;
  else if (total > 0) btn.textContent = `Run again · ${plural(total, "image")}`;
  else btn.textContent = "Remove backgrounds";
  $("#startHint").textContent = queued === 0 && total > 0 && S.settings && S.settings.skip_existing
    ? "Unchanged images will be skipped. Turn off “Skip” to redo them."
    : "Originals are never changed. Results are saved as new files.";
  $("#dropzone").classList.toggle("disabled", busy);
}

// ---------- Finder dialogs ----------
// The dialog takes a moment to appear; while it's opening (and open) the buttons show it and
// ignore extra clicks, so you never get a stack of Finder windows.
let dialogOpen = false;
async function withDialog(fn, which) {
  if (dialogOpen) { toast("A Finder window is already open. It may be behind your browser."); return null; }
  dialogOpen = true;
  const btns = $$("[data-picker]");
  for (const b of btns) { b.dataset.label = b.textContent; b.disabled = true; }
  const opening = setTimeout(() => btns.forEach((b) => b.classList.add("opening")), 0);
  const label = which && $(which);
  if (label) label.textContent = "Opening Finder…";
  try {
    const r = await fn();
    if (r && r.busy) { toast("A Finder window is already open. It may be behind your browser."); return null; }
    return r;
  } finally {
    clearTimeout(opening);
    for (const b of btns) { b.disabled = false; b.classList.remove("opening"); if (b.dataset.label) b.textContent = b.dataset.label; }
    dialogOpen = false;
  }
}

// ---------- adding images ----------
function reportAdd(r, what = "") {
  const msgs = [];
  if (r.added) msgs.push(`Added ${plural(r.added, "image")}${what}`);
  if (r.duplicates) msgs.push(`${r.duplicates} already in the list`);
  if (r.ignored) msgs.push(`${plural(r.ignored, "file")} ignored (not a supported image)`);
  if (!r.added && !r.duplicates && !(r.problems || []).length) msgs.push("No new images found");
  toast(msgs.join(" · "));
  (r.problems || []).slice(0, 4).forEach((p) => toast(p, "error", 8000));
  S.version = null;
}

async function pick(kind) {
  if (busy) return;
  try {
    const r = await withDialog(() => api("/api/pick", { kind }), { folder: "#addFolder", files: "#addFiles", output: "#chooseOut" }[kind]);
    if (!r || r.cancelled) return;
    if (kind === "output") { S.settings = r.settings; S.version = null; renderSettings(); return; }
    reportAdd(r);
  } catch (e) {
    if (/only available on macOS/.test(e.message)) {
      $(kind === "folder" ? "#folderFallback" : "#fileFallback").click();
    } else toast(e.message, "error", 7000);
  }
}

async function readDropped(dataTransfer) {
  // Must grab entries synchronously, before any await.
  const roots = [];
  for (const item of dataTransfer.items || []) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
    if (entry) roots.push(entry);
    else { const f = item.getAsFile(); if (f) roots.push({ plainFile: f }); }
  }
  const out = [];
  const fileOf = (entry) => new Promise((res, rej) => entry.file(res, rej));
  const readAll = async (dir) => {
    const reader = dir.createReader();
    const all = [];
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) return all;
      all.push(...batch);
    }
  };
  async function walk(entry, prefix) {
    if (entry.plainFile) { out.push({ file: entry.plainFile, rel: entry.plainFile.name }); return; }
    if (entry.name.startsWith(".")) return;
    if (entry.isFile) {
      out.push({ file: await fileOf(entry), rel: prefix + entry.name });
    } else if (entry.isDirectory) {
      const kids = await readAll(entry);
      kids.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      for (const k of kids) await walk(k, `${prefix}${entry.name}/`);
    }
  }
  for (const r of roots) await walk(r, "");
  return out;
}

async function uploadFiles(list) {
  const files = list.filter((x) => EXTS.has(ext(x.file.name)) && !x.file.name.startsWith("."));
  const ignored = list.length - files.length;
  if (!files.length) {
    toast(list.length ? "None of those files are supported images." : "Nothing to add.", "error");
    return;
  }
  busy = true;
  renderStart();
  const dropId = Math.random().toString(36).slice(2, 10);
  const progress = toast(`Adding 0 of ${files.length}…`, "info", 600000);
  const total = { added: 0, ignored, duplicates: 0, problems: [] };
  try {
    let i = 0;
    while (i < files.length) {
      const fd = new FormData();
      fd.append("drop", dropId);
      let bytes = 0, n = 0;
      while (i < files.length && n < 40 && (n === 0 || bytes + files[i].file.size < 96 * 1024 * 1024)) {
        fd.append("rel", files[i].rel);
        fd.append("file", files[i].file, files[i].file.name);
        bytes += files[i].file.size; n++; i++;
      }
      const r = await api("/api/upload", fd);
      total.added += r.added; total.ignored += r.ignored; total.duplicates += r.duplicates;
      total.problems.push(...r.problems);
      progress.textContent = `Adding ${i} of ${files.length}…`;
      S.version = null;
    }
    reportAdd(total);
  } catch (e) {
    toast(`Couldn't add all files: ${e.message}`, "error", 8000);
  } finally {
    progress.remove();
    busy = false;
    renderStart();
  }
}

// ---------- wiring ----------
function wire() {
  $("#addFiles").addEventListener("click", () => pick("files"));
  $("#addFolder").addEventListener("click", () => pick("folder"));
  $("#dropzone").addEventListener("click", () => pick("files"));
  $("#dropzone").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick("files"); } });
  $("#chooseOut").addEventListener("click", () => pick("output"));
  $("#pathForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = $("#pathInput").value.trim().replace(/^["']|["']$/g, "");
    if (!v) return;
    const r = await act(() => api("/api/add-paths", { paths: [v] }));
    if (r) { reportAdd(r); if (r.added) $("#pathInput").value = ""; }
  });
  for (const id of ["#fileFallback", "#folderFallback"]) {
    $(id).addEventListener("change", (e) => {
      const list = [...e.target.files].map((f) => ({ file: f, rel: f.webkitRelativePath || f.name }));
      e.target.value = "";
      uploadFiles(list);
    });
  }

  // Drag and drop anywhere in the window.
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  window.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    $("#dragOverlay").hidden = false;
    $("#dropzone").classList.add("over");
  });
  window.addEventListener("dragover", (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
  window.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (!depth) { $("#dragOverlay").hidden = true; $("#dropzone").classList.remove("over"); }
  });
  window.addEventListener("drop", async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    $("#dragOverlay").hidden = true;
    $("#dropzone").classList.remove("over");
    if (busy) { toast("Still adding the previous drop…"); return; }
    if ($("#inspector").open) $("#inspector").close();
    try {
      const list = await readDropped(e.dataTransfer);
      await uploadFiles(list);
    } catch (err) {
      toast(`Couldn't read the dropped items: ${err.message}`, "error");
    }
  });

  // Settings
  $$("#bgSeg button").forEach((b) => b.addEventListener("click", () => saveSettings({ background: b.dataset.bg })));
  $("#customColor").addEventListener("change", (e) => saveSettings({ custom_color: e.target.value }));
  $("#customHex").addEventListener("change", (e) => {
    let v = e.target.value.trim();
    if (!v.startsWith("#")) v = `#${v}`;
    if (/^#[0-9a-f]{3}$/i.test(v)) v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
    if (/^#[0-9a-f]{6}$/i.test(v)) saveSettings({ custom_color: v.toLowerCase() });
    else { toast("Use a hex colour like #f2efe9", "error"); renderSettings(); }
  });
  $("#model").addEventListener("change", (e) => saveSettings({ model: e.target.value }));
  $("#skip").addEventListener("change", (e) => saveSettings({ skip_existing: e.target.checked }));
  $("#clean").addEventListener("change", (e) => saveSettings({ clean_edges: e.target.checked }));
  $("#trim").addEventListener("change", (e) => saveSettings({ trim: e.target.checked }));

  // Run controls
  $("#startBtn").addEventListener("click", () => act(async () => {
    summaryDismissed = null;
    await api("/api/start", {});
    startedHere = true; // so step 3 opens straight away
    S.version = null;
    goStep(3);
  }));
  $$(".step-tab").forEach((b) => b.addEventListener("click", () => goStep(Number(b.dataset.step))));
  $$("[data-goto]").forEach((b) => b.addEventListener("click", () => goStep(Number(b.dataset.goto))));
  $("#cancelBtn").addEventListener("click", () => act(async () => { await api("/api/cancel", {}); S.version = null; }));
  const retryFailed = () => act(async () => {
    summaryDismissed = null;
    await api("/api/start", { retry_failed: true });
    S.version = null;
  });
  $("#sumRetry").addEventListener("click", retryFailed);
  $("#sumDismiss").addEventListener("click", () => { summaryDismissed = S.run && S.run.started_at; renderSummary(); });
  const openOut = () => act(() => api("/api/reveal", {}));
  $("#sumOpen").addEventListener("click", openOut);
  $("#openOut").addEventListener("click", openOut);
  const zip = () => {
    toast("Preparing ZIP… your browser will save it to Downloads.");
    const a = el("a");
    a.href = `/api/zip?t=${encodeURIComponent(TOKEN)}`;
    a.download = "";
    document.body.append(a);
    a.click();
    a.remove();
  };
  $("#sumZip").addEventListener("click", zip);
  $("#zipBtn").addEventListener("click", zip);
  $("#clearBtn").addEventListener("click", () => {
    if (!confirm("Clear the list? Your original images and saved results are not deleted.")) return;
    act(async () => { await api("/api/clear", {}); S.version = null; });
  });
  $$("#filters button").forEach((b) => b.addEventListener("click", () => {
    $$("#filters button").forEach((x) => x.classList.toggle("active", x === b));
    $("#grid").dataset.filter = b.dataset.filter;
  }));

  // Privacy popover
  const pop = $("#privacyPop");
  $("#privacy").addEventListener("click", (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; });
  document.addEventListener("click", (e) => { if (!pop.contains(e.target)) pop.hidden = true; });

  $("#quitBtn").addEventListener("click", async () => {
    const running = S.run && S.run.running;
    if (!confirm(running ? "A batch is running. Quit anyway? Finished images are kept." : "Quit Background Studio?")) return;
    try { await api("/api/quit", {}); } catch { /* server is going away */ }
    document.body.replaceChildren(Object.assign(el("div", "empty"), {}));
    const msg = $(".empty");
    msg.append(el("h3", null, "Background Studio has stopped."), el("p", null, "You can close this tab. To start again, double-click “Background Studio.command”."));
    lost = true;
  });

  $("#mode").addEventListener("change", (e) => saveSettings({ mode: e.target.value }));
  $("#tagTab").addEventListener("click", (e) => {
    if ($("#inspector").open && ED.dirty && !confirm("Discard your unsaved changes to this image?")) e.preventDefault();
  });
}

async function init() {
  wire();
  try {
    const info = await api("/api/info");
    const names = info.formats.map((f) => f.slice(1).toUpperCase()).filter((f) => !["JPEG", "TIF", "HEIF"].includes(f));
    $("#formatsLine").textContent = names.join(", ");
  } catch { /* poll() reports connection problems */ }
  poll();
}
init();
