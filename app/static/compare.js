"use strict";
// Compare & merge: what's the same and what's different across folders. Talks only to the local server.

const TOKEN = document.querySelector('meta[name="studio-token"]').content;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const LETTERS = "ABCDEFGH";
const FOLDER_COLOURS = ["#3b82f6", "#f59e0b", "#22c55e", "#a855f7", "#ef4444", "#14b8a6", "#ec4899", "#64748b"];
const KIND = {
  exact: { label: "Exact duplicate", plural: "Exact duplicates", blurb: "Byte-for-byte the same file. One copy is kept." },
  same: { label: "Same picture", plural: "Same picture, different file", blurb: "Look identical, but the files differ (re-saved, resized, converted). The best one is kept." },
  versions: { label: "Versions", plural: "Versions", blurb: "The same subject, edited: cropped, cut out, rotated or recoloured. All are kept unless you untick one." },
};

const C = {
  step: 1, folders: [], version: null, data: null, limit: 120, backdrop: "checker", polling: null,
  region: null,   // which part of the diagram is selected: "0,1" = in A and B, "0" = only in A, or "conflicts"
  kind: null,     // optionally just one kind of match within it
  hover: null,
};
try { C.backdrop = localStorage.getItem("bgs-cmp-backdrop") || "checker"; } catch { /* private mode */ }

// ---------- helpers ----------
async function api(path, body) {
  const opt = { method: body === undefined ? "GET" : "POST", headers: { "X-Studio-Token": TOKEN } };
  if (body !== undefined) {
    opt.headers["Content-Type"] = "application/json";
    opt.body = JSON.stringify(body);
  }
  let r;
  try {
    r = await fetch(path, opt);
  } catch {
    $("#lostBanner").hidden = false;
    throw new Error("Background Studio isn't running.");
  }
  let data = null;
  try { data = await r.json(); } catch { /* not JSON */ }
  if (!r.ok) throw new Error((data && data.error) || `Request failed (${r.status})`);
  return data;
}
function toast(msg, kind = "info", ms = 4200) {
  const e = el("div", `toast ${kind}`, msg);
  $("#toasts").append(e);
  setTimeout(() => e.remove(), ms);
  return e;
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
const plural = (n, word, many) => `${n.toLocaleString()} ${n === 1 ? word : many || `${word}s`}`;
const tilde = (p) => p.replace(/^\/Users\/[^/]+/, "~");
const folderName = (p) => p.split("/").filter(Boolean).pop() || p;
const thumbUrl = (fid, size = "thumb") => `/api/compare/image/${fid}?size=${size}&t=${encodeURIComponent(TOKEN)}`;
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}
const fmtDate = (t) => new Date(t * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
function letterBadge(i) {
  const b = el("span", "folder-letter", LETTERS[i] || "?");
  b.style.setProperty("--c", FOLDER_COLOURS[i % FOLDER_COLOURS.length]);
  b.title = C.folders[i] ? tilde(C.folders[i]) : "";
  return b;
}

// ---------- Finder dialogs (one at a time) ----------
let dialogOpen = false;
async function withDialog(fn, which) {
  if (dialogOpen) { toast("A Finder window is already open. It may be behind your browser."); return null; }
  dialogOpen = true;
  const btns = $$("[data-picker]");
  for (const b of btns) { b.dataset.label = b.textContent; b.disabled = true; }
  if (which) $(which).textContent = "Opening Finder…";
  try {
    const r = await fn();
    if (r && r.busy) { toast("A Finder window is already open. It may be behind your browser."); return null; }
    return r;
  } finally {
    for (const b of btns) { b.disabled = false; if (b.dataset.label) b.textContent = b.dataset.label; }
    dialogOpen = false;
  }
}

// ---------- state & polling ----------
const done = () => C.data && C.data.job && C.data.job.phase === "done";
async function poll() {
  clearTimeout(C.polling);
  try {
    const d = await api(`/api/compare/state?v=${C.version ?? ""}`);
    if (!d.unchanged) {
      C.version = d.version;
      C.data = d;
      C.folders = d.folders;
      if (d.summary && (!C.region || (C.region !== "conflicts" && !regions().has(C.region)))) C.region = firstRegion();
      render();
    }
  } catch { /* banner shows */ }
  const running = C.data && C.data.job.running;
  C.polling = setTimeout(poll, running ? 500 : 2500);
}
function refresh() { C.version = null; poll(); }

// ---------- steps ----------
const NEEDS = {
  2: () => (C.folders.length < 2 ? "Choose at least two folders first." : !C.data || (!C.data.job.running && C.data.job.phase !== "done") ? "Click Compare first." : ""),
  3: () => (done() ? "" : "Compare the folders first."),
};
function goStep(n) {
  const why = NEEDS[n] ? NEEDS[n]() : "";
  if (why) { toast(why); return; }
  C.step = n;
  render();
  $(`.page[data-page="${n}"] .page-body`).scrollTop = 0;
}

function render() {
  if (NEEDS[C.step] && NEEDS[C.step]()) C.step = 1;
  const s = C.data && C.data.summary;
  const sub = {
    1: C.folders.length ? plural(C.folders.length, "folder") : "",
    2: C.data && C.data.job.running ? "Comparing…" : s ? `${(s.exact + s.same + s.versions).toLocaleString()} matches` : "",
    3: C.data && C.data.last && C.data.last.dest ? "Done" : "",
  };
  $$(".step-tab").forEach((b) => {
    const n = Number(b.dataset.step);
    b.classList.toggle("current", n === C.step);
    b.classList.toggle("done", n < C.step);
    b.classList.toggle("locked", !!(NEEDS[n] && NEEDS[n]()));
    $(`#st${n}`).textContent = sub[n];
  });
  $$(".page").forEach((pg) => { pg.hidden = Number(pg.dataset.page) !== C.step; });
  document.body.dataset.bd = C.backdrop;
  $$(".bd-seg button").forEach((b) => b.classList.toggle("active", b.dataset.bd === C.backdrop));
  if (C.step === 1) renderFolders();
  else if (C.step === 2) renderDiff();
  else renderConsolidate();
}

// ---------- ① folders ----------
function renderFolders() {
  $("#folderBlock").hidden = !C.folders.length;
  $("#folderList").replaceChildren(...C.folders.map((f, i) => {
    const li = el("li", "folder-item");
    const text = el("span", "fi-text");
    text.append(el("b", null, folderName(f) + (i === 0 ? "  · main" : "")), el("small", "muted", tilde(f)));
    const up = el("button", "icon-btn", "↑"); up.type = "button"; up.dataset.act = "up"; up.dataset.i = i; up.disabled = i === 0; up.title = "Move up (the first is the main folder)";
    const down = el("button", "icon-btn", "↓"); down.type = "button"; down.dataset.act = "down"; down.dataset.i = i; down.disabled = i === C.folders.length - 1;
    const rm = el("button", "icon-btn del", "×"); rm.type = "button"; rm.dataset.act = "remove"; rm.dataset.i = i; rm.title = "Remove from the comparison";
    li.append(letterBadge(i), text, up, down, rm);
    return li;
  }));
  $("#compareBtn").disabled = C.folders.length < 2 || (C.data && C.data.job.running);
  $("#foot1").textContent = C.folders.length < 2 ? "Choose at least two folders" : "";
}
async function setFolders(list) {
  const r = await act(() => api("/api/compare/folders", { folders: list }));
  if (r) { C.folders = r.folders; C.region = null; C.kind = null; refresh(); }
}

// ---------- ② differences ----------
// Every match (group) belongs to the set of folders it appears in; every unique file to its own folder.
function regions() {
  const d = C.data;
  const R = new Map();
  const get = (folders) => {
    const key = folders.join(",");
    if (!R.has(key)) R.set(key, { key, folders, groups: [], files: [] });
    return R.get(key);
  };
  for (let i = 0; i < C.folders.length; i++) get([i]); // every folder has an "only here" part
  for (const g of d.groups) get(g.folders).groups.push(g);
  for (const f of d.files) if (f.group == null) get([f.folder]).files.push(f);
  return R;
}
const regionCount = (r) => r.groups.length + r.files.length;
function regionThumbs(r, n) {
  const files = C.data.files;
  const out = [];
  for (const g of r.groups) {
    const f = files[g.variants[0].files[0]];
    if (f.image && !f.broken) out.push(f.id);
    if (out.length >= n) return out;
  }
  for (const f of r.files) {
    if (f.image && !f.broken) out.push(f.id);
    if (out.length >= n) break;
  }
  return out;
}
function regionName(key) {
  if (key === "conflicts") return "Same name, different picture";
  const fs = key.split(",").map(Number);
  const names = fs.map((i) => `${LETTERS[i]} (${folderName(C.folders[i])})`);
  if (fs.length === 1) return `Only in ${names[0]}`;
  if (fs.length === C.folders.length && fs.length > 2) return `In all ${fs.length} folders`;
  return `In ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
function firstRegion() {
  const R = [...regions().values()].filter((r) => regionCount(r));
  const overlaps = R.filter((r) => r.folders.length > 1).sort((a, b) => regionCount(b) - regionCount(a));
  return (overlaps[0] || R[0] || { key: "0" }).key;
}

// Fixed-size circles read better than area-proportional ones once labels and thumbnails go inside.
const VENN = {
  2: { w: 620, h: 330, r: 135, c: [[230, 178], [390, 178]],
    label: { "0": [152, 178], "1": [468, 178], "0,1": [310, 178] },
    name: [[150, 26], [470, 26]] },
  3: { w: 620, h: 500, r: 132, c: [[234, 192], [386, 192], [310, 322]],
    label: { "0": [168, 150], "1": [452, 150], "2": [310, 410], "0,1": [310, 142], "0,2": [232, 282], "1,2": [388, 282], "0,1,2": [310, 226] },
    name: [[150, 30], [470, 30], [310, 486]] },
};
const SVGNS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  return e;
}
function regionShape(V, key, cls) {
  // The region = inside the folders in `key`, outside the others (nested masks multiply together).
  const inside = key.split(",").map(Number);
  let node = svgEl("rect", { x: 0, y: 0, width: V.w, height: V.h, class: cls });
  V.c.forEach((_, i) => {
    const g = svgEl("g", { mask: `url(#${inside.includes(i) ? "in" : "out"}${i})` });
    g.append(node);
    node = g;
  });
  return node;
}

function renderVenn(R) {
  const n = C.folders.length;
  const wrap = $("#venn");
  wrap.replaceChildren();
  if (!VENN[n]) { renderCombos(R); return; }
  const V = VENN[n];
  wrap.className = `venn-wrap venn-${n}`;
  const svg = svgEl("svg", { viewBox: `0 0 ${V.w} ${V.h}`, class: "venn", role: "img", "aria-label": "Which files are in which folders" });
  const defs = svgEl("defs");
  V.c.forEach(([x, y], i) => {
    const mIn = svgEl("mask", { id: `in${i}` });
    mIn.append(svgEl("rect", { x: 0, y: 0, width: V.w, height: V.h, fill: "#000" }), svgEl("circle", { cx: x, cy: y, r: V.r, fill: "#fff" }));
    const mOut = svgEl("mask", { id: `out${i}` });
    mOut.append(svgEl("rect", { x: 0, y: 0, width: V.w, height: V.h, fill: "#fff" }), svgEl("circle", { cx: x, cy: y, r: V.r, fill: "#000" }));
    defs.append(mIn, mOut);
  });
  svg.append(defs);
  // (colours via .style, not a style="" attribute, which the page's security policy blocks)
  const circle = (x, y, i, cls) => { const e = svgEl("circle", { cx: x, cy: y, r: V.r, class: cls }); e.style.setProperty("--c", FOLDER_COLOURS[i]); return e; };
  V.c.forEach(([x, y], i) => svg.append(circle(x, y, i, "venn-circle")));
  if (C.hover && C.hover !== C.region && R.has(C.hover)) svg.append(regionShape(V, C.hover, "venn-hover"));
  if (C.region && C.region !== "conflicts" && R.has(C.region)) svg.append(regionShape(V, C.region, "venn-active"));
  V.c.forEach(([x, y], i) => svg.append(circle(x, y, i, "venn-outline")));
  wrap.append(svg);
  // folder names
  V.name.forEach(([x, y], i) => {
    const t = el("div", "venn-name");
    t.style.left = `${(100 * x) / V.w}%`;
    t.style.top = `${(100 * y) / V.h}%`;
    t.append(letterBadge(i), el("span", null, folderName(C.folders[i])));
    t.title = tilde(C.folders[i]);
    wrap.append(t);
  });
  // counts and a few little pictures in each region
  for (const [key, [x, y]] of Object.entries(V.label)) {
    const r = R.get(key) || { groups: [], files: [], folders: key.split(",").map(Number) };
    const count = regionCount(r);
    const lab = el("div", `venn-label${count ? "" : " zero"}${C.region === key ? " active" : ""}`);
    lab.style.left = `${(100 * x) / V.w}%`;
    lab.style.top = `${(100 * y) / V.h}%`;
    lab.append(el("b", null, count.toLocaleString()));
    const small = n === 3 && key.includes(",");
    const thumbs = el("div", "venn-thumbs");
    for (const fid of regionThumbs(r, small ? 2 : 3)) {
      const im = el("img");
      im.src = thumbUrl(fid);
      im.alt = "";
      im.loading = "lazy";
      thumbs.append(im);
    }
    if (thumbs.children.length) lab.append(thumbs);
    lab.append(el("small", null, r.folders.length > 1 ? (r.groups.length === 1 ? "match" : "matches") : "only here"));
    wrap.append(lab);
  }
}

function renderCombos(R) { // 4+ folders: a list of every combination instead
  const wrap = $("#venn");
  wrap.className = "venn-wrap combos";
  const rows = [...R.values()].filter(regionCount).sort((a, b) => b.folders.length - a.folders.length || regionCount(b) - regionCount(a));
  wrap.replaceChildren(...rows.map((r) => {
    const b = el("button", `combo-row${C.region === r.key ? " active" : ""}`);
    b.type = "button";
    b.dataset.region = r.key;
    const letters = el("span", "combo-letters");
    C.folders.forEach((_, i) => {
      const L = letterBadge(i);
      if (!r.folders.includes(i)) L.classList.add("off");
      letters.append(L);
    });
    const thumbs = el("span", "venn-thumbs");
    for (const fid of regionThumbs(r, 4)) { const im = el("img"); im.src = thumbUrl(fid); im.alt = ""; im.loading = "lazy"; thumbs.append(im); }
    b.append(letters, el("span", "combo-name", regionName(r.key)), thumbs, el("b", null, regionCount(r).toLocaleString()));
    return b;
  }));
}

function renderRegionBar(R) {
  const bar = $("#regionBar");
  const d = C.data;
  bar.replaceChildren();
  const head = el("div", "region-head");
  if (C.region === "conflicts") {
    head.append(el("h3", null, regionName("conflicts")), el("span", "muted", plural(d.conflicts.length, "name")));
    bar.append(head);
    return;
  }
  const r = R.get(C.region);
  if (!r) return;
  const counts = { exact: 0, same: 0, versions: 0 };
  for (const g of r.groups) counts[g.kind]++;
  head.append(el("h3", null, regionName(r.key)));
  if (r.folders.length > 1) head.append(el("span", "muted", plural(r.groups.length, "match", "matches")));
  else head.append(el("span", "muted", `${plural(r.files.length, "file")} only here${r.groups.length ? `, plus ${plural(r.groups.length, "set")} of duplicates inside this folder` : ""}`));
  bar.append(head);
  if (r.groups.length) {
    const chips = el("div", "kind-chips");
    const mk = (kind, label, n) => {
      const c = el("button", `kind-chip${C.kind === kind ? " active" : ""}${kind ? ` kc-${kind}` : ""}`);
      c.type = "button";
      c.dataset.kind = kind || "";
      c.disabled = !n;
      c.append(label, el("span", null, ` ${n.toLocaleString()}`));
      return c;
    };
    chips.append(mk(null, "All", r.groups.length + (r.folders.length > 1 ? 0 : r.files.length)),
      mk("exact", "Exact duplicates", counts.exact), mk("same", "Same picture", counts.same), mk("versions", "Versions", counts.versions));
    bar.append(chips);
  }
}

function renderDiff() {
  const d = C.data;
  const job = d.job;
  $("#jobCard").hidden = !job.running && job.phase !== "error" && job.phase !== "cancelled";
  $("#results").hidden = job.phase !== "done";
  if (job.running || job.phase === "error" || job.phase === "cancelled") {
    $("#jobTitle").textContent = job.phase === "error" ? "Couldn't finish comparing" : job.phase === "cancelled" ? "Cancelled" : `${job.phase}…`;
    $("#jobCount").textContent = job.total ? `${job.done.toLocaleString()} of ${job.total.toLocaleString()}` : "";
    $("#jobFill").style.width = job.total ? `${(100 * job.done) / job.total}%` : "0%";
    $("#cancelBtn").hidden = !job.running;
    $("#jobHint").textContent = job.error || "Pictures you've compared or sorted before are remembered, so the next time is quicker.";
    $("#foot2").textContent = "";
    $("#next2").disabled = true;
    return;
  }
  $("#next2").disabled = false;
  const s = d.summary;
  const R = regions();
  renderVenn(R);
  const clash = $("#clashLink");
  clash.hidden = !s.conflicts;
  clash.classList.toggle("active", C.region === "conflicts");
  clash.textContent = `${plural(s.conflicts, "name clash", "name clashes")}: same name, different picture →`;
  renderRegionBar(R);
  $("#saving").textContent = s.saved_bytes ? `Consolidating with the current choices saves about ${fmtBytes(s.saved_bytes)} of duplicate copies.` : "";
  $("#foot2").textContent = `${plural(s.files, "file")} compared`;
  renderList();
}

function wireVenn() {
  const wrap = $("#venn");
  const keyAt = (e) => {
    const svg = $("svg.venn", wrap);
    const V = VENN[C.folders.length];
    if (!svg || !V) return null;
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
    const inside = V.c.map(([x, y], i) => (Math.hypot(pt.x - x, pt.y - y) <= V.r ? i : -1)).filter((i) => i >= 0);
    return inside.length ? inside.join(",") : null;
  };
  wrap.addEventListener("click", (e) => {
    const row = e.target.closest(".combo-row");
    const key = row ? row.dataset.region : keyAt(e);
    if (!key) return;
    C.region = key; C.kind = null; C.limit = 120; C.hover = null;
    renderDiff();
  });
  wrap.addEventListener("mousemove", (e) => {
    const key = keyAt(e);
    wrap.classList.toggle("pointing", !!key);
    if (key !== C.hover) { C.hover = key; const R = regions(); renderVenn(R); }
  });
  wrap.addEventListener("mouseleave", () => { if (C.hover) { C.hover = null; renderVenn(regions()); } });
  $("#clashLink").addEventListener("click", () => { C.region = "conflicts"; C.kind = null; C.limit = 120; renderDiff(); });
  $("#regionBar").addEventListener("click", (e) => {
    const c = e.target.closest(".kind-chip");
    if (c && !c.disabled) { C.kind = c.dataset.kind || null; C.limit = 120; renderDiff(); }
  });
}

function variantTile(g, x, k) {
  const files = C.data.files;
  const f0 = files[x.files[0]];
  const tile = el("div", `cg-var${x.keep ? " kept" : " dropped"}`);
  const th = el("button", "cg-thumb");
  th.type = "button";
  th.dataset.open = g.id;
  th.title = "Compare side by side";
  if (f0.image && !f0.broken) {
    const im = el("img");
    im.loading = "lazy";
    im.alt = "";
    im.src = thumbUrl(f0.id);
    th.append(im);
  } else th.append(el("span", "file-ext", (f0.name.split(".").pop() || "file").toUpperCase()));
  tile.append(th);
  const sameSet = g.variants.filter((v) => v.set === x.set).length > 1;
  const head = el("div", "cg-var-head");
  if (g.variants.length > 1) {
    const lab = el("label", "check keep-check");
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = x.keep;
    cb.dataset.g = g.id;
    cb.dataset.k = k;
    lab.append(cb, el("span", null, "Keep"));
    head.append(lab);
  }
  if (sameSet && g.variants.findIndex((v) => v.set === x.set) === k) head.append(el("span", "best-badge", "Best"));
  tile.append(head);
  const meta = el("div", "cg-meta");
  const bits = [];
  if (f0.w) bits.push(`${f0.w}×${f0.h}`);
  bits.push(fmtBytes(f0.size), fmtDate(f0.mtime));
  if (f0.alpha) bits.push("transparent");
  meta.textContent = bits.join(" · ");
  tile.append(meta);
  const where = el("ul", "cg-where");
  for (const fid of x.files) {
    const f = files[fid];
    const li = el("li");
    li.append(letterBadge(f.folder), el("span", null, f.rel));
    li.title = f.path;
    li.dataset.reveal = fid;
    where.append(li);
  }
  tile.append(where);
  if (x.files.length > 1) tile.append(el("div", "hint", `${x.files.length} identical copies; one is kept`));
  if (sameSet && g.variants.findIndex((v) => v.set === x.set) !== k) {
    tile.append(el("div", "hint", "Looks the same as the one marked Best, which is better quality"));
  }
  return tile;
}

function groupCard(g) {
  const card = el("div", "cmp-group");
  const head = el("div", "cg-head");
  const nfiles = g.variants.reduce((a, x) => a + x.files.length, 0);
  head.append(el("span", `kind-badge kind-${g.kind}`, KIND[g.kind].label),
    el("span", "muted", g.kind === "exact" ? `${nfiles} copies` : `${g.variants.length} ${g.kind === "versions" ? "versions" : "files"}`),
    ...g.folders.map(letterBadge));
  const open = el("button", "small ghost", "Compare side by side");
  open.type = "button";
  open.dataset.open = g.id;
  head.append(el("span", "spacer"), open);
  const row = el("div", "cg-variants");
  row.append(...g.variants.map((x, k) => variantTile(g, x, k)));
  card.append(head, row);
  return card;
}
function fileTile(x) {
  const t = el("div", "only-tile");
  const th = el("div", "cg-thumb");
  if (x.image && !x.broken) { const im = el("img"); im.loading = "lazy"; im.alt = ""; im.src = thumbUrl(x.id); th.append(im); }
  else th.append(el("span", "file-ext", (x.name.split(".").pop() || "file").toUpperCase()));
  t.append(th, el("div", "only-name", x.rel));
  t.title = x.path;
  t.dataset.reveal = x.id;
  return t;
}

function renderList() {
  const d = C.data;
  const list = $("#cmpList");
  list.className = "cmp-list";
  let info = "";
  let groups = [], files = [], clashes = [];
  if (C.region === "conflicts") {
    clashes = d.conflicts;
    info = "Different pictures that share a file name. Both are kept; the second gets “(2)” added so nothing is overwritten.";
  } else {
    const r = regions().get(C.region);
    if (r) {
      groups = r.groups.filter((g) => !C.kind || g.kind === C.kind);
      files = C.kind ? [] : r.files;
      info = C.kind ? KIND[C.kind].blurb : r.folders.length > 1
        ? "Click a picture to compare them side by side. Untick Keep on anything you don't want in the merged result."
        : "Files that aren't anywhere else. These are always kept.";
    }
  }
  $("#filterInfo").textContent = info;
  const total = groups.length + files.length + clashes.length;
  const lim = C.limit;
  $("#moreBtn").hidden = total <= lim;
  $("#moreBtn").textContent = `Show more (${(total - lim).toLocaleString()} left)`;
  $("#listEmpty").hidden = total > 0;
  const out = [];
  out.push(...groups.slice(0, lim).map(groupCard));
  const left = Math.max(0, lim - groups.length);
  if (files.length && left) {
    const grid = el("div", "only-grid");
    grid.append(...files.slice(0, left).map(fileTile));
    if (groups.length) out.push(el("h4", "list-sub", `${plural(files.length, "file")} only in this folder`));
    out.push(grid);
  }
  out.push(...clashes.slice(0, lim).map((fids) => {
    const card = el("div", "cmp-group");
    const head = el("div", "cg-head");
    head.append(el("span", "kind-badge kind-conflict", "Same name"), el("b", null, d.files[fids[0]].name));
    const row = el("div", "cg-variants");
    row.append(...fids.map((fid) => variantTile({ id: -1, variants: [{ files: [fid], keep: true }] }, { files: [fid], keep: true, set: fid }, 0)));
    card.append(head, row);
    return card;
  }));
  list.replaceChildren(...out);
}

function openGroup(gid) {
  const g = C.data.groups[gid];
  if (!g) return;
  const files = C.data.files;
  $("#dlgTitle").textContent = KIND[g.kind].label;
  $("#dlgSub").textContent = KIND[g.kind].blurb;
  const body = $("#dlgBody");
  body.style.setProperty("--cols", Math.min(g.variants.length, 4));
  body.replaceChildren(...g.variants.map((x, k) => {
    const f0 = files[x.files[0]];
    const col = el("div", `dlg-col${x.keep ? "" : " dropped"}`);
    const stage = el("div", "dlg-stage");
    if (f0.image && !f0.broken) { const im = el("img"); im.alt = ""; im.src = thumbUrl(f0.id, "large"); stage.append(im); }
    else stage.append(el("span", "file-ext", (f0.name.split(".").pop() || "file").toUpperCase()));
    col.append(stage, variantTile(g, x, k));
    return col;
  }));
  // Highlight what differs between them.
  const props = (x) => { const f = files[x.files[0]]; return [f.w ? `${f.w}×${f.h}` : "", fmtBytes(f.size), fmtDate(f.mtime)]; };
  const all = g.variants.map(props);
  $$(".dlg-col .cg-meta", body).forEach((m, i) => {
    const differs = all.some((p) => p.join() !== all[i].join());
    m.classList.toggle("differs", differs);
  });
  $("#cmpDialog").showModal();
}

async function setKeep(gid, k, on) {
  const g = C.data.groups[gid];
  const keep = g.variants.map((x, i) => (i === k ? on : x.keep)).map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
  if (!keep.length) { toast("Keep at least one."); render(); return; }
  g.variants.forEach((x, i) => { x.keep = keep.includes(i); });
  render();
  if ($("#cmpDialog").open) openGroup(gid);
  await act(() => api("/api/compare/keep", { group: gid, keep }));
  refresh();
}

// ---------- ③ consolidate ----------
function renderConsolidate() {
  const d = C.data;
  const s = d.summary;
  let kept = 0, dropped = 0, versions = 0;
  for (const f of d.files) if (f.group == null) kept++;
  for (const g of d.groups) {
    for (const x of g.variants) {
      if (x.keep) { kept++; dropped += x.files.length - 1; if (g.kind === "versions") versions++; } else dropped += x.files.length;
    }
  }
  $("#planLead").textContent = `Of ${plural(s.files, "file")}, ${kept.toLocaleString()} will be kept and ${dropped.toLocaleString()} left out as duplicates.`;
  const points = [
    s.exact ? `${plural(s.exact, "exact duplicate")}: one copy each` : "",
    s.same ? `${plural(s.same, "same picture", "same pictures")} in different files: the best of each` : "",
    s.versions ? `${plural(s.versions, "picture")} with versions: ${versions.toLocaleString()} files kept side by side` : "",
    s.conflicts ? `${plural(s.conflicts, "name clash", "name clashes")}: both kept, renamed “(2)”` : "",
  ].filter(Boolean);
  $("#planPoints").replaceChildren(...points.map((p) => el("div", "plan-point", p)));
  const main = folderName(C.folders[0]);
  $("#intoTitle").textContent = `Merge into ${main} (A)`;
  $("#mergeInto").textContent = `Merge into ${main}`;
  const last = d.last || {};
  $("#doneCard").hidden = !last.dest;
  if (last.dest) {
    $("#doneTitle").textContent = last.mode === "new" ? "Merged folder created" : `Merged into ${folderName(last.dest)}`;
    $("#doneText").textContent = `${plural(last.copied, "file")} copied${last.already ? `, ${last.already.toLocaleString()} already there` : ""}. ${tilde(last.dest)}`;
    $("#doneProblems").hidden = !(last.problems && last.problems.length);
    $("#doneProblems").textContent = (last.problems || []).join(" · ");
    const n = (last.trash || []).length;
    $("#trashBtn").hidden = !n;
    $("#trashHint").hidden = !n;
    $("#trashBtn").textContent = `Move ${plural(n, "leftover copy", "leftover copies")} to the Trash…`;
    if (last.trashed) $("#doneText").textContent += ` ${plural(last.trashed, "leftover copy", "leftover copies")} moved to the Trash.`;
  }
}

async function consolidate(mode) {
  let dest = null;
  if (mode === "new") {
    const pick = await withDialog(() => act(() => api("/api/pick", { kind: "compare-dest" })), "#mergeNew");
    if (!pick || pick.cancelled) return;
    const name = `Merged ${new Date().toISOString().slice(0, 10)}`;
    dest = `${pick.dest.replace(/\/$/, "")}/${name}`;
  } else if (!confirm(`Copy everything ${folderName(C.folders[0])} is missing into it?\n\nNothing already in ${folderName(C.folders[0])} is replaced. The other folders aren't changed; you can move their leftover copies to the Trash afterwards.`)) return;
  const busy = toast("Copying…", "info", 600000);
  const r = await act(() => api("/api/compare/consolidate", { mode, dest }));
  busy.remove();
  if (r) {
    toast(`${plural(r.copied, "file")} copied.`);
    refresh();
    setTimeout(() => $("#doneCard").scrollIntoView({ behavior: "smooth", block: "center" }), 700);
  }
}

// ---------- wiring ----------
function wire() {
  $$(".step-tab").forEach((b) => b.addEventListener("click", () => goStep(Number(b.dataset.step))));
  $$("[data-goto]").forEach((b) => b.addEventListener("click", () => goStep(Number(b.dataset.goto))));
  $("#addFolders").addEventListener("click", async () => {
    const r = await withDialog(() => act(() => api("/api/pick", { kind: "compare-folder" })), "#addFolders");
    if (r && r.paths) setFolders([...C.folders, ...r.paths]);
  });
  $("#clearFolders").addEventListener("click", () => setFolders([]));
  $("#folderList").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const i = Number(b.dataset.i);
    const list = [...C.folders];
    if (b.dataset.act === "up") [list[i - 1], list[i]] = [list[i], list[i - 1]];
    else if (b.dataset.act === "down") [list[i + 1], list[i]] = [list[i], list[i + 1]];
    else list.splice(i, 1);
    setFolders(list);
  });
  $("#compareBtn").addEventListener("click", () => act(async () => {
    await api("/api/compare/start", {});
    C.region = null;
    C.kind = null;
    C.limit = 120;
    C.data = { job: { running: true, phase: "Starting", done: 0, total: 0 } };
    C.step = 2;
    refresh();
  }));
  $("#cancelBtn").addEventListener("click", () => act(() => api("/api/compare/cancel", {})));
  wireVenn();
  $("#moreBtn").addEventListener("click", () => { C.limit += 120; renderList(); });
  document.addEventListener("click", (e) => {
    const o = e.target.closest("[data-open]");
    if (o && Number(o.dataset.open) >= 0) { openGroup(Number(o.dataset.open)); return; }
    const r = e.target.closest("[data-reveal]");
    if (r) act(() => api("/api/compare/reveal", { fid: Number(r.dataset.reveal) }));
  });
  document.addEventListener("change", (e) => {
    const cb = e.target.closest(".keep-check input");
    if (cb && Number(cb.dataset.g) >= 0) setKeep(Number(cb.dataset.g), Number(cb.dataset.k), cb.checked);
  });
  $("#dlgClose").addEventListener("click", () => $("#cmpDialog").close());
  $$(".bd-seg button").forEach((b) => b.addEventListener("click", () => {
    C.backdrop = b.dataset.bd;
    try { localStorage.setItem("bgs-cmp-backdrop", C.backdrop); } catch { /* private mode */ }
    document.body.dataset.bd = C.backdrop;
    $$(".bd-seg button").forEach((x) => x.classList.toggle("active", x.dataset.bd === C.backdrop));
  }));
  $("#mergeNew").addEventListener("click", () => consolidate("new"));
  $("#mergeInto").addEventListener("click", () => consolidate("into_first"));
  $("#openDest").addEventListener("click", () => act(() => api("/api/compare/reveal", {})));
  $("#trashBtn").addEventListener("click", () => {
    const n = (C.data.last.trash || []).length;
    if (!confirm(`Move ${plural(n, "leftover copy", "leftover copies")} to the Trash?\n\nEverything they contained is now in ${folderName(C.data.last.dest)}. The Trash keeps them until you empty it.`)) return;
    act(async () => {
      const r = await api("/api/compare/trash", {});
      toast(`Moved ${plural(r.moved, "file")} to the Trash.`, "info", 6000);
      for (const p of r.problems) toast(p, "error", 7000);
      refresh();
    });
  });
  $("#quitBtn").addEventListener("click", async () => {
    if (!confirm("Quit Background Studio?")) return;
    try { await api("/api/quit", {}); } catch { /* server is going away */ }
    const msg = el("div", "empty");
    msg.append(el("h3", null, "Background Studio has stopped."),
      el("p", null, "You can close this tab. To start again, click Background Studio in your Dock."));
    document.body.replaceChildren(msg);
  });
}

wire();
poll().then(() => {
  if (C.data && (C.data.job.running || C.data.job.phase === "done")) C.step = C.data.last && C.data.last.dest ? 3 : 2;
  render();
});
