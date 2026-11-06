"use strict";
// Lite demo: stands in for the app's local Python server so the real interface (app.js,
// editor.js) runs as a static page. Requests to /api/... are answered here from the demo
// images in demo/, whose AI masks were made in advance by the real models; lite-engine.js
// does the rest of the processing in the browser. Loaded before app.js.

const LITE = (() => {
  const REPO = "https://github.com/jkw2lo/background_studio";
  const OUT_DIR = "In this browser tab";
  const MODEL_INFO = [
    { name: "isnet-general-use", label: "IS-Net General", blurb: "Recommended. Good quality on products, people and objects.", size_mb: 179, license: "Apache-2.0" },
    { name: "birefnet-general-lite", label: "BiRefNet Lite", blurb: "Sharper edges and fine detail. About 2-3x slower.", size_mb: 224, license: "MIT" },
    { name: "birefnet-general", label: "BiRefNet (best quality)", blurb: "Highest quality, especially hair and fine detail. Slow on CPU.", size_mb: 973, license: "MIT" },
    { name: "u2net", label: "U²-Net (classic)", blurb: "The original rembg model. Fast and dependable.", size_mb: 176, license: "Apache-2.0" },
  ];
  const MODE_LABELS = { auto: "auto", item: "cut-out item", ink: "ink on paper", photo: "photo subject", card: "card (trimmed & straightened)", keep: "kept as is" };

  const st = {
    version: 1,
    settings: { output_dir: OUT_DIR, background: "transparent", custom_color: "#f2efe9", model: "isnet-general-use", skip_existing: true, clean_edges: false, mode: "auto", trim: true },
    items: [],
    run: null,
    queue: [],
    warmModels: new Set(),
  };
  let demo = null;
  const demoReady = fetch("demo/demo.json").then((r) => r.json()).then((d) => { demo = d; return d; });
  const bump = () => { st.version++; };
  const now = () => Date.now() / 1000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const say = (msg, kind = "info", ms = 6000) => (typeof toast === "function" ? toast(msg, kind, ms) : console.info(msg));

  // ---------- demo assets ----------
  const images = new Map();
  function loadImg(src) {
    if (!images.has(src)) {
      images.set(src, new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = () => rej(new Error(`Could not load ${src}`));
        im.src = src;
      }));
    }
    return images.get(src);
  }
  const bases = new Map(), masks = new Map();
  async function baseOf(d) {
    if (!bases.has(d.id)) bases.set(d.id, LiteEngine.fromImage(await loadImg(`demo/${d.id}/orig.jpg`)));
    return bases.get(d.id);
  }
  async function maskOf(d, model) {
    const key = `${d.id}/${model}`;
    if (!masks.has(key)) masks.set(key, LiteEngine.maskFromImage(await loadImg(`demo/${d.id}/mask-${model}.png`)));
    return masks.get(key);
  }
  const preOf = (d, model) => ({ auto: d.auto[model] || d.auto[demo.models[0]], cardQuad: d.card_quad });

  async function renderItem(it, mode, adjust, opts = {}) {
    const s = st.settings;
    const model = demo.models.includes(s.model) ? s.model : demo.models[0];
    const [base, mask] = await Promise.all([baseOf(it.demo), maskOf(it.demo, model)]);
    return LiteEngine.render(base, mode, adjust, () => mask, s.clean_edges, preOf(it.demo, model), opts.geometryOnly);
  }

  // ---------- items ----------
  function publicItem(it) {
    return {
      id: it.id, source: it.source, rel: it.rel, origin: "disk", out_rel: it.out_rel, status: it.status,
      error: it.error, note: it.note, seconds: it.seconds, variant_rel: it.variant_rel,
      mode_override: it.mode_override, used_mode: it.used_mode, out_dir: it.out_dir, adjust: it.adjust,
      edits_sha: it.edits ? "lite" : "", crop_used: it.crop_used, size: it.size, finished_at: it.finished_at,
      name: it.rel.split("/").pop(), has_edits: !!it.edits,
    };
  }

  function addDemos(ids) {
    let added = 0, dup = 0;
    for (const id of ids) {
      if (st.items.some((x) => x.demo.id === id)) { dup++; continue; }
      const d = demo.images.find((x) => x.id === id);
      const photo = d.folder === "photos";
      st.items.push({
        id: `lite-${id}`, demo: d, rel: d.rel, source: `demo/${d.rel}`,
        out_rel: d.rel.replace(/\.[^.]+$/, ".png"), status: "queued", error: "", note: "", seconds: 0,
        variant_rel: "", used_mode: "", out_dir: "", adjust: {}, edits: null, crop_used: null,
        size: d.size, finished_at: 0, result: null, sig: null, variants: new Set(),
        // Auto is made for scans; the sample photos come set to Photo, as you'd set them yourself.
        mode_override: photo && st.settings.mode !== "photo" ? "photo" : "", preset: photo,
      });
      added++;
    }
    bump();
    return { added, duplicates: dup, ignored: 0, problems: [] };
  }

  function counts() {
    const c = { queued: 0, processing: 0, done: 0, skipped: 0, failed: 0 };
    for (const it of st.items) c[it.status]++;
    return c;
  }

  function runPublic() {
    const r = st.run;
    if (!r) return null;
    const completed = r.done + r.skipped + r.failed;
    const avg = r.infer_count ? r.infer_seconds / r.infer_count : null;
    return {
      ...r, completed,
      eta_seconds: avg && r.running ? Math.round(avg * Math.max(r.total - completed, 0)) : null,
      elapsed: Math.round(((r.finished_at || now()) - r.started_at) * 10) / 10,
    };
  }

  function snapshot() {
    return {
      version: st.version, settings: { ...st.settings }, items: st.items.map(publicItem), counts: counts(),
      run: runPublic(), models: MODEL_INFO.map((m) => ({ ...m, installed: demo.models.includes(m.name) })),
      network: null,  // the privacy badge is the lite one (see dress())
    };
  }

  // ---------- processing ----------
  const variantDir = (s) => (s.background === "white" || s.background === "black" ? `on-${s.background}`
    : s.background === "custom" ? `on-${s.custom_color.slice(1).toLowerCase()}` : "");
  const sigOf = (it, s) => JSON.stringify([s.model, s.clean_edges, it.mode_override || s.mode, it.adjust, it.edits, s.trim]);

  function start({ ids, retry_failed } = {}) {
    if (st.run && st.run.running) throw new Error("A batch is already running.");
    let queued;
    if (ids && ids.length) {
      for (const it of st.items) if (ids.includes(it.id) && it.status === "failed") it.status = "queued";
      queued = st.items.filter((it) => ids.includes(it.id) && it.status === "queued").map((it) => it.id);
      if (!queued.length) throw new Error("Nothing to retry.");
    } else {
      if (retry_failed) for (const it of st.items) if (it.status === "failed") it.status = "queued";
      queued = st.items.filter((it) => it.status === "queued").map((it) => it.id);
    }
    if (!queued.length) {
      for (const it of st.items) { it.status = "queued"; it.error = it.note = ""; }
      queued = st.items.map((it) => it.id);
    }
    if (!queued.length) throw new Error("Add some images first.");
    const s = { ...st.settings };
    st.run = {
      total: queued.length, done: 0, skipped: 0, failed: 0, started_at: now(), finished_at: 0, running: true,
      cancel_requested: false, cancelled: false, phase: "starting", current: "", infer_seconds: 0, infer_count: 0, fatal: "",
    };
    st.queue = queued;
    bump();
    worker(st.run, s);
  }

  async function worker(run, s) {
    await sleep(250);
    if (!st.warmModels.has(s.model)) {  // the app loads the model with the first image
      run.phase = "loading-model";
      bump();
      await sleep(1200);
      st.warmModels.add(s.model);
    }
    run.phase = "processing";
    bump();
    while (st.queue.length) {
      if (run.cancel_requested) { run.cancelled = true; break; }
      const it = st.items.find((x) => x.id === st.queue[0]);
      st.queue.shift();
      if (!it) continue;
      it.status = "processing";
      run.current = it.rel;
      bump();
      const t0 = performance.now();
      try {
        const status = await process(it, s);
        it.status = status;
        run[status === "done" ? "done" : "skipped"]++;
      } catch (e) {
        it.status = "failed";
        it.error = e.message;
        run.failed++;
      }
      const secs = (performance.now() - t0) / 1000;
      if (it.status === "done") {
        it.seconds = secs;
        run.infer_seconds += secs;
        run.infer_count++;
      }
      bump();
    }
    run.running = false;
    run.finished_at = now();
    run.phase = "finished";
    run.current = "";
    bump();
  }

  async function process(it, s) {
    const vdir = variantDir(s);
    const sig = sigOf(it, s);
    if (s.skip_existing && it.result && it.sig === sig) {
      it.variant_rel = vdir ? `${vdir}/${it.out_rel}` : "";
      await sleep(150);
      if (vdir && !it.variants.has(vdir)) { it.variants.add(vdir); it.note = "Reused existing cutout, added background"; }
      else it.note = "Already processed — skipped";
      return "skipped";
    }
    const t0 = performance.now();
    const mode = it.mode_override || s.mode;
    const r = await renderItem(it, mode, it.adjust);
    let cut = r.cut;
    if (it.edits) cut = LiteEngine.applyEdits(cut, r.frame, await loadImg(it.edits));
    if (s.trim) cut = LiteEngine.trimTransparent(cut);
    // The AI step ran ahead of time; wait about as long as it takes, so the batch feels real.
    if (r.used === "item" || r.used === "photo") {
      const model = demo.models.includes(s.model) ? s.model : demo.models[0];
      const target = Math.min(4, Math.max(0.6, (it.demo.seconds[model] || 1) * 0.45)) * 1000;
      await sleep(Math.max(0, target - (performance.now() - t0)));
    } else await sleep(300);

    const blob = await LiteEngine.toBlob(cut);
    if (it.result) URL.revokeObjectURL(it.result.url);
    it.result = { url: URL.createObjectURL(blob), blob, cut };
    const notes = [];
    if (mode === "auto" && r.why) notes.push(`Auto chose ${MODE_LABELS[r.used]}: ${r.why}`);
    if (Object.keys(it.adjust).length || it.edits || (it.mode_override && !it.preset)) notes.push("Manually adjusted");
    it.note = notes.join(" · ");
    it.size = [cut.w, cut.h];
    it.used_mode = r.used;
    it.crop_used = r.quad;
    it.variant_rel = vdir ? `${vdir}/${it.out_rel}` : "";
    it.variants = new Set(vdir ? [vdir] : []);
    it.out_dir = s.output_dir;
    it.finished_at = now();
    it.sig = sig;
    return "done";
  }

  function saveAdjustments(b) {
    const it = st.items.find((x) => x.id === b.id);
    if (!it) throw new Error("Unknown image");
    if (it.status === "processing") throw new Error("This image is being processed right now. Try again in a moment.");
    if (b.edits_action === "replace") it.edits = b.edits;
    else if (b.edits_action === "clear") it.edits = null;
    it.mode_override = b.mode === st.settings.mode ? "" : b.mode;
    it.preset = false;
    it.adjust = clean(b.adjust || {});
    it.status = "queued";
    it.error = it.note = "";
    bump();
    if (st.run && st.run.running) {
      if (!st.queue.includes(it.id)) { st.queue.push(it.id); st.run.total++; }
      return;
    }
    start({ ids: [it.id] });
  }

  // Drop defaults, as engine.sanitize_adjust does, so {} means "automatic".
  function clean(a) {
    const out = {};
    for (const [k, v] of Object.entries(a)) {
      if (v === null || v === undefined || v === false && (k === "autotone" || k === "invert")) continue;
      if (typeof v === "number" && Math.abs(v) < 1e-6) continue;
      out[k] = v;
    }
    return out;
  }

  // ---------- previews ----------
  let previewUrls = [], olderUrls = [];
  async function preview(b) {
    const it = st.items.find((x) => x.id === b.id);
    if (!it) throw new Error("Unknown image");
    const r = await renderItem(it, b.mode, b.adjust || {}, { geometryOnly: !!b.geometry_only });
    const url = async (img) => URL.createObjectURL(await LiteEngine.toBlob(img));
    const toned = r.frame !== r.orig;
    const out = {
      cut: await url(r.cut), frame: await url(r.frame), orig: toned ? await url(r.orig) : null,
      used: r.used, why: r.why, quad: r.quad, width: r.cut.w, height: r.cut.h,
    };
    olderUrls.forEach((u) => URL.revokeObjectURL(u));  // the editor has long since loaded these
    olderUrls = previewUrls;
    previewUrls = [out.cut, out.frame, out.orig].filter(Boolean);
    return out;
  }

  // ---------- the stand-in API ----------
  const fullAppOnly = (what) => say(`${what} is part of the full app. In this demo your results stay in this tab: use Download ZIP to save them.`);
  let chooserOpen = null;

  async function handle(method, path, params, body) {
    await demoReady;
    if (path === "state") {
      if (params.get("v") === String(st.version)) return { version: st.version, unchanged: true };
      return snapshot();
    }
    if (path === "info") return { models: snapshot().models, network: null, formats: [".jpg", ".png", ".heic", ".webp", ".tiff", ".bmp"] };
    if (path === "settings") {
      const changes = { ...body };
      delete changes.output_dir;
      if (changes.model && !demo.models.includes(changes.model)) throw new Error("That model isn't part of the demo.");
      Object.assign(st.settings, changes);
      // A photo set to Photo only because of the lite default follows the batch setting again.
      if (changes.mode) for (const it of st.items) if (it.preset) it.mode_override = changes.mode === "photo" ? "" : "photo";
      bump();
      return { ok: true, settings: { ...st.settings } };
    }
    if (path === "pick") {
      if (body.kind === "output") { fullAppOnly("Choosing a folder on your Mac"); return { cancelled: true }; }
      if (chooserOpen) return { busy: true };
      const ids = await chooseDemos();
      return ids ? addDemos(ids) : { cancelled: true };
    }
    if (path === "add-paths" || path === "upload") {
      return {
        added: 0, ignored: 0, duplicates: 0,
        problems: ["Lite demo: your own pictures aren't read or uploaded here. Try the sample pictures, or get the full app to use your own."],
      };
    }
    if (path === "remove") { st.items = st.items.filter((it) => !(body.ids || []).includes(it.id)); bump(); return { ok: true }; }
    if (path === "clear") { st.items = []; st.run = null; bump(); return { ok: true }; }
    if (path === "start") { start(body || {}); return { ok: true }; }
    if (path === "cancel") { if (st.run && st.run.running) st.run.cancel_requested = true; bump(); return { ok: true }; }
    if (path === "preview") return preview(body);
    if (path === "adjust") { saveAdjustments(body); return { ok: true }; }
    if (path === "detect-crop") {
      const it = st.items.find((x) => x.id === body.id);
      const q = it && it.demo.card_quad;
      return { quad: q ? LiteEngine.turnQuad(q, (body.adjust || {}).rot90 || 0) : [[0, 0], [1, 0], [1, 1], [0, 1]] };
    }
    if (path === "straighten") {
      const it = st.items.find((x) => x.id === body.id);
      return { angle: it ? it.demo.skew : 0 };
    }
    if (path === "reveal") { fullAppOnly(body.id ? "Showing files in Finder" : "Opening the output folder"); return { ok: true }; }
    if (path === "quit") return { ok: true };
    const e = new Error("Not available in the lite demo");
    e.status = 404;
    throw e;
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.startsWith("/api/")) return realFetch(input, init);
    const u = new URL(url, location.origin);
    let body = init.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    try {
      return json(await handle(init.method || "GET", u.pathname.slice(5), u.searchParams, body || {}));
    } catch (e) {
      return json({ error: e.message }, e.status || 400);
    }
  };

  // ---------- URLs the interface puts in <img> and links (see build.py) ----------
  function byId(id) { return st.items.find((x) => x.id === id); }
  function imgUrl(id, kind, extra = "") {
    const it = byId(id);
    if (!it) return "";
    if (kind === "result" && it.result) return it.result.url;
    return `demo/${it.demo.id}/${/size=large/.test(extra) ? "orig" : "thumb"}.jpg`;
  }
  const fullUrl = (id) => { const it = byId(id); return it && it.result ? it.result.url : ""; };
  const editsUrl = (id) => { const it = byId(id); return (it && it.edits) || ""; };

  // ---------- picking demo pictures ----------
  function chooseDemos() {
    const dlg = document.createElement("dialog");
    dlg.className = "lite-chooser";
    const groups = [["scans", "Scans", "A sticker, a stamped note and a museum ticket"], ["photos", "Photos", "A coffee cup, a cat, an astronaut and a rocket"]];
    dlg.innerHTML = `
      <form method="dialog">
        <h2>Choose sample pictures</h2>
        <p class="lite-muted">In the full app this is where you pick your own files or folders, or drop them on the window.</p>
        <div class="lite-groups">${groups.map(([key, title, blurb]) => `
          <label class="lite-group">
            <input type="checkbox" name="${key}" checked>
            <span class="lite-group-head"><b>${title}</b> <span class="lite-muted">${demo.images.filter((d) => d.folder === key).length} pictures</span></span>
            <span class="lite-muted">${blurb}</span>
            <span class="lite-thumbs">${demo.images.filter((d) => d.folder === key).map((d) => `<img src="demo/${d.id}/thumb.jpg" alt="">`).join("")}</span>
          </label>`).join("")}
        </div>
        <p class="lite-muted small">Photos: scikit-image sample data (CC0 and public domain). Scans: drawn for this demo.</p>
        <div class="btn-row lite-actions">
          <button value="cancel" class="ghost">Cancel</button>
          <button value="add" class="primary">Add pictures</button>
        </div>
      </form>`;
    document.body.append(dlg);
    chooserOpen = new Promise((resolve) => {
      dlg.addEventListener("close", () => {
        const f = dlg.querySelector("form");
        const ids = dlg.returnValue === "add"
          ? demo.images.filter((d) => f.elements[d.folder].checked).map((d) => d.id) : null;
        dlg.remove();
        chooserOpen = null;
        resolve(ids && ids.length ? ids : null);
      });
    });
    dlg.showModal();
    return chooserOpen;
  }

  // ---------- ZIP (stored, no compression: PNGs are already compressed) ----------
  const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  function crc32(bytes) { let c = 0xffffffff; for (const b of bytes) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
  function zip(files) {
    const enc = new TextEncoder(), parts = [], central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
      const local = new DataView(new ArrayBuffer(30));
      [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, 0, 2], [12, 0x21, 2], [14, crc, 4], [18, size, 4], [22, size, 4], [26, name.length, 2], [28, 0, 2]]
        .forEach(([o, v, n]) => (n === 4 ? local.setUint32(o, v, true) : local.setUint16(o, v, true)));
      const cen = new DataView(new ArrayBuffer(46));
      [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, 0, 2], [14, 0x21, 2], [16, crc, 4], [20, size, 4], [24, size, 4], [28, name.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2], [38, 0, 4], [42, offset, 4]]
        .forEach(([o, v, n]) => (n === 4 ? cen.setUint32(o, v, true) : cen.setUint16(o, v, true)));
      parts.push(local, name, f.data);
      central.push(cen, name);
      offset += 30 + name.length + size;
    }
    const cenSize = central.reduce((s, p) => s + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    [[0, 0x06054b50, 4], [8, files.length, 2], [10, files.length, 2], [12, cenSize, 4], [16, offset, 4]]
      .forEach(([o, v, n]) => (n === 4 ? end.setUint32(o, v, true) : end.setUint16(o, v, true)));
    return new Blob([...parts, ...central, end], { type: "application/zip" });
  }

  async function downloadZip() {
    const done = st.items.filter((it) => it.result && (it.status === "done" || it.status === "skipped"));
    if (!done.length) { say("Nothing to download yet."); return; }
    const s = st.settings, vdir = variantDir(s), files = [];
    for (const it of done) {
      files.push({ name: it.out_rel, data: new Uint8Array(await it.result.blob.arrayBuffer()) });
      if (vdir) {
        const rgb = s.background === "white" ? [255, 255, 255] : s.background === "black" ? [0, 0, 0]
          : [1, 3, 5].map((i) => parseInt(s.custom_color.slice(i, i + 2), 16));
        const flat = await LiteEngine.toBlob(LiteEngine.composite(it.result.cut, rgb));
        files.push({ name: `${vdir}/${it.out_rel}`, data: new Uint8Array(await flat.arrayBuffer()) });
      }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(zip(files));
    a.download = "Background Studio lite results.zip";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    say(`Saved ${done.length} result${done.length === 1 ? "" : "s"} as a ZIP.`);
  }

  // ---------- lite banners and highlights ----------
  function aboutTool(title, text) {
    const dlg = document.createElement("dialog");
    dlg.className = "lite-chooser";
    dlg.innerHTML = `<form method="dialog"><h2></h2><p></p>
      <p class="lite-muted">The lite demo only shows background removal.</p>
      <div class="btn-row lite-actions"><button class="ghost" value="close">Close</button><a class="btn-link lite-get" href="${REPO}" target="_blank" rel="noopener">Get the full app →</a></div></form>`;
    dlg.querySelector("h2").textContent = title;
    dlg.querySelector("p").textContent = text;
    dlg.addEventListener("close", () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  }

  function note(target, html, where = "beforeend") {
    const n = document.createElement("p");
    n.className = "lite-note";
    n.innerHTML = `<span class="lite-pill">Lite</span> ${html}`;
    target.insertAdjacentElement(where, n);
  }

  function dress() {
    const $ = (q) => document.querySelector(q);
    document.title = "Background Studio · Lite demo";
    $(".brand span").insertAdjacentHTML("afterend", '<span class="lite-pill lite-pill-brand">Lite demo</span>');
    $(".topbar").insertAdjacentHTML("afterend", `
      <div class="lite-banner" role="note">
        <span><b>This is the lite demo.</b> It runs in your browser on 7 sample pictures.<span class="lite-more"> Their AI
        outlines were made in advance by the real models; everything else (methods, edges, ink, crop, tone and
        touch-ups) runs live.</span> The full app removes backgrounds from your own pictures, offline on your Mac.</span>
        <a href="${REPO}" target="_blank" rel="noopener">Get the full app →</a>
      </div>`);

    $("#privacyText").textContent = "Lite demo · nothing is uploaded";
    $("#privacyPop").innerHTML = `<strong>Nothing leaves your browser.</strong><ul>
      <li>This page only uses the sample pictures that come with it.</li>
      <li>Your own files are never read or uploaded.</li>
      <li>The full app runs offline on your Mac, with a network guard that blocks every outbound connection.</li></ul>`;
    const quit = $("#quitBtn");
    const get = document.createElement("a");
    get.className = "btn-link lite-get";
    get.href = REPO;
    get.target = "_blank";
    get.rel = "noopener";
    get.textContent = "Get the full app";
    quit.hidden = true;  // app.js still wires it up, so it stays in the page
    quit.after(get);

    $("#addFolder").textContent = "Choose sample pictures…";
    $("#addFiles").hidden = true;
    $("#dropzone strong").textContent = "Pick from 7 sample pictures";
    note($(".big-actions"), "In the full app you choose your own files or folders here, or drop them anywhere on the window.", "afterend");

    note($("#modeHint").parentElement, "The sample photos come set to <b>Photo</b>, since Auto is made for scans.");
    note($("#outDir").closest(".option-card"), "Results stay in this tab. Save them with <b>Download ZIP</b> on the Results step.");
    note($("#modelHint").parentElement, "Both models' outlines for the sample pictures were made in advance; batch timings are simulated.");
    note($("#editPanel section"), "The AI outline was made in advance. Every control here runs live in your browser.", "afterbegin");

    // The tabs' own tooltips say what each feature does; here they also say which ones this demo has.
    note($(".feature-bg .feature-tip"), "Try it here on 7 sample pictures.");
    for (const href of ["#tag", "#compare"]) {
      const tip = $(`.feature-link[href="${href}"] + .feature-tip`);
      const name = tip.querySelector("strong").textContent;
      const text = tip.querySelector("p").textContent;
      note(tip, "Part of the full app. Click to read more.");
      $(`.feature-link[href="${href}"] b`).insertAdjacentHTML("beforeend", '<span class="lite-pill">Full app</span>');
      document.querySelectorAll(`a[href="${href}"]`).forEach((a) => a.addEventListener("click", (e) => {
        e.preventDefault();
        aboutTool(name, text);
      }));
    }
    // Registered before app.js's own handlers, so these replace them.
    for (const q of ["#zipBtn", "#sumZip"]) {
      $(q).addEventListener("click", (e) => { e.stopImmediatePropagation(); downloadZip(); });
    }
  }
  dress();

  return { imgUrl, fullUrl, editsUrl };
})();
