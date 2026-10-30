"use strict";
// The image inspector and per-image editor: before/after compare, method, sliders,
// crop & straighten, and touch-up brushes. Uses helpers from app.js (S, api, $, $$, toast, act…).
//
// How it fits together:
//  * The server renders a fast preview (cut-out + matching original "frame") for the current
//    method and adjustments. Brush strokes are painted on two canvases (keep / erase) and
//    composited on top in the browser, so brushing is instant.
//  * Save sends method + adjustments + the brush layers; the server re-renders at full size.

const ED = {
  id: null,
  zoom: 1, split: 50, backdrop: "checker", ar: 1,
  mode: "auto", adjust: {}, dirty: false,
  live: null,            // { cut: Image, frame: Image, w, h, used, why, quad }
  seq: 0, timer: null, busy: false,
  tool: "view", brush: 40,
  keep: null, erase: null, baseKeep: null, baseErase: null,
  strokes: [], stroke: null, editsAction: "keep", editsLoadedFor: null,
  crop: null,            // while adjusting corners: { quad, geoSrc, ar }
  picking: false,
  grid: lsGet("bgs-grid") === "1", gridFlash: false, gridTimer: null,
  rectLock: lsGet("bgs-rect-lock") !== "0",
};

// Per-viewer conveniences only; the page works without storage.
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

const IDENTITY_QUAD = [[0, 0], [1, 0], [1, 1], [0, 1]];
const MODE_NAME = { auto: "Auto", item: "Cut-out item", ink: "Ink only", photo: "Photo", card: "Card", keep: "Keep as is" };

function currentItem() { return S.byId.get(ED.id); }
function hasResult(it) { return it && (it.status === "done" || it.status === "skipped"); }
function deepEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
// SVG elements have no .hidden property (it's HTML-only), so toggle the attribute.
function showSvg(svg, show) {
  const el = typeof svg === "string" ? $(svg) : svg;
  if (show) el.removeAttribute("hidden"); else el.setAttribute("hidden", "");
}

function signed(n) { return `${n > 0 ? "+" : ""}${n}`; }

function readClipboard() {
  try { return JSON.parse(lsGet("bgs-clipboard") || "null"); } catch { return null; }
}

function describeSettings(c) {
  const a = c.adjust || {}, bits = [MODE_NAME[c.mode] || c.mode];
  if (a.rot90) bits.push(`turn ${a.rot90 * 90}°`);
  if (a.angle) bits.push(`straighten ${a.angle}°`);
  if (a.ink) bits.push(`ink ${signed(Math.round(a.ink * 100))}`);
  if (a.paper) bits.push(`paper ${a.paper}`);
  if (a.grow) bits.push(`edge ${signed(a.grow)}`);
  if (a.soften) bits.push(`soft ${a.soften}`);
  if (a.bright) bits.push(`brightness ${signed(Math.round(a.bright * 100))}`);
  if (a.contrast) bits.push(`contrast ${signed(Math.round(a.contrast * 100))}`);
  if (a.sat) bits.push(`saturation ${signed(Math.round(a.sat * 100))}`);
  if (a.autotone) bits.push("auto levels");
  return bits.join(", ");
}

function toRect(q) {
  const x0 = Math.max(q[0][0], q[3][0]), x1 = Math.min(q[1][0], q[2][0]);
  const y0 = Math.max(q[0][1], q[1][1]), y1 = Math.min(q[2][1], q[3][1]);
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

// ---------- grid ----------
function drawGrid() {
  const svg = $("#gridSvg");
  const show = ED.grid || ED.gridFlash || !!ED.crop;
  showSvg(svg, show);
  if (!show) return;
  const lines = [];
  for (let i = 1; i < 10; i++) {
    const v = i * 100;
    lines.push(`<line class="dark" x1="${v}" y1="0" x2="${v}" y2="1000" transform="translate(1.5,0)"/>`,
      `<line x1="${v}" y1="0" x2="${v}" y2="1000"/>`,
      `<line class="dark" x1="0" y1="${v}" x2="1000" y2="${v}" transform="translate(0,1.5)"/>`,
      `<line x1="0" y1="${v}" x2="1000" y2="${v}"/>`);
  }
  if (ED.crop) {  // thirds inside the crop, to line up straight edges and corners
    const q = ED.crop.quad;
    const x0 = Math.min(q[0][0], q[3][0]) * 1000, x1 = Math.max(q[1][0], q[2][0]) * 1000;
    const y0 = Math.min(q[0][1], q[1][1]) * 1000, y1 = Math.max(q[2][1], q[3][1]) * 1000;
    for (const t of [1 / 3, 2 / 3]) {
      const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
      lines.push(`<line class="third" x1="${x}" y1="${y0}" x2="${x}" y2="${y1}"/>`,
        `<line class="third" x1="${x0}" y1="${y}" x2="${x1}" y2="${y}"/>`);
    }
  }
  svg.innerHTML = lines.join("");
}

function flashGrid() {
  ED.gridFlash = true;
  drawGrid();
  clearTimeout(ED.gridTimer);
  ED.gridTimer = setTimeout(() => { ED.gridFlash = false; drawGrid(); }, 1400);
}

// ---------- rotation ----------
// Crop corners and brush strokes are in the rotated frame, so they no longer fit after a rotation.
function geometryChanged() {
  if (ED.adjust.crop && !isIdentity(ED.adjust.crop)) {
    delete ED.adjust.crop;
    toast("The crop was reset because the rotation changed.");
  }
  const it = currentItem();
  if (ED.strokes.length || ED.baseKeep || (it && it.has_edits && ED.editsAction === "keep")) {
    ED.strokes = [];
    ED.baseKeep = ED.baseErase = null;
    ED.editsAction = "clear";
    redrawLayers();
    toast("Touch-ups were cleared because the rotation changed.");
  }
}

function setGeometry(rot90, angle, delay = 220) {
  const before = `${ED.adjust.rot90 || 0}/${ED.adjust.angle || 0}`;
  rot90 = ((rot90 % 4) + 4) % 4;
  angle = Math.round(angle * 100) / 100;
  if (rot90) ED.adjust.rot90 = rot90; else delete ED.adjust.rot90;
  if (Math.abs(angle) > 0.001) ED.adjust.angle = angle; else delete ED.adjust.angle;
  if (before === `${ED.adjust.rot90 || 0}/${ED.adjust.angle || 0}`) return;
  geometryChanged();
  markDirty();
  schedulePreview(delay);
}

function isIdentity(q) { return !!q && q.every(([x, y], i) => Math.abs(x - IDENTITY_QUAD[i][0]) < 0.002 && Math.abs(y - IDENTITY_QUAD[i][1]) < 0.002); }

function visibleIds() {
  const f = $("#grid").dataset.filter;
  return S.items.filter((it) => f === "all" || it.status === f || (f === "queued" && it.status === "processing")).map((it) => it.id);
}

// ---------- opening / closing ----------
function confirmDiscard() {
  return !ED.dirty || confirm("Discard your unsaved changes to this image?");
}

function openInspector(id) {
  if (ED.id && ED.id !== id && $("#inspector").open && !confirmDiscard()) return;
  const it = S.byId.get(id);
  if (!it) return;
  ED.id = id;
  ED.zoom = 1;
  $("#stageWrap").scrollTo(0, 0);
  ED.mode = it.mode_override || S.settings.mode;
  ED.adjust = JSON.parse(JSON.stringify(it.adjust || {}));
  ED.dirty = false;
  ED.live = null;
  ED.seq++;
  ED.strokes = [];
  ED.editsAction = "keep";
  ED.editsLoadedFor = null;
  ED.baseKeep = ED.baseErase = null;
  ED.crop = null;
  ED.picking = false;
  setTool("view");
  $("#liveCanvas").hidden = true;
  $("#inAfter").hidden = false;
  if (it.size) ED.ar = it.size[0] / it.size[1];
  ED.lastFinished = it.finished_at;
  fillInspector();
  if (!$("#inspector").open) $("#inspector").showModal();
  layoutStage();
  showZoomHint();
  if (hasResult(it)) requestPreview();
}

function closeInspector() {
  if (!confirmDiscard()) return false;
  ED.dirty = false;
  ED.id = null;
  ED.seq++;
  $("#inspector").close();
  return true;
}

function stepInspector(delta) {
  const ids = visibleIds();
  const next = ids[ids.indexOf(ED.id) + delta];
  if (next) openInspector(next);
}

// Called by app.js whenever the server state changes while the inspector is open.
function inspectorStateChanged() {
  const it = currentItem();
  if (!it) { ED.dirty = false; $("#inspector").close(); return; }
  // When a save (or rerun) finishes, reload the preview so the editor matches the saved result.
  const finishedChanged = it.finished_at !== ED.lastFinished;
  ED.lastFinished = it.finished_at;
  if (finishedChanged && hasResult(it) && !ED.dirty) {
    ED.mode = it.mode_override || S.settings.mode;
    ED.adjust = JSON.parse(JSON.stringify(it.adjust || {}));
    ED.strokes = [];
    ED.editsAction = "keep";
    ED.editsLoadedFor = null;
    requestPreview();
  }
  fillInspector();
}

// ---------- filling the UI ----------
function fillInspector() {
  const it = currentItem();
  if (!it) return;
  const done = hasResult(it);
  const running = !!(S.run && S.run.running);
  const used = ED.live ? ED.live.used : (it.used_mode || ED.mode);

  $("#inName").textContent = it.name;
  const meta = [STATUS_LABEL[it.status]];
  if (it.size) meta.push(`${it.size[0]} × ${it.size[1]} px`);
  if (it.status === "done") meta.push(`${it.seconds.toFixed(1)}s`);
  if (it.note) meta.push(it.note);
  $("#inMeta").textContent = meta.join(" · ");

  $("#inSrc").textContent = shortPath(it.source, 90);
  $("#inSrc").title = it.source;
  const out = `${it.out_dir || S.settings.output_dir}/${it.out_rel}`;
  $("#inOut").textContent = shortPath(out, 90) + (it.variant_rel ? `  (+ ${it.variant_rel})` : "");
  $("#inOut").title = out;
  $("#inErr").hidden = it.status !== "failed";
  $("#inErr").textContent = it.error || "";
  $("#inRetry").hidden = it.status !== "failed";
  $("#inRetry").disabled = running;
  $("#inRevealOut").disabled = !done;
  $("#inFull").disabled = !done;
  $("#inRevealSrc").disabled = !it.source || it.source.startsWith("(dropped)");
  const ids = visibleIds();
  const idx = ids.indexOf(it.id);
  $("#inPrev").disabled = idx <= 0;
  $("#inNext").disabled = idx < 0 || idx >= ids.length - 1;

  // Stage content
  const stage = $("#stage");
  const showResult = done || !!ED.live;
  stage.classList.toggle("single", !showResult && !ED.crop);
  const msg = $("#stageMsg");
  msg.hidden = showResult || !!ED.crop;
  msg.textContent = it.status === "failed" ? "This image failed — see the error below."
    : it.status === "processing" ? "Working on it…" : "Not processed yet.";

  const before = $("#inBefore");
  let beforeSrc;
  if (ED.crop) beforeSrc = ED.crop.geoSrc;
  else if (ED.live) beforeSrc = (ED.live.orig || ED.live.frame).src;  // untoned original for "Before"
  else beforeSrc = imgUrl(it.id, "original", "&size=large");
  if (before.dataset.src !== beforeSrc) {
    before.dataset.src = beforeSrc;
    before.classList.add("loading");
    before.src = beforeSrc;
  }
  const after = $("#inAfter");
  const afterSrc = !done ? ""
    : ED.zoom > 1 ? `/api/full/${it.id}?t=${encodeURIComponent(TOKEN)}&v=${it.finished_at}`
    : imgUrl(it.id, "result", `&size=large&v=${it.finished_at}`);
  if (after.dataset.src !== afterSrc) {
    after.dataset.src = afterSrc;
    after.classList.add("loading");
    if (afterSrc) after.src = afterSrc; else after.removeAttribute("src");
  }
  $("#liveCanvas").hidden = !ED.live;
  after.hidden = !!ED.live;

  setBackdrop(ED.backdrop);
  setSplit(ED.split);
  updateZoomUI();

  // Panel
  const panelOff = it.status === "processing" || (it.status === "queued" && !ED.live);
  $$("#methodSeg button").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === ED.mode);
    b.classList.toggle("used", ED.mode === "auto" && b.dataset.mode === used);
    b.disabled = panelOff;
  });
  $("#methodNote").textContent = ED.mode === "auto"
    ? (ED.live ? `Auto picked ${MODE_NAME[used].toLowerCase()}${ED.live.why ? `: ${ED.live.why}` : ""}.` : "Auto picks a method from the scan's edges.")
    : "";

  $("#secInk").hidden = used !== "ink";
  $("#secEdge").hidden = !(used === "item" || used === "photo");
  const a = ED.adjust;
  $("#inkStrength").value = Math.round((a.ink || 0) * 100);
  $("#inkVal").textContent = `${a.ink > 0 ? "+" : ""}${Math.round((a.ink || 0) * 100)}`;
  $("#paperSw").style.background = a.paper || "transparent";
  $("#paperSw").classList.toggle("sw-trans", !a.paper);
  $("#paperAuto").disabled = !a.paper;
  $("#paperPick").classList.toggle("active", ED.picking);
  $("#edgeGrow").value = a.grow || 0;
  $("#growVal").textContent = `${a.grow > 0 ? "+" : ""}${a.grow || 0}`;
  $("#edgeSoft").value = a.soften || 0;
  $("#softVal").textContent = `${a.soften || 0}`;
  $("#fillHoles").checked = a.fill ?? (used === "item");
  $("#fringe").checked = a.fringe ?? S.settings.clean_edges;

  const angle = a.angle || 0;
  $("#straighten").value = angle;
  const turned = { 1: "turned 90° right", 2: "turned 180°", 3: "turned 90° left" }[a.rot90 || 0];
  $("#angleVal").textContent = `${angle > 0 ? "+" : ""}${angle.toFixed(1)}°${turned ? ` · ${turned}` : ""}`;
  $("#toneBright").value = Math.round((a.bright || 0) * 100);
  $("#brightVal").textContent = signed(Math.round((a.bright || 0) * 100));
  $("#toneContrast").value = Math.round((a.contrast || 0) * 100);
  $("#contrastVal").textContent = signed(Math.round((a.contrast || 0) * 100));
  $("#toneSat").value = Math.round((a.sat || 0) * 100);
  $("#satVal").textContent = signed(Math.round((a.sat || 0) * 100));
  $("#autoTone").checked = !!a.autotone;
  $("#toneReset").disabled = !(a.bright || a.contrast || a.sat || a.autotone);
  $("#rectLockRow").hidden = !ED.crop;
  $("#rectLock").checked = ED.rectLock;
  $("#gridToggle").classList.toggle("active", ED.grid);
  $("#gridToggle").setAttribute("aria-pressed", ED.grid);
  $("#pasteSettings").disabled = !readClipboard();
  $("#pasteSettings").title = readClipboard() ? `Apply copied settings: ${describeSettings(readClipboard())} (⌘⇧V)` : "Copy settings from another image first";

  const cropQuad = a.crop || (ED.live && ED.live.quad);
  $("#cropNote").textContent = ED.crop ? "Drag the four corners onto the card's corners. The result is straightened to a rectangle."
    : isIdentity(a.crop) ? "No cropping (automatic trimming is off for this image)."
    : a.crop ? "Cropped by hand."
    : cropQuad ? "Scanner edges trimmed automatically."
    : "Trim scanner edges and straighten a tilted card.";
  $("#cropButtons").hidden = !!ED.crop;
  $("#cropTools").hidden = !ED.crop;
  $("#cropReset").disabled = isIdentity(a.crop) || (!a.crop && !(ED.live && ED.live.quad));

  $$("#toolSeg button").forEach((b) => b.classList.toggle("active", b.dataset.tool === ED.tool));
  $("#brushSize").value = ED.brush;
  $("#brushVal").textContent = `${ED.brush}px`;
  $("#brushUndo").disabled = !ED.strokes.length;
  $("#brushClear").disabled = !ED.strokes.length && !ED.baseKeep && !(it.has_edits && ED.editsAction === "keep");

  const editButtons = "#editPanel #toolSeg button, #editPanel #cropButtons button, #paperPick, #paperAuto, #rotLeft, #rotRight, #autoStraighten, #angleZero, #toneReset, #copySettings, #pasteSettings";
  $$(`#editPanel input, ${editButtons}`).forEach((x) => { if (panelOff) x.disabled = true; });
  if (!panelOff) {
    $$("#editPanel input").forEach((x) => (x.disabled = false));
    $$("#toolSeg button, #cropEdit, #paperPick, #rotLeft, #rotRight, #autoStraighten, #angleZero, #copySettings").forEach((x) => (x.disabled = false));
  }
  $("#saveEdits").disabled = panelOff || !ED.dirty;
  $("#saveNext").disabled = panelOff || (!ED.dirty && $("#inNext").disabled);
  $("#saveNext").textContent = ED.dirty ? "Save & next →" : "Next →";
  $("#resetAuto").disabled = panelOff || (!it.mode_override && !Object.keys(it.adjust || {}).length && !it.has_edits && !ED.dirty);
  $("#dirtyNote").textContent = ED.dirty ? "Unsaved changes" : "";
  $("#stageBusy").hidden = !ED.busy;
  drawGrid();
}

// ---------- stage geometry ----------
function layoutStage() {
  const wrap = $("#stageWrap");
  const W = wrap.clientWidth - 32, H = wrap.clientHeight - 32;
  if (W <= 0 || H <= 0) return;
  const fitW = Math.min(W, H * ED.ar);
  const w = fitW * ED.zoom;
  $("#stage").style.width = `${Math.round(w)}px`;
  $("#stage").style.height = `${Math.round(w / ED.ar)}px`;
  if (ED.crop) drawCrop();
}

// ---------- zoom & pan ----------
const MAX_ZOOM = 8;

// Zoom to z (1 = fit), keeping the point under `anchor` (a mouse event or {clientX, clientY})
// in the same place on screen. Without an anchor, zoom around the centre of the view.
function setZoom(z, anchor) {
  const wrap = $("#stageWrap"), stage = $("#stage");
  z = Math.max(1, Math.min(MAX_ZOOM, z));
  if (Math.abs(z - 1) < 0.03) z = 1;  // snap back to Fit
  if (Math.abs(z - ED.zoom) < 1e-3) return;
  const wr = wrap.getBoundingClientRect();
  const ax = anchor ? anchor.clientX : wr.left + wr.width / 2;
  const ay = anchor ? anchor.clientY : wr.top + wr.height / 2;
  const before = stage.getBoundingClientRect();
  const fx = Math.max(0, Math.min(1, (ax - before.left) / before.width));
  const fy = Math.max(0, Math.min(1, (ay - before.top) / before.height));
  const crossed = (ED.zoom > 1) !== (z > 1);
  ED.zoom = z;
  layoutStage();
  const after = stage.getBoundingClientRect();
  wrap.scrollLeft += after.left + fx * after.width - ax;
  wrap.scrollTop += after.top + fy * after.height - ay;
  if (crossed) fillInspector(); else updateZoomUI();
}

function updateZoomUI() {
  $$("#zoomSeg button").forEach((b) => b.classList.toggle("active", Math.abs(Number(b.dataset.zoom) - ED.zoom) < 0.01));
  $("#zoomLevel").textContent = ED.zoom === 1 ? "Fit" : `×${ED.zoom.toFixed(ED.zoom < 2 ? 2 : 1).replace(/\.?0+$/, "")}`;
}

function showZoomHint() {
  if (lsGet("bgs-zoom-hint") === "seen") return;
  lsSet("bgs-zoom-hint", "seen");
  const hint = $("#zoomHint");
  hint.hidden = false;
  setTimeout(() => { hint.hidden = true; }, 6000);
}

function setSplit(pct) {
  ED.split = Math.max(0, Math.min(100, pct));
  $("#afterLayer").style.clipPath = `inset(0 0 0 ${ED.split}%)`;
  $("#handle").style.left = `${ED.split}%`;
}

function setBackdrop(bd) {
  ED.backdrop = bd;
  const layer = $("#afterLayer");
  layer.classList.remove("bd-checker", "bd-white", "bd-black");
  layer.style.background = "";
  if (bd === "custom") layer.style.background = S.settings ? S.settings.custom_color : "#888";
  else layer.classList.add(`bd-${bd}`);
  $$("#backdropSeg button").forEach((b) => b.classList.toggle("active", b.dataset.bd === bd));
}

function stagePoint(e) {
  const r = $("#stage").getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, r };
}

// ---------- live preview ----------
function loadImage(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error("Could not read the preview"));
    im.src = src;
  });
}

function markDirty() {
  ED.dirty = true;
  fillInspector();
}

function schedulePreview(delay = 220) {
  clearTimeout(ED.timer);
  ED.timer = setTimeout(requestPreview, delay);
}

async function requestPreview() {
  const id = ED.id;
  if (!id) return;
  const seq = ++ED.seq;
  ED.busy = true;
  const it = currentItem();
  $("#busyText").textContent = ED.live ? "Updating preview…"
    : (it && ["item", "photo", "auto"].includes(ED.mode) ? "Preparing editor (first time may take a few seconds)…" : "Preparing editor…");
  fillInspector();
  try {
    const r = await api("/api/preview", { id, mode: ED.mode, adjust: ED.adjust });
    const [cut, frame, orig] = await Promise.all([loadImage(r.cut), loadImage(r.frame), r.orig ? loadImage(r.orig) : null]);
    if (seq !== ED.seq || id !== ED.id) return; // a newer request is on its way
    const sizeChanged = !ED.live || ED.live.w !== r.width || ED.live.h !== r.height;
    ED.live = { cut, frame, orig, w: r.width, h: r.height, used: r.used, why: r.why, quad: r.quad };
    if (sizeChanged) resizeLayers();
    const canvas = $("#liveCanvas");
    canvas.width = r.width;
    canvas.height = r.height;
    ED.ar = r.width / r.height;
    await loadSavedEdits();
    renderLive();
    layoutStage();
  } catch (e) {
    if (seq === ED.seq) toast(e.message, "error", 7000);
  } finally {
    if (seq === ED.seq) {
      ED.busy = false;
      fillInspector();
    }
  }
}

// Composite: cut-out + (original where "keep" is painted) − (where "erase" is painted).
function renderLive() {
  if (!ED.live) return;
  const { w, h, cut, frame } = ED.live;
  const ctx = $("#liveCanvas").getContext("2d");
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(cut, 0, 0, w, h);
  if (ED.keep) {
    const tmp = scratchCanvas(w, h);
    const t = tmp.getContext("2d");
    t.globalCompositeOperation = "source-over";
    t.clearRect(0, 0, w, h);
    t.drawImage(frame, 0, 0, w, h);
    t.globalCompositeOperation = "destination-in";
    t.drawImage(ED.keep, 0, 0);
    ctx.drawImage(tmp, 0, 0);
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(ED.erase, 0, 0);
    ctx.globalCompositeOperation = "source-over";
  }
}

let _scratch = null;
function scratchCanvas(w, h) {
  if (!_scratch) _scratch = document.createElement("canvas");
  if (_scratch.width !== w || _scratch.height !== h) { _scratch.width = w; _scratch.height = h; }
  return _scratch;
}

// ---------- brush layers ----------
function newLayer(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function resizeLayers() {
  const { w, h } = ED.live;
  // A different frame size means the crop changed: earlier strokes no longer line up.
  if (ED.keep && (ED.strokes.length || ED.baseKeep) && (ED.keep.width !== w || ED.keep.height !== h)) {
    toast("Touch-ups were cleared because the crop changed.");
    ED.strokes = [];
    ED.baseKeep = ED.baseErase = null;
    ED.editsAction = "clear";
  }
  ED.keep = newLayer(w, h);
  ED.erase = newLayer(w, h);
  redrawLayers();
}

async function loadSavedEdits() {
  const it = currentItem();
  if (!it || !it.has_edits || ED.editsAction !== "keep" || ED.editsLoadedFor === it.id + it.finished_at) return;
  ED.editsLoadedFor = it.id + it.finished_at;
  try {
    const im = await loadImage(`/api/edits/${it.id}?t=${encodeURIComponent(TOKEN)}&v=${it.finished_at}`);
    const { w, h } = ED.live;
    const src = newLayer(w, h);
    const sctx = src.getContext("2d");
    sctx.drawImage(im, 0, 0, w, h);
    const px = sctx.getImageData(0, 0, w, h);
    const keep = new ImageData(w, h), erase = new ImageData(w, h);
    for (let i = 0; i < px.data.length; i += 4) {
      keep.data[i] = keep.data[i + 1] = keep.data[i + 2] = 255;
      erase.data[i] = erase.data[i + 1] = erase.data[i + 2] = 255;
      keep.data[i + 3] = px.data[i];
      erase.data[i + 3] = px.data[i + 1];
    }
    ED.baseKeep = newLayer(w, h);
    ED.baseKeep.getContext("2d").putImageData(keep, 0, 0);
    ED.baseErase = newLayer(w, h);
    ED.baseErase.getContext("2d").putImageData(erase, 0, 0);
    redrawLayers();
  } catch { /* no saved edits */ }
}

function redrawLayers() {
  if (!ED.keep) return;
  const k = ED.keep.getContext("2d"), e = ED.erase.getContext("2d");
  k.globalCompositeOperation = e.globalCompositeOperation = "source-over";
  k.clearRect(0, 0, ED.keep.width, ED.keep.height);
  e.clearRect(0, 0, ED.erase.width, ED.erase.height);
  if (ED.baseKeep) {
    k.drawImage(ED.baseKeep, 0, 0);
    e.drawImage(ED.baseErase, 0, 0);
  }
  for (const s of ED.strokes) paintStroke(s, 0);
}

// Paint a stroke (from point index `from`) on its layer and remove it from the other one,
// so the most recent stroke always wins.
function paintStroke(s, from) {
  const pts = s.points;
  const layers = s.tool === "keep" ? [ED.keep, ED.erase] : [ED.erase, ED.keep];
  layers.forEach((layer, i) => {
    const c = layer.getContext("2d");
    c.globalCompositeOperation = i === 0 ? "source-over" : "destination-out";
    c.strokeStyle = c.fillStyle = "#fff";
    c.lineCap = c.lineJoin = "round";
    c.lineWidth = s.size;
    c.beginPath();
    const start = Math.max(0, from - 1);
    c.moveTo(pts[start][0], pts[start][1]);
    for (let j = start; j < pts.length; j++) c.lineTo(pts[j][0], pts[j][1]);
    if (pts.length === 1) {
      c.arc(pts[0][0], pts[0][1], s.size / 2, 0, Math.PI * 2);
      c.fill();
    } else c.stroke();
    c.globalCompositeOperation = "source-over";
  });
}

function exportEdits() {
  // Red = keep, green = erase, as the server expects.
  const { w, h } = ED.live;
  const k = ED.keep.getContext("2d").getImageData(0, 0, w, h).data;
  const e = ED.erase.getContext("2d").getImageData(0, 0, w, h).data;
  const out = new ImageData(w, h);
  let any = false;
  for (let i = 0; i < k.length; i += 4) {
    out.data[i] = k[i + 3];
    out.data[i + 1] = e[i + 3];
    out.data[i + 2] = 0;
    out.data[i + 3] = 255;
    if (k[i + 3] || e[i + 3]) any = true;
  }
  if (!any) return null;
  const c = newLayer(w, h);
  c.getContext("2d").putImageData(out, 0, 0);
  return c.toDataURL("image/png");
}

function setTool(tool) {
  ED.tool = tool;
  const stage = $("#stage");
  stage.classList.toggle("brushing", tool !== "view");
  $("#brushCursor").hidden = true;
  $("#brushCursor").className = `brush-cursor ${tool}`;
  $$("#toolSeg button").forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
}

function updateCursor(e) {
  const cur = $("#brushCursor");
  if (ED.tool === "view" || !ED.live) { cur.hidden = true; return; }
  const { x, y, r } = stagePoint(e);
  cur.hidden = x < 0 || y < 0 || x > 1 || y > 1;
  cur.style.left = `${x * 100}%`;
  cur.style.top = `${y * 100}%`;
  const px = ED.brush * (r.width / ED.live.w);
  cur.style.width = cur.style.height = `${px}px`;
}

// ---------- crop ----------
async function startCrop() {
  const it = currentItem();
  if (!it || ED.crop) return;
  ED.busy = true;
  $("#busyText").textContent = "Preparing crop…";
  fillInspector();
  let r;
  try {
    // Show the image as rotated/straightened but not cropped: corners are placed in that frame.
    const adjust = JSON.parse(JSON.stringify(ED.adjust));
    delete adjust.crop;
    r = await api("/api/preview", { id: it.id, mode: "keep", adjust, geometry_only: true });
  } catch (e) {
    toast(e.message, "error", 7000);
    return;
  } finally {
    ED.busy = false;
  }
  let quad = JSON.parse(JSON.stringify(ED.adjust.crop || (ED.live && ED.live.quad) || IDENTITY_QUAD));
  if (ED.rectLock) quad = toRect(quad);
  ED.crop = { quad, geoSrc: r.frame, ar: r.width / r.height };
  ED.ar = ED.crop.ar;
  setTool("view");
  $("#stage").classList.add("cropping");
  showSvg("#cropSvg", true);
  $$(".crop-handle").forEach((h) => (h.hidden = false));
  fillInspector();
  layoutStage();
  drawCrop();
}

function endCrop(apply) {
  if (!ED.crop) return;
  const q = ED.crop.quad;
  ED.crop = null;
  $("#stage").classList.remove("cropping");
  showSvg("#cropSvg", false);
  $$(".crop-handle").forEach((h) => (h.hidden = true));
  if (ED.live) ED.ar = ED.live.w / ED.live.h;
  drawGrid();
  if (apply) {
    // A full-frame quad is kept explicitly: it means "don't trim this image automatically".
    const next = isIdentity(q) ? IDENTITY_QUAD.map((p) => p.slice()) : q.map(([x, y]) => [+x.toFixed(5), +y.toFixed(5)]);
    if (!deepEqual(next, ED.adjust.crop || null)) {
      ED.adjust.crop = next;
      markDirty();
      requestPreview();
      layoutStage();
      return;
    }
  }
  fillInspector();
  layoutStage();
}

function drawCrop() {
  if (!ED.crop) return;
  const q = ED.crop.quad;
  const pts = q.map(([x, y]) => `${x * 1000},${y * 1000}`).join(" ");
  $("#cropPoly").setAttribute("points", pts);
  $("#cropShade").setAttribute("d", `M0,0 H1000 V1000 H0 Z M${q.map(([x, y]) => `${x * 1000},${y * 1000}`).join(" L")} Z`);
  $$(".crop-handle").forEach((h) => {
    const [x, y] = q[Number(h.dataset.i)];
    h.style.left = `${x * 100}%`;
    h.style.top = `${y * 100}%`;
  });
  drawGrid();
}

// Drag corner i to (x, y). With the 90° lock the opposite corner stays put and the crop stays a rectangle.
function moveCorner(i, x, y) {
  const q = ED.crop.quad;
  x = Math.max(0, Math.min(1, x));
  y = Math.max(0, Math.min(1, y));
  if (!ED.rectLock) {
    q[i] = [x, y];
    return;
  }
  const [ox, oy] = q[(i + 2) % 4];
  const gap = 0.02;
  const left = i === 0 || i === 3, top = i === 0 || i === 1;
  x = left ? Math.min(x, ox - gap) : Math.max(x, ox + gap);
  y = top ? Math.min(y, oy - gap) : Math.max(y, oy + gap);
  const x0 = Math.min(x, ox), x1 = Math.max(x, ox), y0 = Math.min(y, oy), y1 = Math.max(y, oy);
  ED.crop.quad = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

// ---------- saving ----------
async function saveEdits() {
  const it = currentItem();
  if (!it) return;
  let edits = null, action = ED.editsAction;
  if (ED.strokes.length || (ED.editsAction === "keep" && ED.baseKeep && ED.live)) {
    if (ED.strokes.length) {
      edits = exportEdits();
      action = edits ? "replace" : "clear";
    }
  }
  const adjust = JSON.parse(JSON.stringify(ED.adjust));
  let ok = false;
  await act(async () => {
    await api("/api/adjust", { id: it.id, mode: ED.mode, adjust, edits, edits_action: action });
    ED.dirty = false;
    ED.strokes = [];
    ED.editsAction = "keep";
    summaryDismissed = null;
    S.version = null;
    ok = true;
  });
  fillInspector();
  return ok;
}

async function saveAndNext() {
  if (ED.crop) endCrop(true);
  if (ED.dirty && !(await saveEdits())) return;
  if ($("#inNext").disabled) { toast("Saved. That was the last image in this view."); return; }
  stepInspector(1);
}

function copySettings() {
  const adjust = JSON.parse(JSON.stringify(ED.adjust));
  delete adjust.crop;  // crops belong to one image
  const clip = { mode: ED.mode, adjust };
  lsSet("bgs-clipboard", JSON.stringify(clip));
  toast(`Copied: ${describeSettings(clip)}`);
  fillInspector();
}

function pasteSettings() {
  const clip = readClipboard();
  if (!clip) return;
  const crop = ED.adjust.crop;
  const sameGeometry = (ED.adjust.rot90 || 0) === (clip.adjust.rot90 || 0) && (ED.adjust.angle || 0) === (clip.adjust.angle || 0);
  ED.mode = clip.mode;
  ED.adjust = JSON.parse(JSON.stringify(clip.adjust));
  if (crop) ED.adjust.crop = crop;
  if (!sameGeometry) geometryChanged();
  markDirty();
  requestPreview();
  toast("Pasted. Check the preview, then Save.");
}

async function resetToAutomatic() {
  const it = currentItem();
  if (!it) return;
  if (!confirm("Forget this image's manual changes (method, sliders, crop and touch-ups) and process it automatically?")) return;
  await act(async () => {
    await api("/api/adjust", { id: it.id, mode: S.settings.mode, adjust: {}, edits: null, edits_action: "clear" });
    ED.dirty = false;
    ED.mode = S.settings.mode;
    ED.adjust = {};
    ED.strokes = [];
    ED.baseKeep = ED.baseErase = null;
    ED.editsAction = "keep";
    S.version = null;
  });
  fillInspector();
}

// ---------- wiring ----------
function wireEditor() {
  const dlg = $("#inspector");
  $("#inClose").addEventListener("click", closeInspector);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); if (ED.crop) endCrop(false); else closeInspector(); });
  dlg.addEventListener("click", (e) => { if (e.target === dlg) closeInspector(); });
  $("#inPrev").addEventListener("click", () => stepInspector(-1));
  $("#inNext").addEventListener("click", () => stepInspector(1));
  dlg.addEventListener("keydown", (e) => {
    if (e.target.matches("input[type=text], input[type=number]")) return;
    const k = e.key.toLowerCase();
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === " ") {  // hold Space to pan (and don't "click" a focused button)
      e.preventDefault();
      if (!ED.spaceDown) { ED.spaceDown = true; $("#stageWrap").classList.add("pan-ready"); }
      return;
    }
    if (mod && (e.key === "=" || e.key === "+")) { e.preventDefault(); setZoom(ED.zoom * 1.25); return; }
    if (mod && e.key === "-") { e.preventDefault(); setZoom(ED.zoom / 1.25); return; }
    if (mod && e.key === "0") { e.preventDefault(); setZoom(1); return; }
    if (mod && k === "z") { e.preventDefault(); $("#brushUndo").click(); return; }
    if (mod && k === "s") { e.preventDefault(); if (!$("#saveEdits").disabled) saveEdits(); return; }
    if (mod && e.key === "Enter") { e.preventDefault(); if (!$("#saveNext").disabled) saveAndNext(); return; }
    if (mod && e.shiftKey && k === "c") { e.preventDefault(); copySettings(); return; }
    if (mod && e.shiftKey && k === "v") { e.preventDefault(); if (!$("#pasteSettings").disabled) pasteSettings(); return; }
    if (mod || e.altKey) return;
    if (e.target.matches("input[type=range]") && (e.key.startsWith("Arrow"))) return;
    if (k === "g") { $("#gridToggle").click(); return; }
    if (k === "r" && !ED.crop) { (e.shiftKey ? $("#rotLeft") : $("#rotRight")).click(); return; }
    if (e.key === "ArrowLeft") { e.preventDefault(); stepInspector(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); stepInspector(1); }
    else if (k === "k" || k === "e" || k === "v") { if (!ED.crop) chooseTool({ k: "keep", e: "erase", v: "view" }[k]); }
    else if (e.key === "[" || e.key === "]") {
      ED.brush = Math.max(4, Math.min(200, ED.brush + (e.key === "]" ? 6 : -6)));
      fillInspector();
    }
  });

  $$("#backdropSeg button").forEach((b) => b.addEventListener("click", () => setBackdrop(b.dataset.bd)));
  $$("#zoomSeg button").forEach((b) => b.addEventListener("click", () => setZoom(Number(b.dataset.zoom))));

  // Zoom: pinch on a trackpad (sent as ctrl+wheel) or ⌘/Ctrl + scroll wheel, towards the cursor.
  // Plain scrolling (two fingers, or the wheel) pans the zoomed image natively.
  const wrap = $("#stageWrap");
  wrap.addEventListener("wheel", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const delta = Math.max(-60, Math.min(60, e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY));
    setZoom(ED.zoom * Math.exp(-delta * 0.01), e);
  }, { passive: false });

  // Pan: hold Space and drag, or drag with the middle mouse button (works with every tool).
  let pan = null;
  const startPan = (e) => {
    e.preventDefault();
    pan = { x: e.clientX, y: e.clientY, left: wrap.scrollLeft, top: wrap.scrollTop, id: e.pointerId };
    wrap.setPointerCapture(e.pointerId);
    wrap.classList.add("panning");
  };
  wrap.addEventListener("pointerdown", (e) => {
    if (ED.spaceDown || e.button === 1) { e.stopPropagation(); startPan(e); }
  }, true);  // capture phase: runs before the brush, compare slider and crop handles
  wrap.addEventListener("pointermove", (e) => {
    if (!pan) return;
    wrap.scrollLeft = pan.left - (e.clientX - pan.x);
    wrap.scrollTop = pan.top - (e.clientY - pan.y);
  });
  const endPan = () => { pan = null; wrap.classList.remove("panning"); };
  wrap.addEventListener("pointerup", endPan);
  wrap.addEventListener("pointercancel", endPan);
  wrap.addEventListener("auxclick", (e) => { if (e.button === 1) e.preventDefault(); });
  const setSpace = (down) => {
    ED.spaceDown = down;
    wrap.classList.toggle("pan-ready", down);
    if (!down) endPan();
  };
  dlg.addEventListener("keyup", (e) => {
    if (e.key === " " && !e.target.matches("input[type=text]")) { e.preventDefault(); setSpace(false); }
  });
  window.addEventListener("blur", () => setSpace(false));

  // Double-click with the compare tool: jump between Fit and 2.5× at that spot.
  $("#stage").addEventListener("dblclick", (e) => {
    if (ED.tool !== "view" || ED.crop || ED.picking) return;
    setZoom(ED.zoom > 1 ? 1 : 2.5, e);
  });
  for (const q of ["#inBefore", "#inAfter"]) {
    $(q).addEventListener("load", (e) => e.target.classList.remove("loading"));
  }
  $("#inBefore").addEventListener("load", (e) => {
    const im = e.target;
    if (!ED.live && !ED.crop && im.naturalWidth) {
      const ar = im.naturalWidth / im.naturalHeight;
      if (Math.abs(ar - ED.ar) > 0.01) { ED.ar = ar; layoutStage(); }
    }
  });
  window.addEventListener("resize", () => { if (dlg.open) layoutStage(); });

  // Method
  $$("#methodSeg button").forEach((b) => b.addEventListener("click", () => {
    if (ED.mode === b.dataset.mode) return;
    ED.mode = b.dataset.mode;
    markDirty();
    requestPreview();
  }));

  // Sliders & toggles
  const setAdj = (key, value, isDefault) => {
    if (isDefault) delete ED.adjust[key]; else ED.adjust[key] = value;
    markDirty();
    schedulePreview();
  };
  $("#inkStrength").addEventListener("input", (e) => setAdj("ink", Number(e.target.value) / 100, Number(e.target.value) === 0));
  $("#edgeGrow").addEventListener("input", (e) => setAdj("grow", Number(e.target.value), Number(e.target.value) === 0));
  $("#edgeSoft").addEventListener("input", (e) => setAdj("soften", Number(e.target.value), Number(e.target.value) === 0));
  $("#fillHoles").addEventListener("change", (e) => setAdj("fill", e.target.checked, false));
  $("#fringe").addEventListener("change", (e) => setAdj("fringe", e.target.checked, false));
  $("#paperAuto").addEventListener("click", () => setAdj("paper", null, true));
  $("#paperPick").addEventListener("click", () => {
    if (!ED.live) { toast("Wait for the preview to load, then pick the paper colour."); return; }
    ED.picking = !ED.picking;
    $("#stage").classList.toggle("picking", ED.picking);
    if (ED.picking) { setTool("view"); toast("Click on a bit of bare paper in the image."); }
    fillInspector();
  });

  // Crop
  $("#cropEdit").addEventListener("click", startCrop);
  $("#cropReset").addEventListener("click", () => {
    // "No crop": an explicit full-frame crop also stops Auto/Card from trimming automatically.
    ED.adjust.crop = IDENTITY_QUAD.map((p) => p.slice());
    markDirty();
    requestPreview();
  });
  $("#cropCancel").addEventListener("click", () => endCrop(false));
  $("#cropDone").addEventListener("click", () => endCrop(true));
  $("#cropFull").addEventListener("click", () => { ED.crop.quad = IDENTITY_QUAD.map((p) => p.slice()); drawCrop(); });
  $("#cropAuto").addEventListener("click", () => act(async () => {
    const adjust = JSON.parse(JSON.stringify(ED.adjust));
    delete adjust.crop;
    const r = await api("/api/detect-crop", { id: ED.id, adjust });
    if (ED.crop) { ED.crop.quad = ED.rectLock ? toRect(r.quad) : r.quad; drawCrop(); }
    if (isIdentity(r.quad)) toast("No scanner edges found. Drag the corners yourself.");
  }));
  $("#rectLock").addEventListener("change", (e) => {
    ED.rectLock = e.target.checked;
    lsSet("bgs-rect-lock", ED.rectLock ? "1" : "0");
    if (ED.crop && ED.rectLock) { ED.crop.quad = toRect(ED.crop.quad); drawCrop(); }
  });

  // Rotation
  $("#rotLeft").addEventListener("click", () => setGeometry((ED.adjust.rot90 || 0) + 3, ED.adjust.angle || 0, 0));
  $("#rotRight").addEventListener("click", () => setGeometry((ED.adjust.rot90 || 0) + 1, ED.adjust.angle || 0, 0));
  $("#straighten").addEventListener("input", (e) => {
    flashGrid();
    setGeometry(ED.adjust.rot90 || 0, Number(e.target.value), 300);
  });
  $("#angleZero").addEventListener("click", () => setGeometry(ED.adjust.rot90 || 0, 0, 0));
  $("#autoStraighten").addEventListener("click", () => act(async () => {
    const r = await api("/api/straighten", { id: ED.id, adjust: { rot90: ED.adjust.rot90 || 0 } });
    if (Math.abs(r.angle) < 0.05 && !ED.adjust.angle) { toast("This image already looks straight."); return; }
    setGeometry(ED.adjust.rot90 || 0, r.angle, 0);
    flashGrid();
    toast(`Straightened by ${signed(r.angle)}°. Fine-tune with the slider if needed.`);
  }));

  // Tone
  const tone = (key, el) => $(el).addEventListener("input", (e) => setAdj(key, Number(e.target.value) / 100, Number(e.target.value) === 0));
  tone("bright", "#toneBright");
  tone("contrast", "#toneContrast");
  tone("sat", "#toneSat");
  $("#autoTone").addEventListener("change", (e) => setAdj("autotone", true, !e.target.checked));
  $("#toneReset").addEventListener("click", () => {
    for (const k of ["bright", "contrast", "sat", "autotone"]) delete ED.adjust[k];
    markDirty();
    schedulePreview(0);
  });

  // Grid, copy/paste, save & next
  $("#gridToggle").addEventListener("click", () => {
    ED.grid = !ED.grid;
    lsSet("bgs-grid", ED.grid ? "1" : "0");
    drawGrid();
    fillInspector();
  });
  $("#copySettings").addEventListener("click", copySettings);
  $("#pasteSettings").addEventListener("click", pasteSettings);
  $("#saveNext").addEventListener("click", saveAndNext);
  $$(".crop-handle").forEach((h) => {
    h.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      h.setPointerCapture(e.pointerId);
      const i = Number(h.dataset.i);
      const move = (ev) => {
        const { x, y } = stagePoint(ev);
        moveCorner(i, x, y);
        drawCrop();
      };
      h.onpointermove = move;
      h.onpointerup = h.onpointercancel = () => { h.onpointermove = null; };
    });
  });

  // Brush
  const chooseTool = (tool) => {
    if (tool !== "view" && !ED.live) { toast("Wait for the preview to load first."); return; }
    ED.picking = false;
    $("#stage").classList.remove("picking");
    setTool(tool);
    fillInspector();
  };
  window.chooseTool = chooseTool;
  $$("#toolSeg button").forEach((b) => b.addEventListener("click", () => chooseTool(b.dataset.tool)));
  $("#brushSize").addEventListener("input", (e) => { ED.brush = Number(e.target.value); $("#brushVal").textContent = `${ED.brush}px`; });
  $("#brushUndo").addEventListener("click", () => {
    if (!ED.strokes.length) return;
    ED.strokes.pop();
    redrawLayers();
    renderLive();
    ED.dirty = true;
    fillInspector();
  });
  $("#brushClear").addEventListener("click", () => {
    ED.strokes = [];
    ED.baseKeep = ED.baseErase = null;
    ED.editsAction = "clear";
    redrawLayers();
    renderLive();
    markDirty();
  });

  // Stage pointer handling: compare slider, brush, paper picker.
  const stage = $("#stage");
  let mode = null;
  stage.addEventListener("pointerdown", (e) => {
    if (ED.crop || stage.classList.contains("single")) return;
    if (ED.picking && ED.live) {
      const { x, y } = stagePoint(e);
      const c = scratchCanvas(ED.live.w, ED.live.h).getContext("2d");
      c.globalCompositeOperation = "source-over";
      c.drawImage(ED.live.frame, 0, 0, ED.live.w, ED.live.h);
      const px = c.getImageData(Math.floor(x * ED.live.w), Math.floor(y * ED.live.h), 1, 1).data;
      const hex = "#" + [px[0], px[1], px[2]].map((v) => v.toString(16).padStart(2, "0")).join("");
      ED.picking = false;
      stage.classList.remove("picking");
      ED.adjust.paper = hex;
      markDirty();
      requestPreview();
      return;
    }
    stage.setPointerCapture(e.pointerId);
    if (ED.tool !== "view" && ED.live) {
      mode = "brush";
      const { x, y } = stagePoint(e);
      // Brush size is in preview pixels, so strokes stay put when zooming.
      ED.stroke = { tool: ED.tool, size: ED.brush, points: [[x * ED.live.w, y * ED.live.h]] };
      ED.strokes.push(ED.stroke);
      paintStroke(ED.stroke, 0);
      renderLive();
    } else {
      mode = "split";
      setSplit(stagePoint(e).x * 100);
    }
  });
  stage.addEventListener("pointermove", (e) => {
    updateCursor(e);
    if (mode === "split") setSplit(stagePoint(e).x * 100);
    else if (mode === "brush" && ED.stroke) {
      const { x, y } = stagePoint(e);
      ED.stroke.points.push([x * ED.live.w, y * ED.live.h]);
      paintStroke(ED.stroke, ED.stroke.points.length - 1);
      renderLive();
    }
  });
  const endPointer = () => {
    if (mode === "brush") { ED.stroke = null; markDirty(); }
    mode = null;
  };
  stage.addEventListener("pointerup", endPointer);
  stage.addEventListener("pointercancel", endPointer);
  stage.addEventListener("pointerleave", () => { $("#brushCursor").hidden = true; });

  // Footer buttons
  $("#saveEdits").addEventListener("click", saveEdits);
  $("#resetAuto").addEventListener("click", resetToAutomatic);
  $("#inRevealSrc").addEventListener("click", () => act(() => api("/api/reveal", { id: ED.id, which: "original" })));
  $("#inRevealOut").addEventListener("click", () => act(() => api("/api/reveal", { id: ED.id, which: "result" })));
  $("#inFull").addEventListener("click", () => {
    const it = currentItem();
    window.open(`/api/full/${ED.id}?t=${encodeURIComponent(TOKEN)}&v=${it ? it.finished_at : 0}`, "_blank", "noopener");
  });
  $("#inRetry").addEventListener("click", () => act(async () => {
    summaryDismissed = null;
    await api("/api/start", { ids: [ED.id] });
    S.version = null;
  }));
}

wireEditor();
