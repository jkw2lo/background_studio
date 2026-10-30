"use strict";
// Sort & tag: one picture at a time, one click per picture. Talks only to the local server.

const TOKEN = document.querySelector('meta[name="studio-token"]').content;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const T = {
  cats: [], items: [], byId: new Map(),
  view: "sort", cur: null, history: [], forward: [], undo: [], filter: "all",
  imgReady: false,
  hold: null,         // a category key or button held down: { catId, key } keeps tagging, one picture at a time
  showFlash: true,    // the picture on screen is the one being tagged (not the previous one, still loading)
  fromReview: false, // opened a picture from Review: go back there after retagging it
  roots: [], dest: "", auto: { on: false },
  sugg: new Map(),    // id -> { key, cat, conf } for the picture on screen
  tagVersion: 0,      // bumps whenever tags change, so suggestions learn from them
  lastSave: Promise.resolve(),
  backdrop: "checker",
  dups: new Map(),    // id -> ids of its near-identical copies (itself included)
  queue: null,        // { label, ids, done } while checking auto-tags or search results one by one
  search: null,       // { q, rank: Map id -> position }
  zoomed: false,
  step: 1,
  sets: [],
  rounds: [],         // [{id, name, kind: "tags"|"rating", categories}]
  round: null,        // the round being sorted; T.cats are its categories
};
try { T.round = localStorage.getItem("bgs-tag-round"); } catch { /* private mode */ }
try { T.showFlash = localStorage.getItem("bgs-tag-flash") !== "off"; } catch { /* private mode */ }
try { T.backdrop = localStorage.getItem("bgs-tag-backdrop") || "checker"; } catch { /* private mode */ }

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
const imgUrl = (id, size) => `/api/tag/image/${id}?size=${size}&t=${encodeURIComponent(TOKEN)}`;
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
const isPending = (it) => !it.tags.length && !it.skipped;
const allCats = () => T.rounds.flatMap((r) => r.categories);
const catById = (id) => allCats().find((c) => c.id === id);
const curRound = () => T.rounds.find((r) => r.id === T.round) || T.rounds[0];
const roundOf = (catId) => T.rounds.find((r) => r.categories.some((c) => c.id === catId));
// Each picture is seen "from the current round": .tags and .skipped are this round's, while
// .allTags and .skippedRounds keep every round's, so the sorting code only thinks about one round.
function view(raw) {
  const ids = new Set(T.cats.map((c) => c.id));
  return { ...raw, allTags: raw.tags, skippedRounds: raw.skipped,
    tags: raw.tags.filter((t) => ids.has(t)), skipped: raw.skipped.includes(T.round) };
}
const raw = (it) => ({ ...it, tags: it.allTags, skipped: it.skippedRounds });
function useRound(rid) {
  const r = T.rounds.find((x) => x.id === rid) || T.rounds[0];
  if (!r) return;
  T.round = r.id;
  T.cats = r.categories;
  try { localStorage.setItem("bgs-tag-round", r.id); } catch { /* private mode */ }
  T.items = T.items.map((it) => view(raw(it)));
  T.byId = new Map(T.items.map((it) => [it.id, it]));
  T.sugg.clear();
  T.tagVersion++;
}
// Category keys follow the keyboard: the number row, then the letter rows left to right (36 in all).
const KEYS = "1234567890QWERTYUIOPASDFGHJKLZXCVBNM";
const keyFor = (i) => KEYS[i] || "";
function catForKey(code) { // physical key, so it matches the keyboard's QWERTY positions
  const m = /^(?:Digit|Numpad)(\d)$/.exec(code) || /^Key([A-Z])$/.exec(code);
  return m ? T.cats[KEYS.indexOf(m[1])] : null;
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
function chip(cat, auto = false) {
  const c = el("span", auto ? "tag-chip auto" : "tag-chip", cat.name);
  c.style.setProperty("--c", cat.color);
  if (auto) c.title = "Tagged automatically; not checked yet";
  return c;
}
// All of a picture's tags, this round's first; other rounds' are shown quieter.
const chipsFor = (it) => [...(it.allTags || it.tags)].sort((a, b) => it.tags.includes(b) - it.tags.includes(a))
  .map(catById).filter(Boolean)
  .map((c) => { const e = chip(c, it.auto && it.tags.includes(c.id)); if (!it.tags.includes(c.id)) e.classList.add("other"); return e; });
const groupOf = (id) => (T.dups.get(id) || [id]).filter((x) => T.byId.has(x));
function download(url) {
  const a = el("a");
  a.href = url;
  a.download = "";
  document.body.append(a);
  a.click();
  a.remove();
}

function setState(st) {
  T.rounds = st.rounds;
  const r = T.rounds.find((x) => x.id === T.round) || T.rounds[0];
  T.round = r.id;
  T.cats = r.categories;
  T.items = st.items.map(view);
  T.roots = st.roots || [];
  T.dest = st.dest || "";
  T.sets = st.sets || [];
  if (st.auto) T.auto = st.auto;
  T.tagVersion++;
  T.byId = new Map(T.items.map((it) => [it.id, it]));
  if (T.cur && !T.byId.has(T.cur)) T.cur = null;
  T.history = T.history.filter((id) => T.byId.has(id));
  T.forward = T.forward.filter((id) => T.byId.has(id));
  T.undo = T.undo.map((u) => ({ ...u, items: u.items.filter((x) => T.byId.has(x.id)) })).filter((u) => u.items.length);
}
function replaceItem(it) {
  const i = T.items.findIndex((x) => x.id === it.id);
  if (i >= 0) T.items[i] = it;
  T.byId.set(it.id, it);
}
function counts() {
  const per = Object.fromEntries(T.cats.map((c) => [c.id, 0]));
  let tagged = 0, skipped = 0;
  for (const it of T.items) {
    if (it.tags.length) tagged++;
    else if (it.skipped) skipped++;
    for (const t of it.tags) if (t in per) per[t]++;
  }
  return { per, tagged, skipped, pending: T.items.length - tagged - skipped };
}

// Next picture that still needs a tag, after `fromId` (wrapping round to the start).
function nextPending(fromId) {
  if (T.queue) {
    const q = T.queue.ids.filter((id) => T.byId.has(id));
    const start = Math.max(-1, q.indexOf(fromId));
    for (let k = 1; k <= q.length; k++) {
      const id = q[(start + k) % q.length];
      if (!T.queue.done.has(id)) return id;
    }
    return null;
  }
  const n = T.items.length;
  const start = fromId ? T.items.findIndex((x) => x.id === fromId) : -1;
  for (let k = 1; k <= n; k++) {
    const it = T.items[(start + k + n) % n];
    if (isPending(it)) return it.id;
  }
  return null;
}

// ---------- rendering ----------
// ---------- steps ----------
const STEP_NEEDS = {
  2: () => (T.items.length ? "" : "Add some pictures first."),
  3: () => (!T.items.length ? "Add some pictures first."
    : !T.rounds.some((r) => r.categories.length) ? "Add at least one category first." : ""),
  4: () => STEP_NEEDS[3](),
};
function firstOpenRound() {
  const usable = T.rounds.filter((r) => r.categories.length);
  return (usable.find((r) => roundCounts(r).pending) || usable[0] || T.rounds[0]).id;
}
function goStep(n) {
  const why = STEP_NEEDS[n] ? STEP_NEEDS[n]() : "";
  if (why) { toast(why); return; }
  if (n !== 3) { T.queue = null; zoomOut(); }
  const from = T.step;
  T.step = n;
  try { localStorage.setItem("bgs-tag-step", String(n)); } catch { /* private mode */ }
  if (n === 1) loadRecent();
  if (n === 3 && from !== 3) { // coming to Sort: start at the first round that isn't finished
    useRound(firstOpenRound());
    T.cur = null; T.history = []; T.forward = [];
  }
  render();
  $(`.page[data-page="${n}"] .page-body`).scrollTop = 0;
}
function defaultStep() {
  let saved = 3;
  try { saved = Number(localStorage.getItem("bgs-tag-step")) || 3; } catch { /* private mode */ }
  for (let n = Math.min(4, saved); n > 1; n--) if (!STEP_NEEDS[n]()) return n;
  return 1;
}

function renderSteps() {
  if (STEP_NEEDS[T.step] && STEP_NEEDS[T.step]()) T.step = defaultStep();
  const c = counts();
  const sub = {
    1: T.items.length ? plural(T.items.length, "picture") : "",
    2: T.rounds.length > 1 ? `${T.rounds.length} rounds`
      : T.cats.length ? plural(T.cats.length, "category").replace("categorys", "categories") : "",
    3: T.items.length && T.cats.length ? `${T.rounds.length > 1 ? `${curRound().name}: ` : ""}${c.tagged.toLocaleString()} of ${T.items.length.toLocaleString()}` : "",
    4: "",
  };
  $$(".step-tab").forEach((b) => {
    const n = Number(b.dataset.step);
    b.classList.toggle("current", n === T.step);
    b.classList.toggle("done", n < T.step || (n === 1 && T.items.length > 0) || (n === 2 && T.cats.length > 0));
    b.classList.toggle("locked", !!(STEP_NEEDS[n] && STEP_NEEDS[n]()));
    b.setAttribute("aria-current", n === T.step ? "step" : "false");
    $(`#st${n}`).textContent = sub[n];
  });
  $$(".page").forEach((pg) => { pg.hidden = Number(pg.dataset.page) !== T.step; });
  $("#next1").disabled = !T.items.length;
  $("#foot1").textContent = T.items.length ? `${plural(T.items.length, "picture")} ready` : "Choose some pictures to continue";
  const anyCats = T.rounds.some((r) => r.categories.length);
  $("#next2").disabled = !anyCats;
  $("#foot2").textContent = anyCats ? "" : "Add at least one category to continue";
  $("#foot3").textContent = c.pending ? `${c.pending.toLocaleString()} still to sort` : "";
  const allDone = T.items.length > 0 && T.rounds.filter((r) => r.categories.length).every((r) => !roundCounts(r).pending);
  $("#next3").classList.toggle("primary", allDone);
}

function render() {
  renderSteps();
  renderAuto();
  renderBackdrop();
  if (T.step === 1) renderImagesPage();
  else if (T.step === 2) { renderRounds(); renderCatList(); renderSets(); }
  else if (T.step === 3) renderSortPage();
  else renderUsePage();
}

function roundCounts(r) {
  const ids = new Set(r.categories.map((c) => c.id));
  let tagged = 0, skipped = 0;
  for (const it of T.items) {
    if (it.allTags.some((t) => ids.has(t))) tagged++;
    else if (it.skippedRounds.includes(r.id)) skipped++;
  }
  return { tagged, skipped, pending: T.items.length - tagged - skipped };
}

function renderRoundSeg() {
  const seg = $("#roundSeg");
  seg.hidden = T.rounds.length < 2;
  seg.replaceChildren(...T.rounds.map((r, i) => {
    const b = el("button", r.id === T.round ? "active" : "");
    b.type = "button";
    b.dataset.round = r.id;
    b.disabled = !r.categories.length;
    const rc = roundCounts(r);
    b.append(el("span", null, `${i + 1}. ${r.name}`), el("small", null, ` ${rc.tagged}/${T.items.length}`));
    b.title = r.categories.length ? `Sort by ${r.name}` : "No categories in this round yet";
    return b;
  }));
}

function renderSortPage() {
  renderRoundSeg();
  renderProgress();
  $$("#viewSeg button").forEach((b) => b.classList.toggle("active", b.dataset.view === T.view));
  if (T.view === "review") {
    $("#sorter").hidden = $("#doneCard").hidden = true;
    $("#review").hidden = false;
    renderReview();
  } else {
    $("#review").hidden = true;
    if (T.cur == null) T.cur = nextPending(null);
    renderSorter();
  }
}

// ---------- ① images ----------
function renderImagesPage() {
  $("#listBlock").hidden = !T.items.length;
  const inRoot = (it, r) => it.path.startsWith(r.replace(/\/$/, "") + "/");
  const rows = T.roots.map((r) => ({ path: r, name: r.split("/").pop() || r, n: T.items.filter((it) => inRoot(it, r)).length }));
  const loose = T.items.filter((it) => !T.roots.some((r) => inRoot(it, r))).length;
  if (loose) rows.push({ path: "", name: "Pictures chosen one by one", n: loose });
  $("#rootList").replaceChildren(...rows.map((row) => {
    const li = el("li", "folder-item");
    const icon = el("span", "fi-icon", row.path ? "📁" : "🖼");
    const text = el("span", "fi-text");
    text.append(el("b", null, row.name), el("small", "muted", row.path ? tilde(row.path) : ""));
    const n = el("span", "fi-count", plural(row.n, "picture"));
    const rm = el("button", "icon-btn del", "×");
    rm.type = "button";
    rm.title = "Remove from the list (files and tags are kept)";
    rm.dataset.folder = row.path;
    li.append(icon, text, n, rm);
    return li;
  }));
  $("#rescanBtn").hidden = !T.roots.length;
}

let recent = [];
async function loadRecent() {
  try { recent = (await api("/api/tag/recent")).folders; } catch { recent = []; }
  renderRecent();
}
function renderRecent() {
  const list = recent.filter((f) => !T.roots.includes(f.path));
  $("#recentBlock").hidden = !list.length;
  $("#recentList").replaceChildren(...list.map((f) => {
    const b = el("button", "recent-card");
    b.type = "button";
    b.dataset.path = f.path;
    b.title = f.path;
    const text = el("span", "fi-text");
    text.append(el("b", null, f.name), el("small", "muted", tilde(f.path)));
    b.append(el("span", "fi-icon", "📁"), text, el("span", "recent-label", f.label), el("span", "recent-use", "Use →"));
    return b;
  }));
}

// ---------- ② saved sets ----------
function renderSets() {
  const sel = $("#setSelect");
  const keep = sel.value;
  sel.replaceChildren(el("option", null, T.sets.length ? "Choose a saved set…" : "No saved sets yet"),
    ...T.sets.map((x) => {
      const o = el("option", null, `${x.name}  (${x.categories.map((c) => c.name).join(", ")})`);
      o.value = x.name;
      return o;
    }));
  sel.firstChild.value = "";
  sel.value = T.sets.some((x) => x.name === keep) ? keep : "";
  sel.disabled = !T.sets.length;
  $("#useSet").disabled = $("#deleteSet").disabled = !sel.value;
  $("#saveSet").disabled = !T.cats.length;
}

// ---------- ④ use your tags ----------
function renderUsePage() {
  const c = counts();
  $("#useLead").textContent = `${c.tagged.toLocaleString()} of ${plural(T.items.length, "picture")} tagged` +
    (c.pending + c.skipped ? `, ${(c.pending + c.skipped).toLocaleString()} not yet.` : ".");
  const per = {};
  for (const it of T.items) for (const t of it.allTags) per[t] = (per[t] || 0) + 1;
  $("#useCounts").replaceChildren(...T.rounds.map((r) => {
    const row = el("div", "use-round");
    if (T.rounds.length > 1) row.append(el("span", "use-round-name", r.name));
    row.append(...r.categories.filter((cat) => per[cat.id]).map((cat) => {
      const d = el("span", "done-count");
      d.append(chip(cat), el("b", null, per[cat.id].toLocaleString()));
      return d;
    }));
    return row;
  }));
  if (T.rounds.length > 1) $("#useLead").textContent = T.rounds.map((r) => `${r.name}: ${roundCounts(r).tagged.toLocaleString()} of ${T.items.length.toLocaleString()} tagged`).join(" · ");
  // Copy layout: one round, or rounds nested (e.g. Okinawa/Ticket/).
  const sel = $("#folderLayout");
  const keep = sel.value;
  const usable = T.rounds.filter((r) => r.categories.length);
  const opts = usable.map((r) => [r.id, `${r.name} (one folder per ${r.kind === "rating" ? "rating" : "category"})`]);
  if (usable.length >= 2) opts.push([usable.slice(0, 2).map((r) => r.id).join(","), usable.slice(0, 2).map((r) => r.name).join(" › ") + " (nested)"]);
  if (usable.length === 3) opts.push([usable.map((r) => r.id).join(","), usable.map((r) => r.name).join(" › ") + " (nested)"]);
  sel.replaceChildren(...opts.map(([v, label]) => { const o = el("option", null, label); o.value = v; return o; }));
  if (opts.some(([v]) => v === keep)) sel.value = keep;
  $("#layoutRow").hidden = usable.length < 2;
  renderFolders();
}

function renderProgress() {
  if (T.queue) {
    const total = T.queue.ids.length;
    const done = T.queue.done.size;
    $("#progText").textContent = `${T.queue.label}: ${Math.min(done + 1, total).toLocaleString()} of ${total.toLocaleString()}`;
    $("#progSub").replaceChildren();
    const stop = el("button", "small ghost", "Stop");
    stop.type = "button";
    stop.addEventListener("click", () => finishQueue(false));
    $("#progSub").append(stop);
    $("#progFill").style.width = `${total ? (100 * done) / total : 0}%`;
    return;
  }
  const c = counts();
  const n = T.items.length;
  $("#progText").textContent = `${c.tagged.toLocaleString()} of ${plural(n, "image")} tagged`;
  $("#progSub").textContent = [c.pending ? `${c.pending.toLocaleString()} to go` : "",
    c.skipped ? `${c.skipped.toLocaleString()} skipped` : ""].filter(Boolean).join(" · ");
  $("#progFill").style.width = `${n ? (100 * c.tagged) / n : 0}%`;
}

let imgTimer = null;
function renderSorter() {
  const it = T.cur && T.byId.get(T.cur);
  if (!it && T.queue) { finishQueue(true); return; }
  if (!it) {
    $("#sorter").hidden = true;
    renderDone();
    return;
  }
  $("#doneCard").hidden = true;
  $("#sorter").hidden = false;
  const img = $("#sortImg");
  const url = imgUrl(it.id, "large");
  if (img.dataset.src !== url) {
    zoomOut();
    T.imgReady = false;
    img.dataset.src = url;
    $("#sortStage").classList.remove("broken");
    clearTimeout(imgTimer);
    imgTimer = setTimeout(() => { $("#sortLoading").hidden = false; }, 150);
    img.classList.add("loading");
    img.src = url;
    img.alt = it.name;
  }
  $("#sortName").textContent = it.name;
  $("#sortWhere").textContent = `in ${it.folder}`;
  const tags = $("#sortTags");
  tags.replaceChildren(...chipsFor(it));
  if (it.skipped && !it.tags.length) tags.append(el("span", "tag-chip skipped", "Skipped"));
  const copies = groupOf(it.id).length - 1;
  const dup = $("#sortDup");
  dup.hidden = !copies;
  if (copies) {
    dup.textContent = `+ ${plural(copies, "duplicate")}, tagged together`;
    dup.title = "Near-identical copies elsewhere in the list:\n" + groupOf(it.id).filter((x) => x !== it.id)
      .map((x) => `${T.byId.get(x).folder}/${T.byId.get(x).name}`).join("\n");
  }
  $("#backBtn").disabled = !T.history.length;
  $("#undoBtn").disabled = !T.undo.length;
  renderCatButtons(it);
  renderSuggestion(it);
  prefetch(it.id);
}

// ---------- auto-suggest ----------
function currentSuggestion(it) {
  if (!T.auto.on || !it || it.tags.length) return null;
  const s = T.sugg.get(it.id);
  return s && catById(s.cat) ? s : null; // may be a little stale; refreshed in the background
}

let suggTimer = null;
function renderSuggestion(it) {
  const bar = $("#suggestBar");
  if (it.auto && it.tags.length) { // auto-tagged, waiting for you to check it
    const cat = catById(it.tags[0]);
    bar.hidden = false;
    bar.className = "suggest-bar";
    bar.style.setProperty("--c", cat.color);
    const keep = el("button", "small accent", "Keep ↩");
    keep.type = "button";
    keep.dataset.keep = "1";
    bar.replaceChildren(el("span", null, "Auto-tagged as "), chip(cat), el("span", "spacer"),
      el("span", "muted small-text", "or press another category's key"), keep);
    $$(".cat-btn.on").forEach((b) => { b.classList.add("suggested"); b.dataset.conf = "auto"; });
    return;
  }
  if (T.queue && it.tags.length) { // going through again: keep or change
    const cat = catById(it.tags[0]);
    bar.hidden = false;
    bar.className = "suggest-bar";
    bar.style.setProperty("--c", cat.color);
    const keep = el("button", "small accent", "Keep ↩");
    keep.type = "button";
    keep.dataset.keep = "1";
    bar.replaceChildren(el("span", null, "Tagged "), ...chipsFor(it), el("span", "spacer"),
      el("span", "muted small-text", "or press another category's key"), keep);
    return;
  }
  if (!T.auto.on || it.tags.length || curRound().kind === "rating") { bar.hidden = true; return; }
  const s = currentSuggestion(it);
  bar.hidden = false;
  if (!s || s.key !== T.tagVersion) requestSuggestion(it.id);
  if (!s) {
    bar.className = "suggest-bar waiting";
    bar.textContent = "Thinking…";
    return;
  }
  const cat = catById(s.cat);
  bar.className = `suggest-bar${s.conf < 0.4 ? " unsure" : ""}`;
  bar.style.setProperty("--c", cat.color);
  const accept = el("button", "small accent", "Accept ↩");
  accept.type = "button";
  accept.dataset.cat = cat.id;
  bar.replaceChildren(el("span", null, s.conf < 0.4 ? "Not sure. Maybe " : "Looks like "), chip(cat),
    el("span", "muted", ` ${Math.round(s.conf * 100)}%`), el("span", "spacer"),
    el("span", "muted small-text", "or press another category's key"), accept);
  const b = $(`.cat-btn[data-cat="${cat.id}"]`);
  if (b) { b.classList.add("suggested"); b.dataset.conf = `↩ ${Math.round(s.conf * 100)}%`; }
}

async function requestSuggestion(id) {
  const key = T.tagVersion;
  clearTimeout(suggTimer);
  suggTimer = setTimeout(async () => {
    await T.lastSave; // include the tag you just gave, so it learns from it
    // Also work out the next couple of pictures, so their suggestion is there when they appear.
    const ids = [id];
    for (let k = 0, from = id; k < 2; k++) {
      const n = nextPending(from);
      if (!n || ids.includes(n)) break;
      ids.push(n);
      from = n;
    }
    let r;
    try {
      r = await api("/api/tag/suggest", { ids, round: T.round });
    } catch (e) {
      T.auto.on = false;
      toast(e.message, "error", 8000);
      render();
      return;
    }
    if (r.auto) T.auto = r.auto;
    for (const [sid, sv] of Object.entries(r.suggestions)) T.sugg.set(sid, { ...sv, key });
    const s = r.suggestions[id];
    const it = T.byId.get(T.cur);
    if (T.cur === id && T.view === "sort" && it) {
      if (!s) { $("#suggestBar").hidden = true; return; }
      if (key === T.tagVersion) renderSuggestion(it);
      else requestSuggestion(id);
    }
  }, 40);
}

function renderAuto() {
  const a = T.auto;
  $("#autoToggle").checked = !!a.on;
  $("#autoToggle").disabled = a.installed === false;
  let hint = "";
  if (a.installed === false) hint = "Needs a one-time download: quit, then run ./setup.sh (about 150 MB).";
  else if (a.error) hint = a.error;
  else if (a.working) hint = `Getting to know your pictures (for suggestions, duplicates and search)… ${a.ready.toLocaleString()} of ${a.total.toLocaleString()}`;
  else if (a.on) hint = "Uses your category names to start with, and learns from every picture you tag.";
  $("#autoHint").textContent = hint;
  $("#autoHint").hidden = !hint;
  $("#autoBulk").hidden = !a.on || !T.items.length || !T.cats.length || (curRound() || {}).kind === "rating";
  $("#searchInput").disabled = a.installed === false;
  if (a.installed === false) $("#searchInput").placeholder = "Search needs the auto-suggest model (run ./setup.sh once)";
}

async function loadDups() {
  if (T.auto.installed === false || !T.items.length) return;
  let r;
  try { r = await api("/api/tag/duplicates"); } catch { return; }
  T.dups = new Map();
  for (const g of r.groups) for (const id of g) T.dups.set(id, g);
  render();
}

let autoPoll = null;
function watchAuto() {
  clearTimeout(autoPoll);
  if (!T.auto.working) { loadDups(); return; }
  autoPoll = setTimeout(async () => {
    try { T.auto = await api("/api/tag/auto"); } catch { return; }
    renderAuto();
    watchAuto();
  }, 1500);
}

// ---------- backdrop & folders ----------
function renderBackdrop() {
  for (const target of [$("#sortStage"), $("#reviewGrid")]) {
    target.classList.remove("bd-checker", "bd-white", "bd-black");
    target.classList.add(`bd-${T.backdrop}`);
  }
  $$(".bd-seg button").forEach((b) => b.classList.toggle("active", b.dataset.bd === T.backdrop));
}
function setBackdrop(bd) {
  T.backdrop = bd;
  try { localStorage.setItem("bgs-tag-backdrop", bd); } catch { /* private mode */ }
  renderBackdrop();
}

const tilde = (p) => p.replace(/^\/Users\/[^/]+/, "~");
function renderFolders() {
  const d = $("#destDir");
  d.textContent = T.dest ? tilde(T.dest) : "Not set yet";
  d.title = T.dest;
  d.classList.toggle("unset", !T.dest);
}

function renderCatButtons(it) {
  const per = counts().per;
  /* suggested button is marked by renderSuggestion() */
  const wrap = $("#catButtons");
  wrap.classList.toggle("compact", T.cats.length > 10);
  queueMicrotask(() => { if (T.hold) $$(".cat-btn").forEach((b) => b.classList.toggle("holding", b.dataset.cat === T.hold.catId)); });
  wrap.classList.toggle("tiny", T.cats.length > 18);
  $("#sorter").classList.toggle("many", T.cats.length > 18); // two columns of buttons
  wrap.replaceChildren(...T.cats.map((c, i) => {
    const b = el("button", "cat-btn");
    b.type = "button";
    b.dataset.cat = c.id;
    b.style.setProperty("--c", c.color);
    b.classList.toggle("on", it.tags.includes(c.id));
    const k = keyFor(i);
    if (k) b.append(el("kbd", null, k));
    b.append(el("span", "cat-name", c.name), el("span", "cat-count", per[c.id].toLocaleString()));
    b.title = k ? `Tag as ${c.name} (${k}) · Shift-click or ⇧${k} to add it as an extra tag` : `Tag as ${c.name} · Shift-click to add it as an extra tag`;
    return b;
  }));
}

const prefetched = new Set();
function prefetch(fromId) {
  // Warm up the next few pictures so each click feels instant.
  let id = fromId;
  for (let k = 0; k < 4; k++) {
    const it = T.items[(T.items.findIndex((x) => x.id === id) + 1) % T.items.length];
    if (!it) return;
    id = it.id;
    if (!isPending(it) || prefetched.has(id)) continue;
    prefetched.add(id);
    const im = new Image();
    im.src = imgUrl(id, "large");
  }
}

function renderDone() {
  const c = counts();
  const multi = T.rounds.filter((r) => r.categories.length).length > 1;
  const i = T.rounds.findIndex((r) => r.id === T.round);
  // The next round that still has pictures to sort (after this one, then wrapping round).
  const next = [...T.rounds.slice(i + 1), ...T.rounds.slice(0, i)].find((r) => r.categories.length && roundCounts(r).pending);
  $("#doneCard").hidden = false;
  $("#doneCard").classList.toggle("more-rounds", !!next);
  $("#doneTitle").textContent = !multi ? (c.skipped ? "Everything else is sorted" : "All sorted")
    : next ? (() => {
      const left = T.rounds.filter((r) => r.categories.length && roundCounts(r).pending).length;
      return `Round ${i + 1} (${curRound().name}) is done. ${left === 1 ? "One more round" : `${left} more rounds`} to go`;
    })()
    : "Every round is sorted";
  $("#doneText").textContent = c.skipped
    ? `${plural(c.tagged, "picture")} tagged in ${multi ? curRound().name : "this round"}. You skipped ${c.skipped.toLocaleString()}.`
    : `All ${plural(c.tagged, "picture")} are tagged${multi ? ` in ${curRound().name}` : ""}.`;
  $("#doneCounts").replaceChildren(...T.cats.map((cat) => {
    const d = el("span", "done-count");
    d.append(chip(cat), el("b", null, c.per[cat.id].toLocaleString()));
    return d;
  }));
  // Where every round stands, so finishing one round doesn't look like finishing everything.
  const st = $("#roundStatus");
  st.hidden = !multi;
  st.replaceChildren(...T.rounds.filter((r) => r.categories.length).map((r) => {
    const rc = roundCounts(r);
    const n = T.rounds.indexOf(r) + 1;
    const row = el("div", `rs-row${r.id === T.round ? " current" : ""}${rc.pending ? "" : " complete"}`);
    const pct = T.items.length ? Math.round((100 * rc.tagged) / T.items.length) : 0;
    const bar = el("div", "rs-bar");
    const fill = el("div");
    fill.style.width = `${pct}%`;
    bar.append(fill);
    const state = !rc.pending ? "✓ Done" : rc.tagged || rc.skipped ? `${rc.tagged.toLocaleString()} of ${T.items.length.toLocaleString()}` : "Not started";
    row.append(el("span", "rs-num", rc.pending ? String(n) : "✓"), el("b", "rs-name", r.name), bar, el("span", "rs-state", state));
    if (rc.pending && r.id !== T.round) {
      const go = el("button", "small", rc.tagged ? "Continue" : "Start");
      go.type = "button";
      go.dataset.round = r.id;
      row.append(go);
    } else row.append(el("span", "rs-spacer"));
    return row;
  }));
  $("#nextRound").hidden = !next;
  if (next) {
    $("#nextRound").textContent = `Next round: ${T.rounds.indexOf(next) + 1}. ${next.name} →`;
    $("#nextRound").dataset.round = next.id;
  }
  const sk = $("#doSkipped");
  sk.hidden = !c.skipped;
  sk.textContent = `Go through the ${plural(c.skipped, "skipped picture")}`;
}

function reviewList() {
  const groups = [];
  const seen = new Set();
  for (const it of T.items) {
    const g = T.dups.get(it.id);
    if (g && !seen.has(g[0])) { seen.add(g[0]); groups.push(g.filter((x) => T.byId.has(x))); }
  }
  const pred = {
    all: () => true,
    untagged: (it) => !it.tags.length,
    auto: (it) => it.auto,
  }[T.filter] || ((it) => it.tags.includes(T.filter));
  let shown;
  if (T.filter === "dups") shown = groups.flat().map((id) => T.byId.get(id));
  else shown = T.items.filter(pred);
  if (T.search) {
    shown = shown.filter((it) => T.search.rank.has(it.id));
    shown.sort((a, b) => T.search.rank.get(a.id) - T.search.rank.get(b.id));
  }
  return { shown, groups };
}

function renderReview() {
  const c = counts();
  const { shown, groups } = reviewList();
  const autoN = T.items.filter((it) => it.auto).length;
  const f = $("#reviewFilters");
  const defs = [["all", "All", T.items.length], ["untagged", "Untagged", c.pending + c.skipped],
    ...(autoN ? [["auto", "Auto-tagged, to check", autoN]] : []),
    ...(groups.length ? [["dups", "Duplicates", groups.length]] : []),
    ...T.cats.map((cat) => [cat.id, cat.name, c.per[cat.id], cat.color])];
  if (!defs.some((d) => d[0] === T.filter)) { T.filter = "all"; return renderReview(); }
  f.replaceChildren(...defs.map(([key, label, n, colour]) => {
    const b = el("button", key === T.filter ? "active" : "");
    b.type = "button";
    b.dataset.filter = key;
    if (colour) { const dot = el("i", "dot"); dot.style.background = colour; b.append(dot); }
    b.append(label, el("span", null, ` ${n.toLocaleString()}`));
    return b;
  }));
  const groupIndex = new Map();
  groups.forEach((g, i) => g.forEach((id) => groupIndex.set(id, i)));
  const grid = $("#reviewGrid");
  const old = new Map($$(".card", grid).map((card) => [card.dataset.id, card]));
  grid.replaceChildren(...shown.map((it) => {
    let card = old.get(it.id);
    if (!card) {
      card = el("div", "card");
      card.tabIndex = 0;
      card.dataset.id = it.id;
      const th = el("div", "thumb");
      const im = el("img");
      im.loading = "lazy";
      im.alt = "";
      im.src = imgUrl(it.id, "thumb");
      im.addEventListener("error", () => { th.classList.add("no-preview"); im.remove(); });
      th.append(im);
      const body = el("div", "card-body");
      body.append(el("div", "name", it.name), el("div", "sub"), el("div", "chips"));
      card.append(th, body);
    }
    card.querySelector(".sub").textContent = it.folder;
    card.querySelector(".chips").replaceChildren(...chipsFor(it),
      ...(it.skipped && !it.tags.length ? [el("span", "tag-chip skipped", "Skipped")] : []));
    const gi = groupIndex.get(it.id);
    card.classList.toggle("dup-a", T.filter === "dups" && gi % 2 === 0);
    card.classList.toggle("dup-b", T.filter === "dups" && gi % 2 === 1);
    return card;
  }));
  $("#reviewEmpty").hidden = shown.length > 0;
  $("#reviewEmpty").textContent = T.search ? `Nothing here matches “${T.search.q}”.` : "Nothing here.";
  const cat = catById(T.filter);
  const send = $("#sendBtn");
  send.hidden = !cat || !shown.length;
  if (cat) send.textContent = `Remove backgrounds for these ${shown.length.toLocaleString()} →`;
  const qb = $("#queueBtn");
  qb.hidden = !shown.length;
  qb.textContent = T.filter === "auto" ? `Check them one by one →` : `Go through these ${shown.length.toLocaleString()} one by one →`;
  $("#confirmAllBtn").hidden = T.filter !== "auto" || !shown.length;
  $("#searchInfo").textContent = T.search ? `${T.search.rank.size.toLocaleString()} ${T.search.rank.size === 1 ? "match" : "matches"} for “${T.search.q}”, best first` : "";
}

// ---------- categories (sidebar) ----------
function renderRounds() {
  const tabs = $("#roundTabs");
  const r = curRound();
  tabs.replaceChildren(...T.rounds.map((x, i) => {
    const b = el("button", `round-tab${x.id === T.round ? " active" : ""}`);
    b.type = "button";
    b.dataset.round = x.id;
    b.setAttribute("role", "tab");
    b.append(el("span", "step", String(i + 1)), el("b", null, x.name),
      el("small", null, x.kind === "rating" ? "★ 1–5" : plural(x.categories.length, "category").replace("categorys", "categories")));
    return b;
  }));
  if (T.rounds.length < 3) {
    const add = el("button", "round-add", "+ Add a round");
    add.type = "button";
    add.dataset.add = "tags";
    add.title = "Sort the same pictures again by something else, e.g. place first, then content";
    tabs.append(add);
    if (!T.rounds.some((x) => x.kind === "rating")) {
      const star = el("button", "round-add", "+ Star rating");
      star.type = "button";
      star.dataset.add = "rating";
      star.title = "A round where you rate each picture 1–5 stars";
      tabs.append(star);
    }
  }
  const nameBox = $("#roundName");
  if (document.activeElement !== nameBox || nameBox.dataset.round !== r.id) nameBox.value = r.name;
  nameBox.dataset.round = r.id;
  const i = T.rounds.indexOf(r);
  $("#roundEarlier").disabled = i <= 0;
  $("#roundLater").disabled = i >= T.rounds.length - 1;
  $("#roundDelete").disabled = T.rounds.length < 2;
  $("#roundHead").hidden = T.rounds.length < 2 && r.kind !== "rating";
  const rating = r.kind === "rating";
  $("#ratingNote").hidden = !rating;
  $("#setsRow").hidden = $("#catForm").hidden = $("#catHint").hidden = rating;
  $(".page[data-page='2'] .page-lead").innerHTML = rating
    ? "Rate each picture from one to five stars."
    : "Each picture gets one of these (or more). Their keys follow this order along the keyboard: <b>1</b>–<b>0</b>, then <b>Q</b>–<b>P</b>, <b>A</b>–<b>L</b> and <b>Z</b>–<b>M</b> (up to 36).";
}

function renderCatList() {
  const per = counts().per;
  const ul = $("#catList");
  if (ul.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return; // don't fight typing
  if (curRound().kind === "rating") { // fixed stars: nothing to edit
    ul.replaceChildren(...T.cats.map((c, i) => {
      const li = el("li", "cat-row");
      li.append(el("kbd", null, keyFor(i)), el("span", "cat-input stars", c.name), el("span", "cat-n", per[c.id] ? per[c.id].toLocaleString() : ""));
      return li;
    }));
    return;
  }
  ul.replaceChildren(...T.cats.map((c, i) => {
    const li = el("li", "cat-row");
    li.dataset.id = c.id;
    const dot = el("button", "cat-dot");
    dot.type = "button";
    dot.style.background = c.color;
    dot.title = "Change colour";
    dot.dataset.act = "colour";
    const k = el("kbd", null, keyFor(i));
    if (!keyFor(i)) k.style.visibility = "hidden";
    const name = el("input", "cat-input");
    name.type = "text";
    name.value = c.name;
    name.maxLength = 60;
    name.setAttribute("aria-label", "Category name");
    const n = el("span", "cat-n", per[c.id] ? per[c.id].toLocaleString() : "");
    const up = el("button", "icon-btn", "↑");
    up.type = "button"; up.dataset.act = "up"; up.title = "Move up"; up.disabled = i === 0;
    const down = el("button", "icon-btn", "↓");
    down.type = "button"; down.dataset.act = "down"; down.title = "Move down"; down.disabled = i === T.cats.length - 1;
    const del = el("button", "icon-btn del", "×");
    del.type = "button"; del.dataset.act = "delete"; del.title = "Delete category";
    li.append(dot, k, name, n, up, down, del);
    return li;
  }));
}

async function saveCats(cats) {
  const r = await act(() => api("/api/tag/categories", { categories: cats, round: T.round }));
  if (r) setState(r); // deleting a category untags its pictures, so take the whole state
  render();
}

function addCategories(text) {
  const names = text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  const have = new Set(T.cats.map((c) => c.name.toLowerCase()));
  const fresh = names.filter((n) => !have.has(n.toLowerCase()) && (have.add(n.toLowerCase()), true));
  if (!fresh.length) { if (names.length) toast("That category already exists."); return false; }
  saveCats([...T.cats, ...fresh.map((name) => ({ name }))]);
  return true;
}

// ---------- tagging actions ----------
const snapshot = (id) => { const it = T.byId.get(id); return { id, round: T.round, tags: it.tags, skipped: it.skipped, auto: it.auto }; };

async function setMany(changes) {
  // Optimistic: the next picture appears at once; the server confirms in the background.
  const before = changes.map((c) => T.byId.get(c.id));
  for (const c of changes) {
    c.round = c.round || T.round;
    const it = T.byId.get(c.id);
    const rnd = T.rounds.find((x) => x.id === c.round) || curRound();
    const ids = new Set(rnd.categories.map((x) => x.id));
    const all = [...it.allTags.filter((t) => !ids.has(t)), ...c.tags];
    if (all.join() !== it.allTags.join()) T.tagVersion++;
    const sk = it.skippedRounds.filter((x) => x !== c.round).concat(c.skipped ? [c.round] : []);
    replaceItem(view({ ...raw(it), tags: all, skipped: sk, auto: !!c.auto && c.tags.length > 0 }));
  }
  const saving = changes.length === 1 && !changes[0].auto
    ? api("/api/tag/set", changes[0]).then((r) => [r])
    : api("/api/tag/set-many", { items: changes }).then((r) => r.items);
  T.lastSave = saving.catch(() => {});
  try {
    for (const it of await saving) replaceItem(view(it));
  } catch (e) {
    before.forEach(replaceItem);
    toast(`Couldn't save: ${e.message}`, "error", 7000);
    render();
  }
}
const setItem = (id, tags, skipped) => setMany([{ id, tags, skipped }]);

function remember(ids, focus) {
  T.undo.push({ items: ids.map(snapshot), focus });
  if (T.undo.length > 300) T.undo.shift();
}

function go(id, fromReview = false) {
  T.fromReview = fromReview;
  if (T.cur && T.cur !== id) T.history.push(T.cur);
  if (T.history.length > 500) T.history.shift();
  T.forward = [];
  T.cur = id;
  render();
}

// Like a browser: after going back, moving on steps forward through the pictures you'd already
// seen, one at a time, before jumping to the next one that still needs a tag.
function forwardOrNext(it) {
  const next = T.forward.pop();
  if (next && T.byId.has(next)) {
    T.history.push(T.cur);
    T.cur = next;
    render();
  } else {
    go(nextPending(it.id));
  }
}

function advance(it) {
  if (T.queue) groupOf(it.id).forEach((id) => T.queue.done.add(id)); // its copies were tagged too
  if (T.fromReview) { backToReview(); return; }
  forwardOrNext(it);
}

function tagWith(catId, extra) {
  const it = T.cur && T.byId.get(T.cur);
  if (!it || !T.imgReady) return; // never tag a picture that isn't on screen yet
  const group = groupOf(it.id); // near-identical copies get the same tags
  remember(group, it.id);
  if (extra) {
    const tags = it.tags.includes(catId) ? it.tags.filter((t) => t !== catId) : [...it.tags, catId];
    setMany(group.map((id) => ({ id, tags, skipped: false })));
    render();
    return;
  }
  setMany(group.map((id) => ({ id, tags: [catId], skipped: false })));
  flash(catById(catId));
  advance(it);
}

function keepTags() {
  // Enter on a tagged picture: an auto-tag becomes yours; then move on.
  const it = T.cur && T.byId.get(T.cur);
  if (!it || !it.tags.length || !T.imgReady) return;
  if (it.auto) {
    const group = groupOf(it.id).filter((id) => T.byId.get(id).auto);
    remember(group, it.id);
    setMany(group.map((id) => ({ id, tags: T.byId.get(id).tags, skipped: false })));
    flash(catById(it.tags[0]));
  }
  advance(it);
}

function backToReview() {
  T.fromReview = false;
  T.view = "review";
  render();
}

function skip() {
  const it = T.cur && T.byId.get(T.cur);
  if (!it) return;
  if (isPending(it) && !T.queue) {
    const group = groupOf(it.id).filter((id) => isPending(T.byId.get(id)));
    remember(group, it.id);
    setMany(group.map((id) => ({ id, tags: [], skipped: true })));
  }
  if (T.queue) T.queue.done.add(it.id);
  forwardOrNext(it);
}

function back() {
  const id = T.history.pop();
  if (!id) return;
  T.fromReview = false;
  if (T.cur) T.forward.push(T.cur);
  T.cur = id;
  render();
}

function undo() {
  const u = T.undo.pop();
  if (!u) return;
  setMany(u.items);
  if (T.queue) T.queue.done.delete(u.focus);
  if (u.focus && T.cur !== u.focus && T.byId.has(u.focus)) {
    // Go back to that picture; once it's re-tagged, carry on from where you were.
    T.view = "sort";
    if (T.cur) T.forward.push(T.cur);
    if (T.history[T.history.length - 1] === u.focus) T.history.pop();
    T.cur = u.focus;
  }
  render();
}

function startQueue(label, ids) {
  if (!ids.length) return;
  T.queue = { label, ids, done: new Set() };
  T.forward = [];
  T.step = 3;
  T.view = "sort";
  T.fromReview = false;
  T.cur = null;
  go(ids[0]);
}

function finishQueue(completed) {
  const label = T.queue && T.queue.label;
  T.queue = null;
  T.view = "review";
  if (completed && label) toast(`${label}: all done.`);
  render();
}

// ---------- auto-tag the confident ones ----------
async function autoTagConfident() {
  const threshold = Number($("#autoThresh").value);
  const dry = await act(() => api("/api/tag/auto-tag", { threshold, apply: false, round: T.round }));
  if (!dry) return;
  const later = dry.not_ready ? `\n\n${plural(dry.not_ready, "picture")} are still being analysed and were left out; you can run this again in a moment.` : "";
  if (!dry.count) {
    toast(`Nothing it's ${Math.round(threshold * 100)}% sure about yet. Tag a few more by hand, or lower the bar.${later ? " Some pictures are still being analysed." : ""}`, "info", 7000);
    return;
  }
  const lines = T.cats.filter((c) => dry.per[c.id]).map((c) => `   ${c.name}: ${dry.per[c.id]}`).join("\n");
  if (!confirm(`Auto-tag ${dry.count.toLocaleString()} of the ${plural(dry.untagged, "untagged picture")}?\n\n${lines}\n\nThey're marked “auto” until you check them (Review → Auto-tagged), and you can undo this with Backspace (or ⌘Z).${later}`)) return;
  const r = await act(() => api("/api/tag/auto-tag", { threshold, apply: true, round: T.round }));
  if (!r) return;
  T.undo.push({ items: r.ids.map((id) => ({ id, round: T.round, tags: [], skipped: false })), focus: null });
  await reload();
  T.view = "review";
  T.filter = "auto";
  T.search = null;
  $("#searchInput").value = "";
  render();
  toast(`Auto-tagged ${plural(r.count, "picture")}. Check them here, or press Backspace to undo.`, "info", 7000);
}

// ---------- search ----------
let searchTimer = null;
function searchSoon() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 300);
}
async function runSearch() {
  const q = $("#searchInput").value.trim();
  if (!q) { T.search = null; renderReview(); return; }
  let r;
  try { r = await api("/api/tag/search", { q }); } catch (e) { toast(e.message, "error", 7000); return; }
  if ($("#searchInput").value.trim() !== q) return; // typed on meanwhile
  T.search = { q, rank: new Map(r.results.map((x, i) => [x.id, i])) };
  T.view = "review";
  render();
}

// ---------- zoom on the sorting picture ----------
function zoomIn(cx, cy) {
  const img = $("#sortImg");
  const box = $("#sortScroll").getBoundingClientRect();
  if (!img.naturalWidth || T.zoomed) return;
  const r = img.getBoundingClientRect();
  const fit = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
  const dw = img.naturalWidth * fit, dh = img.naturalHeight * fit;
  const left = r.left + (r.width - dw) / 2, top = r.top + (r.height - dh) / 2;
  const fx = Math.min(1, Math.max(0, ((cx ?? left + dw / 2) - left) / dw));
  const fy = Math.min(1, Math.max(0, ((cy ?? top + dh / 2) - top) / dh));
  const w = dw * 3, h = dh * 3;
  T.zoomed = true;
  $("#sortStage").classList.add("zoomed");
  img.style.width = `${w}px`;
  img.style.height = `${h}px`;
  const sc = $("#sortScroll");
  sc.scrollLeft = fx * w - ((cx ?? box.left + box.width / 2) - box.left);
  sc.scrollTop = fy * h - ((cy ?? box.top + box.height / 2) - box.top);
  const it = T.byId.get(T.cur);
  if (it) { // swap in the full-resolution picture
    const full = new Image();
    full.onload = () => { if (T.zoomed && T.cur === it.id) img.src = full.src; };
    full.src = imgUrl(it.id, "full");
  }
}
function zoomOut() {
  if (!T.zoomed) return;
  T.zoomed = false;
  $("#sortStage").classList.remove("zoomed");
  const img = $("#sortImg");
  img.style.width = img.style.height = "";
}

// ---------- press and hold to keep tagging ----------
// Holding a category's key (or button) tags the picture, then each next one, but only after it
// has been on screen for a moment, so you can see what you're tagging and let go in time.
const HOLD_DWELL = 450; // ms
let holdTimer = null;
function startHold(catId, key) {
  T.hold = { catId, key };
  $$(".cat-btn").forEach((b) => b.classList.toggle("holding", b.dataset.cat === catId));
}
function stopHold() {
  if (!T.hold) return;
  T.hold = null;
  clearTimeout(holdTimer);
  $$(".cat-btn.holding").forEach((b) => b.classList.remove("holding"));
}
function holdNext() { // a new picture has appeared
  clearTimeout(holdTimer);
  if (!T.hold) return;
  holdTimer = setTimeout(() => {
    if (T.hold && T.imgReady && T.step === 3 && T.view === "sort" && !$("#sorter").hidden) tagWith(T.hold.catId, false);
    else stopHold();
  }, HOLD_DWELL);
}

let flashTimer = null;
function flash(cat) {
  if (!cat || !T.showFlash) return;
  const f = $("#sortFlash");
  f.textContent = `→ ${cat.name}`;
  f.style.setProperty("--c", cat.color);
  f.hidden = false;
  f.classList.remove("go");
  void f.offsetWidth; // restart the animation
  f.classList.add("go");
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { f.hidden = true; }, 700);
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

// ---------- importing & exporting ----------
function reportAdd(r) {
  if (!r) return;
  const bits = [];
  bits.push(r.added ? `Added ${plural(r.added, "image")}` : "No new images found");
  if (r.remembered) bits.push(`${r.remembered.toLocaleString()} already tagged from before`);
  if (r.ignored) bits.push(`${plural(r.ignored, "other file")} ignored`);
  toast(bits.join(" · "));
  for (const p of (r.problems || []).slice(0, 3)) toast(p, "error", 7000);
}

async function addVia(kind) {
  const r = await withDialog(() => act(() => api("/api/pick", { kind })), kind === "tag-folder" ? "#addFolder" : "#addFiles");
  if (!r || r.cancelled) return;
  reportAdd(r);
  await reload();
  watchAuto();
}

async function reload() {
  setState(await api("/api/tag/state"));
  render();
}

async function chooseDest() {
  const pick = await withDialog(() => act(() => api("/api/pick", { kind: "tag-dest" })), "#chooseDest");
  if (!pick || pick.cancelled) return false;
  T.dest = pick.dest;
  renderFolders();
  return true;
}

async function rescan(manual) {
  const r = await act(() => api("/api/tag/rescan", {}));
  if (!r) return;
  setState(r.state);
  render();
  watchAuto();
  const { added, removed } = r.result;
  if (added || removed || manual) {
    const bits = [added ? `Found ${plural(added, "new image")}` : manual ? "No new images" : ""];
    if (removed) bits.push(`${plural(removed, "image")} no longer there, removed from the list`);
    toast(bits.filter(Boolean).join(" · "));
  }
}

async function copyIntoFolders() {
  if (!T.items.some((it) => it.allTags.length) && !$("#inclUntagged").checked) { toast("Tag some images first."); return; }
  if (!T.dest && !(await chooseDest())) return;
  const busy = toast("Copying…", "info", 600000);
  const levels = ($("#folderLayout").value || T.round).split(",");
  const r = await act(() => api("/api/tag/copy", { include_untagged: $("#inclUntagged").checked, levels }));
  busy.remove();
  if (!r) return;
  let msg = `Copied ${plural(r.copied, "image")} into category folders.`;
  if (r.already) msg += ` ${r.already.toLocaleString()} were already there.`;
  toast(msg, "info", 6000);
  for (const p of r.problems) toast(p, "error", 7000);
  act(() => api("/api/tag/reveal", { dest: r.dest }));
}

async function finderTags(remove) {
  // Every round counts: a picture tagged in any round gets Finder tags.
  const tagged = T.items.filter((it) => it.allTags.length).length;
  const names = allCats().map((x) => x.name).join(", ");
  const msg = remove
    ? `Remove the Finder tags ${names} from the ${plural(T.items.length, "picture")} in this list? Other Finder tags are kept.`
    : `Add Finder tags to ${plural(tagged, "original file")}?\n\nThis only changes each file's tag labels (what you see in Finder's sidebar and search). The pictures themselves aren't changed, and you can remove the tags again later.`;
  if (!tagged && !remove) { toast("Tag some pictures first."); return; }
  if (!confirm(msg)) return;
  const r = await act(() => api("/api/tag/finder", { remove }));
  if (!r) return;
  toast(remove ? `Removed tags from ${plural(r.changed, "file")}.` : `Added Finder tags to ${plural(r.changed, "file")}.`, "info", 6000);
  for (const p of r.problems) toast(p, "error", 7000);
}

// ---------- wiring ----------
function wire() {
  $("#addFolder").addEventListener("click", () => addVia("tag-folder"));
  $("#addFiles").addEventListener("click", () => addVia("tag-files"));
  $$(".step-tab").forEach((b) => b.addEventListener("click", () => goStep(Number(b.dataset.step))));
  $$("[data-goto]").forEach((b) => b.addEventListener("click", () => goStep(Number(b.dataset.goto))));
  $("#recentList").addEventListener("click", async (e) => {
    const b = e.target.closest(".recent-card");
    if (!b) return;
    b.disabled = true;
    const r = await act(() => api("/api/tag/add-paths", { paths: [b.dataset.path] }));
    if (r) { reportAdd(r); await reload(); watchAuto(); renderRecent(); }
    b.disabled = false;
  });
  $("#rootList").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-folder]");
    if (!b) return;
    act(async () => {
      setState(await api("/api/tag/remove-folder", { folder: b.dataset.folder }));
      T.history = [];
      render();
      loadRecent();
    });
  });
  $("#setSelect").addEventListener("change", renderSets);
  $("#useSet").addEventListener("click", () => {
    const set = T.sets.find((x) => x.name === $("#setSelect").value);
    if (!set) return;
    const keepNames = new Set(set.categories.map((c) => c.name.toLowerCase()));
    const per = counts().per;
    const lost = T.cats.filter((c) => !keepNames.has(c.name.toLowerCase()) && per[c.id]);
    if (lost.length && !confirm(`Switch to “${set.name}”?\n\n${lost.map((c) => `${c.name}: ${plural(per[c.id], "picture")} will lose this tag`).join("\n")}\n\nCategories with the same name keep their tags.`)) return;
    act(async () => { setState(await api("/api/tag/sets", { action: "use", name: set.name, round: T.round })); T.sugg.clear(); render(); toast(`Using “${set.name}”.`); });
  });
  $("#deleteSet").addEventListener("click", () => {
    const name = $("#setSelect").value;
    if (!name || !confirm(`Delete the saved set “${name}”? Your current categories and tags aren't affected.`)) return;
    act(async () => { setState(await api("/api/tag/sets", { action: "delete", name })); render(); });
  });
  $("#saveSet").addEventListener("click", () => {
    const name = (prompt("Name for this set of categories (for example: Souvenirs):", $("#setSelect").value || "") || "").trim();
    if (!name) return;
    if (T.sets.some((x) => x.name.toLowerCase() === name.toLowerCase()) && !confirm(`Replace the saved set “${name}”?`)) return;
    act(async () => { setState(await api("/api/tag/sets", { action: "save", name, round: T.round })); render(); $("#setSelect").value = name; renderSets(); toast(`Saved “${name}”.`); });
  });
  const switchRound = (rid) => { useRound(rid); T.cur = null; T.queue = null; T.history = []; T.forward = []; render(); };
  $("#roundSeg").addEventListener("click", (e) => { const b = e.target.closest("button[data-round]"); if (b && !b.disabled) switchRound(b.dataset.round); });
  $("#nextRound").addEventListener("click", (e) => { T.view = "sort"; switchRound(e.currentTarget.dataset.round); });
  $("#roundStatus").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-round]");
    if (b) { T.view = "sort"; switchRound(b.dataset.round); }
  });
  $("#roundTabs").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.round) { switchRound(b.dataset.round); return; }
    const kind = b.dataset.add;
    act(async () => {
      setState(await api("/api/tag/rounds", { action: "add", kind, name: kind === "rating" ? "Rating" : `Round ${T.rounds.length + 1}` }));
      switchRound(T.rounds[T.rounds.length - 1].id);
      if (kind !== "rating") { $("#roundName").focus(); $("#roundName").select(); }
    });
  });
  $("#roundName").addEventListener("change", (e) => act(async () => {
    setState(await api("/api/tag/rounds", { action: "rename", round: T.round, name: e.target.value }));
    render();
  }));
  $("#roundName").addEventListener("keydown", (e) => { if (e.key === "Enter") e.target.blur(); });
  for (const [id, delta] of [["#roundEarlier", -1], ["#roundLater", 1]]) {
    $(id).addEventListener("click", () => act(async () => {
      setState(await api("/api/tag/rounds", { action: "move", round: T.round, delta }));
      render();
    }));
  }
  $("#roundDelete").addEventListener("click", () => {
    const r = curRound();
    const n = roundCounts(r).tagged;
    if (!confirm(`Delete the round “${r.name}”?${n ? ` ${plural(n, "picture")} will lose their ${r.name} tag.` : ""}`)) return;
    act(async () => {
      setState(await api("/api/tag/rounds", { action: "delete", round: r.id }));
      switchRound(T.rounds[0].id);
    });
  });
  $("#newBatch").addEventListener("click", () => {
    if (!confirm("Clear this list and start a new batch? Your pictures aren't touched, and their tags are remembered if you add them again.")) return;
    act(async () => {
      setState(await api("/api/tag/clear", {}));
      T.cur = null; T.history = []; T.forward = []; T.undo = []; T.queue = null; T.view = "sort";
      goStep(1);
    });
  });
  $("#resortFromStart").addEventListener("click", () => {
    const n = T.items.filter((it) => it.allTags.length).length;
    if (!confirm(`Remove every tag${T.rounds.length > 1 ? " (in every round)" : ""} from these ${plural(T.items.length, "picture")} and sort them again from the start?${n ? `\n\n${plural(n, "picture")} will lose their tags.` : ""}`)) return;
    act(async () => {
      setState(await api("/api/tag/clear", { forget_tags: true, round: "*" }));
      useRound((T.rounds.find((r) => r.categories.length) || T.rounds[0]).id);
      T.cur = null; T.history = []; T.forward = []; T.undo = []; T.queue = null; T.view = "sort";
      goStep(3);
    });
  });
  $("#goThroughAgain").addEventListener("click", () => {
    useRound((T.rounds.find((r) => r.categories.length) || T.rounds[0]).id);
    T.view = "sort";
    startQueue("Going through all again", T.items.map((it) => it.id));
  });
  $("#resortAll").addEventListener("click", () => startQueue("Going through all again", T.items.map((it) => it.id)));
  $("#clearList").addEventListener("click", () => {
    if (!confirm("Clear the list? Your pictures aren't touched, and their tags are remembered if you add them again.")) return;
    act(async () => { setState(await api("/api/tag/clear", {})); T.history = []; T.undo = []; render(); loadRecent(); });
  });
  $("#forgetTags").addEventListener("click", () => {
    const which = T.rounds.length > 1 ? ` ${curRound().name}` : "";
    if (!confirm(`Remove every${which} tag from the ${plural(T.items.length, "picture")} in this list and start this round again?`)) return;
    act(async () => { setState(await api("/api/tag/clear", { forget_tags: true, round: T.round })); T.cur = null; T.undo = []; render(); });
  });

  $("#rescanBtn").addEventListener("click", () => rescan(true));
  $("#chooseDest").addEventListener("click", chooseDest);
  $$(".bd-seg button").forEach((b) => b.addEventListener("click", () => setBackdrop(b.dataset.bd)));
  $("#suggestBar").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-cat], button[data-keep]");
    if (b && b.dataset.keep) keepTags();
    else if (b) tagWith(b.dataset.cat, false);
  });
  $("#autoTagBtn").addEventListener("click", autoTagConfident);
  $("#searchInput").addEventListener("input", searchSoon);
  $("#searchForm").addEventListener("submit", (e) => { e.preventDefault(); clearTimeout(searchTimer); runSearch(); });
  $("#searchInput").addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.target.value = ""; T.search = null; renderReview(); e.target.blur(); }
  });
  $("#queueBtn").addEventListener("click", () => {
    const { shown } = reviewList();
    const cat = catById(T.filter);
    const label = T.filter === "auto" ? "Checking auto-tags"
      : T.search ? `Going through “${T.search.q}”`
      : cat ? `Re-sorting ${cat.name}`
      : T.filter === "untagged" ? "Untagged pictures"
      : T.filter === "dups" ? "Duplicates" : "Going through all again";
    startQueue(label, shown.map((it) => it.id));
  });
  $("#confirmAllBtn").addEventListener("click", () => {
    const ids = T.items.filter((it) => it.auto).map((it) => it.id);
    if (!confirm(`Keep all ${plural(ids.length, "auto-tag")} as they are?`)) return;
    remember(ids, null);
    setMany(ids.map((id) => ({ id, tags: T.byId.get(id).tags, skipped: false })));
    T.filter = "all";
    render();
  });

  // Zoom: click the picture; drag to look around; click again (or Esc) to fit.
  const sc = $("#sortScroll");
  let drag = null;
  sc.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, l: sc.scrollLeft, t: sc.scrollTop, moved: false };
    if (T.zoomed) { sc.setPointerCapture(e.pointerId); sc.classList.add("panning"); }
  });
  sc.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (T.zoomed) { sc.scrollLeft = drag.l - dx; sc.scrollTop = drag.t - dy; }
  });
  sc.addEventListener("pointerup", (e) => {
    const d = drag;
    drag = null;
    sc.classList.remove("panning");
    if (!d || d.moved) return;
    if (T.zoomed) zoomOut();
    else if (e.target === $("#sortImg")) zoomIn(e.clientX, e.clientY);
  });
  $("#autoToggle").addEventListener("change", (e) => act(async () => {
    try {
      T.auto = await api("/api/tag/auto", { on: e.target.checked });
    } finally {
      renderAuto();
    }
    T.sugg.clear();
    render();
    watchAuto();
  }));

  $("#catForm").addEventListener("submit", (e) => {
    e.preventDefault();
    if (addCategories($("#catInput").value)) $("#catInput").value = "";
  });
  const list = $("#catList");
  list.addEventListener("change", (e) => {
    if (!e.target.classList.contains("cat-input")) return;
    const id = e.target.closest("li").dataset.id;
    const name = e.target.value.trim();
    if (!name) { e.target.value = catById(id).name; return; }
    saveCats(T.cats.map((c) => (c.id === id ? { ...c, name } : c)));
  });
  list.addEventListener("keydown", (e) => {
    if (e.target.classList.contains("cat-input") && (e.key === "Enter" || e.key === "Escape")) {
      if (e.key === "Escape") e.target.value = catById(e.target.closest("li").dataset.id).name;
      e.target.blur();
    }
  });
  list.addEventListener("focusout", () => setTimeout(renderCatList, 0));
  list.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const id = b.closest("li").dataset.id;
    const i = T.cats.findIndex((c) => c.id === id);
    const cats = [...T.cats];
    if (b.dataset.act === "up" && i > 0) [cats[i - 1], cats[i]] = [cats[i], cats[i - 1]];
    else if (b.dataset.act === "down" && i < cats.length - 1) [cats[i + 1], cats[i]] = [cats[i], cats[i + 1]];
    else if (b.dataset.act === "delete") {
      const n = counts().per[id];
      if (n && !confirm(`Delete “${T.cats[i].name}”? ${plural(n, "image")} will lose this tag.`)) return;
      cats.splice(i, 1);
    } else if (b.dataset.act === "colour") {
      const picker = $("#colourPicker");
      picker.value = T.cats[i].color;
      picker.onchange = () => saveCats(T.cats.map((c) => (c.id === id ? { ...c, color: picker.value } : c)));
      picker.click();
      return;
    } else return;
    saveCats(cats);
  });

  $("#catButtons").addEventListener("pointerdown", (e) => {
    const b = e.target.closest(".cat-btn");
    if (!b || e.button !== 0) return;
    e.preventDefault();
    tagWith(b.dataset.cat, e.shiftKey);
    if (!e.shiftKey) startHold(b.dataset.cat, "pointer");
  });
  $("#catButtons").addEventListener("click", (e) => { // Tab + Space/Enter on a button
    const b = e.target.closest(".cat-btn");
    if (b && e.detail === 0) tagWith(b.dataset.cat, e.shiftKey);
  });
  for (const ev of ["pointerup", "pointercancel"]) window.addEventListener(ev, () => { if (T.hold && T.hold.key === "pointer") stopHold(); });
  window.addEventListener("blur", stopHold);
  document.addEventListener("keyup", (e) => { if (T.hold && T.hold.key === e.code) stopHold(); });
  $("#flashToggle").checked = T.showFlash;
  $("#flashToggle").addEventListener("change", (e) => {
    T.showFlash = e.target.checked;
    try { localStorage.setItem("bgs-tag-flash", T.showFlash ? "on" : "off"); } catch { /* private mode */ }
    if (!T.showFlash) $("#sortFlash").hidden = true;
  });
  $("#skipBtn").addEventListener("click", skip);
  $("#nextBtn").addEventListener("click", skip);
  $("#backBtn").addEventListener("click", back);
  $("#undoBtn").addEventListener("click", undo);
  $("#sortName").addEventListener("click", () => T.cur && act(() => api("/api/tag/reveal", { id: T.cur })));

  const img = $("#sortImg");
  img.addEventListener("load", () => {
    T.imgReady = true;
    holdNext();
    clearTimeout(imgTimer);
    $("#sortLoading").hidden = true;
    img.classList.remove("loading");
  });
  img.addEventListener("error", () => {
    T.imgReady = true; // shows "couldn't open"; you can still skip or tag it by name
    stopHold();       // don't tag a picture you can't see
    clearTimeout(imgTimer);
    $("#sortLoading").hidden = true;
    if (img.dataset.src) $("#sortStage").classList.add("broken");
  });

  $$("#viewSeg button").forEach((b) => b.addEventListener("click", () => {
    T.fromReview = false;
    T.queue = null;
    T.view = b.dataset.view;
    if (T.view === "sort") T.cur = nextPending(null);
    render();
  }));
  $("#reviewFilters").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) { T.filter = b.dataset.filter; renderReview(); }
  });
  const openFromGrid = (card) => { T.view = "sort"; go(card.dataset.id, true); };
  $("#reviewGrid").addEventListener("click", (e) => { const c = e.target.closest(".card"); if (c) openFromGrid(c); });
  $("#reviewGrid").addEventListener("keydown", (e) => {
    const c = e.target.closest(".card");
    if (c && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openFromGrid(c); }
  });
  $("#sendBtn").addEventListener("click", async () => {
    const r = await act(() => api("/api/tag/send", { category: T.filter }));
    if (!r) return;
    const t = toast(`${r.added ? `Added ${plural(r.added, "image")} to` : "Those images are already in"} Remove backgrounds. Click here to go there.`, "info", 8000);
    t.style.cursor = "pointer";
    t.addEventListener("click", () => { location.href = "/"; });
  });

  $("#doSkipped").addEventListener("click", () => act(async () => {
    setState(await api("/api/tag/unskip", { round: T.round }));
    T.cur = null;
    render();
  }));
  $("#doneReview").addEventListener("click", () => { T.view = "review"; render(); });
  const csv = () => download(`/api/tag/csv?t=${encodeURIComponent(TOKEN)}`);
  $("#csvBtn").addEventListener("click", csv);
  $("#copyBtn").addEventListener("click", copyIntoFolders);
  $("#finderBtn").addEventListener("click", () => finderTags(false));
  $("#finderRemove").addEventListener("click", () => finderTags(true));

  $("#quitBtn").addEventListener("click", async () => {
    let running = false;
    try { running = !!(await api("/api/state")).run?.running; } catch { /* already stopped */ }
    if (!confirm(running ? "Background removal is still running. Quit anyway? Finished images are kept." : "Quit Background Studio? Your tags are saved.")) return;
    try { await api("/api/quit", {}); } catch { /* server is going away */ }
    const msg = el("div", "empty");
    msg.append(el("h3", null, "Background Studio has stopped."),
      el("p", null, "You can close this tab. To start again, double-click “Background Studio.command”."));
    document.body.replaceChildren(msg);
  });

  // Browsers never reveal where a dropped file lives, and tags need the real file.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    toast("To tag pictures where they are, use Choose a folder… (browsers don't share where dropped files live).", "info", 8000);
  });

  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea, select")) return;
    if (e.key === "/" && !STEP_NEEDS[3]() && !$("#searchInput").disabled) {
      e.preventDefault();
      T.step = 3;
      T.view = "review";
      render();
      $("#searchInput").focus();
      return;
    }
    if (T.step !== 3) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.repeat && e.key !== "ArrowLeft") { e.preventDefault(); return; } // a held key counts once
    if (e.key === "Backspace") { e.preventDefault(); undo(); return; }
    if (T.view !== "sort" || $("#sorter").hidden) return;
    const cat = catForKey(e.code);
    if (cat) {
      e.preventDefault();
      tagWith(cat.id, e.shiftKey);
      if (!e.shiftKey) startHold(cat.id, e.code); // keep holding to keep tagging
      return;
    }
    stopHold();
    if (e.key === "Escape" && T.zoomed) { e.preventDefault(); zoomOut(); }
    else if (e.key === "=" || e.key === "+") { e.preventDefault(); zoomIn(); }
    else if (e.key === "-") { e.preventDefault(); zoomOut(); }
    else if (e.key === "Escape" && T.queue) { e.preventDefault(); finishQueue(false); }
    else if (e.key === "Escape" && T.fromReview) { e.preventDefault(); backToReview(); }
    else if (e.key === " " || e.key === "ArrowRight") { e.preventDefault(); skip(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); back(); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const it = T.byId.get(T.cur);
      const s = currentSuggestion(it);
      if (s) tagWith(s.cat, false);
      else if (it && it.tags.length) keepTags();
    } else if (e.code === "Backslash") {
      const order = ["checker", "white", "black"];
      setBackdrop(order[(order.indexOf(T.backdrop) + 1) % order.length]);
    }
  });
}

wire();
reload().then(() => {
  T.step = defaultStep();
  if (T.step === 3) useRound(firstOpenRound());
  if (T.step === 1) loadRecent();
  render();
  if (T.roots.length) rescan(false); else watchAuto();
})
  .catch((e) => toast(e.message, "error", 7000));
