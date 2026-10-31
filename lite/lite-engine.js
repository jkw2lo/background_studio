"use strict";
// Lite demo: a browser port of app/engine.py's render() pipeline, run on demo images whose
// AI masks were made in advance by the real models (lite/tools/make_demo.py). Everything
// after the model (rotation, crop, edges, ink, tone, touch-ups) runs here, like the app does it.
//
// Images are { w, h, d: Uint8ClampedArray RGBA, alpha: bool }; masks are { w, h, d: Uint8Array }.

const LiteEngine = (() => {
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  function newImg(w, h, alpha) { return { w, h, d: new Uint8ClampedArray(w * h * 4), alpha }; }
  function newMask(w, h) { return { w, h, d: new Uint8Array(w * h) }; }

  function fromImage(im) {
    const c = document.createElement("canvas");
    c.width = im.naturalWidth || im.width;
    c.height = im.naturalHeight || im.height;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(im, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height);
    return { w: c.width, h: c.height, d: px.data, alpha: false };
  }

  function maskFromImage(im) {
    const img = fromImage(im);
    const m = newMask(img.w, img.h);
    for (let i = 0; i < m.d.length; i++) m.d[i] = img.d[i * 4];
    return m;
  }

  function toCanvas(img) {
    const c = document.createElement("canvas");
    c.width = img.w;
    c.height = img.h;
    c.getContext("2d").putImageData(new ImageData(img.d, img.w, img.h), 0, 0);
    return c;
  }

  function toBlob(img, type = "image/png", quality) {
    return new Promise((res) => toCanvas(img).toBlob(res, type, quality));
  }

  function withAlpha(img) {
    if (img.alpha) return img;
    return { w: img.w, h: img.h, d: new Uint8ClampedArray(img.d), alpha: true };
  }

  // ---------- geometry ----------
  // Quarter turns clockwise (lossless), as PIL's transpose in rotate_image.
  function quarter(src, rot90, channels) {
    rot90 = ((rot90 % 4) + 4) % 4;
    if (!rot90) return src;
    const { w, h } = src;
    const W = rot90 === 2 ? w : h, H = rot90 === 2 ? h : w;
    const out = channels === 4 ? newImg(W, H, src.alpha) : newMask(W, H);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let X, Y;
        if (rot90 === 1) { X = h - 1 - y; Y = x; }
        else if (rot90 === 2) { X = w - 1 - x; Y = h - 1 - y; }
        else { X = y; Y = w - 1 - x; }
        const si = y * w + x, di = Y * W + X;
        if (channels === 4) {
          out.d[di * 4] = src.d[si * 4]; out.d[di * 4 + 1] = src.d[si * 4 + 1];
          out.d[di * 4 + 2] = src.d[si * 4 + 2]; out.d[di * 4 + 3] = src.d[si * 4 + 3];
        } else out.d[di] = src.d[si];
      }
    }
    return out;
  }

  // Bilinear sample of channel c at (x, y); outside the image counts as transparent / 0.
  function sampler(src, channels) {
    const { w, h, d } = src;
    return (x, y, out, o) => {
      const x0 = Math.floor(x), y0 = Math.floor(y);
      const fx = x - x0, fy = y - y0;
      let wsum = 0;
      const acc = [0, 0, 0, 0];
      for (let j = 0; j < 2; j++) {
        const yy = y0 + j;
        if (yy < 0 || yy >= h) continue;
        const wy = j ? fy : 1 - fy;
        for (let i = 0; i < 2; i++) {
          const xx = x0 + i;
          if (xx < 0 || xx >= w) continue;
          const wt = (i ? fx : 1 - fx) * wy;
          if (!wt) continue;
          const p = (yy * w + xx) * channels;
          if (channels === 4) {
            const a = d[p + 3] * wt;  // premultiplied, so transparent edges don't darken
            acc[0] += d[p] * a; acc[1] += d[p + 1] * a; acc[2] += d[p + 2] * a; acc[3] += a;
          } else acc[0] += d[p] * wt;
          wsum += wt;
        }
      }
      if (channels === 4) {
        const a = acc[3];
        out[o] = a ? acc[0] / a : 0; out[o + 1] = a ? acc[1] / a : 0; out[o + 2] = a ? acc[2] / a : 0;
        out[o + 3] = a;
      } else out[o] = acc[0];
      return wsum;
    };
  }

  // Fine clockwise rotation with expand; new corners are transparent (rotate_image).
  function rotateFine(src, angle, channels) {
    if (Math.abs(angle) <= 0.01) return src;
    const t = (angle * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
    const { w, h } = src;
    const W = Math.ceil(Math.abs(w * c) + Math.abs(h * s) - 1e-6);
    const H = Math.ceil(Math.abs(w * s) + Math.abs(h * c) - 1e-6);
    const out = channels === 4 ? newImg(W, H, true) : newMask(W, H);
    const cx = w / 2, cy = h / 2, CX = W / 2, CY = H / 2;
    const sample = sampler(src, channels);
    for (let Y = 0; Y < H; Y++) {
      for (let X = 0; X < W; X++) {
        const dx = X + 0.5 - CX, dy = Y + 0.5 - CY;
        const x = c * dx + s * dy + cx - 0.5, y = -s * dx + c * dy + cy - 0.5;
        sample(x, y, out.d, (Y * W + X) * channels);
      }
    }
    return out;
  }

  function rotate(src, rot90, angle, channels) {
    return rotateFine(quarter(channels === 4 ? src : src, rot90 || 0, channels), angle || 0, channels);
  }

  function solve(A, b) {  // Gaussian elimination with partial pivoting
    const n = b.length;
    for (let i = 0; i < n; i++) {
      let p = i;
      for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
      [A[i], A[p]] = [A[p], A[i]];
      [b[i], b[p]] = [b[p], b[i]];
      for (let r = i + 1; r < n; r++) {
        const f = A[r][i] / A[i][i];
        for (let k = i; k < n; k++) A[r][k] -= f * A[i][k];
        b[r] -= f * b[i];
      }
    }
    const x = new Array(n);
    for (let i = n - 1; i >= 0; i--) {
      let s = b[i];
      for (let k = i + 1; k < n; k++) s -= A[i][k] * x[k];
      x[i] = s / A[i][i];
    }
    return x;
  }

  // Cut out the quadrilateral (0-1, TL TR BR BL) and straighten it to a rectangle (warp_quad).
  function warpQuad(src, quad, channels) {
    const { w, h } = src;
    const p = quad.map(([x, y]) => [x * (w - 1), y * (h - 1)]);
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const W = Math.max(8, Math.round(Math.max(dist(p[1], p[0]), dist(p[2], p[3]))));
    const H = Math.max(8, Math.round(Math.max(dist(p[3], p[0]), dist(p[2], p[1]))));
    const dst = [[0, 0], [W - 1, 0], [W - 1, H - 1], [0, H - 1]];
    const A = [], b = [];
    dst.forEach(([X, Y], i) => {
      const [x, y] = p[i];
      A.push([X, Y, 1, 0, 0, 0, -x * X, -x * Y]); b.push(x);
      A.push([0, 0, 0, X, Y, 1, -y * X, -y * Y]); b.push(y);
    });
    const [a0, a1, a2, a3, a4, a5, a6, a7] = solve(A, b);
    const out = channels === 4 ? newImg(W, H, src.alpha) : newMask(W, H);
    const sample = sampler(src, channels);
    for (let Y = 0; Y < H; Y++) {
      for (let X = 0; X < W; X++) {
        const k = a6 * X + a7 * Y + 1;
        const o = (Y * W + X) * channels;
        sample((a0 * X + a1 * Y + a2) / k, (a3 * X + a4 * Y + a5) / k, out.d, o);
        if (channels === 4 && !src.alpha) out.d[o + 3] = 255;
      }
    }
    return out;
  }

  // Largest upright rectangle inside a w x h image rotated by `angle` (inscribed_quad).
  function inscribedQuad(w, h, angle, outW, outH) {
    const a = (Math.abs(angle) * Math.PI) / 180, sa = Math.sin(a), ca = Math.cos(a);
    const [long, short] = w >= h ? [w, h] : [h, w];
    let wr, hr;
    if (short <= 2 * sa * ca * long || Math.abs(sa - ca) < 1e-10) {
      const x = 0.5 * short;
      [wr, hr] = w >= h ? [x / sa, x / ca] : [x / ca, x / sa];
    } else {
      const c2 = ca * ca - sa * sa;
      wr = (w * ca - h * sa) / c2;
      hr = (h * ca - w * sa) / c2;
    }
    const inset = 1.5;
    const x0 = ((outW - wr) / 2 + inset) / (outW - 1), y0 = ((outH - hr) / 2 + inset) / (outH - 1);
    return [[x0, y0], [1 - x0, y0], [1 - x0, 1 - y0], [x0, 1 - y0]];
  }

  // Corners found on the unrotated image, carried through quarter turns.
  function turnQuad(q, rot90) {
    if (!q) return null;
    rot90 = ((rot90 % 4) + 4) % 4;
    let pts = q.map(([x, y]) => (rot90 === 1 ? [1 - y, x] : rot90 === 2 ? [1 - x, 1 - y] : rot90 === 3 ? [y, 1 - x] : [x, y]));
    // Re-order to TL TR BR BL.
    const c = pts.reduce((s, p) => [s[0] + p[0] / 4, s[1] + p[1] / 4], [0, 0]);
    const at = (fx, fy) => pts.reduce((best, p) => ((p[0] - c[0]) * fx + (p[1] - c[1]) * fy > (best[0] - c[0]) * fx + (best[1] - c[1]) * fy ? p : best));
    pts = [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)];
    return pts;
  }

  // ---------- masks ----------
  // Exact Euclidean distance (Felzenszwalb & Huttenlocher) from each pixel to the nearest
  // pixel where `isZero` is true; 0 there.
  function edt(isZero, w, h) {
    const INF = 1e20, f = new Float64Array(Math.max(w, h)), dd = new Float64Array(Math.max(w, h));
    const v = new Int32Array(Math.max(w, h)), z = new Float64Array(Math.max(w, h) + 1);
    const grid = new Float64Array(w * h);
    for (let i = 0; i < w * h; i++) grid[i] = isZero[i] ? 0 : INF;
    const pass = (n, get, set) => {
      for (let i = 0; i < n; i++) f[i] = get(i);
      let k = 0;
      v[0] = 0; z[0] = -INF; z[1] = INF;
      for (let q = 1; q < n; q++) {
        let s;
        for (;;) {
          s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
          if (s <= z[k] && k > 0) k--; else break;
        }
        if (s <= z[k]) { v[0] = q; z[0] = -INF; z[1] = INF; k = 0; continue; }
        k++; v[k] = q; z[k] = s; z[k + 1] = INF;
      }
      k = 0;
      for (let q = 0; q < n; q++) {
        while (z[k + 1] < q) k++;
        dd[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
      }
      for (let i = 0; i < n; i++) set(i, dd[i]);
    };
    for (let x = 0; x < w; x++) pass(h, (y) => grid[y * w + x], (y, val) => { grid[y * w + x] = val; });
    for (let y = 0; y < h; y++) pass(w, (x) => grid[y * w + x], (x, val) => { grid[y * w + x] = val; });
    for (let i = 0; i < w * h; i++) grid[i] = Math.sqrt(grid[i]);
    return grid;
  }

  // Background reachable from the border through non-mask pixels; everything else is inside.
  function fillHoles(bin, w, h) {
    const seen = new Uint8Array(w * h), stack = [];
    const push = (i) => { if (!bin[i] && !seen[i]) { seen[i] = 1; stack.push(i); } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (stack.length) {
      const i = stack.pop(), x = i % w;
      if (x > 0) push(i - 1);
      if (x < w - 1) push(i + 1);
      if (i >= w) push(i - w);
      if (i < w * (h - 1)) push(i + w);
    }
    const out = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) out[i] = bin[i] || !seen[i] ? 1 : 0;
    return out;
  }

  // Fill holes, then grow/shrink and soften the edge (refine_mask). grow/soften: px per 1000 px.
  function refineMask(raw, fill, grow, soften) {
    const { w, h } = raw, n = w * h;
    const r = new Uint8Array(n), bin = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      r[i] = clamp(Math.floor((raw.d[i] - 12) * (255 / 218) + 0.5), 0, 255);
      bin[i] = r[i] > 127 ? 1 : 0;
    }
    const filled = fill ? fillHoles(bin, w, h) : bin;
    const out = newMask(w, h);
    if (Math.abs(grow) < 1e-6 && soften < 1e-6) {
      for (let i = 0; i < n; i++) out.d[i] = fill && filled[i] && !bin[i] ? 255 : r[i];
      dropSpecks(out);
      return out;
    }
    const unit = Math.min(w, h) / 1000;
    const notFilled = new Uint8Array(n);
    for (let i = 0; i < n; i++) notFilled[i] = filled[i] ? 0 : 1;
    const inside = edt(notFilled, w, h), outside = edt(filled, w, h);
    const width = Math.max(1, soften * unit);
    for (let i = 0; i < n; i++) {
      const a = clamp((inside[i] - outside[i] + grow * unit) / width + 0.5, 0, 1);
      out.d[i] = Math.floor(a * 255 + 0.5);
    }
    return out;
  }

  // Drop specks (dust, scanner noise) smaller than 0.2% of the image, when there's more than one piece.
  function dropSpecks(m) {
    const { w, h, d } = m, n = w * h;
    const label = new Int32Array(n), sizes = [0];
    let next = 0;
    const stack = [];
    for (let s = 0; s < n; s++) {
      if (d[s] <= 127 || label[s]) continue;
      next++;
      let size = 0;
      label[s] = next;
      stack.push(s);
      while (stack.length) {
        const i = stack.pop(), x = i % w;
        size++;
        const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < n - w ? i + w : -1];
        for (const j of nb) if (j >= 0 && d[j] > 127 && !label[j]) { label[j] = next; stack.push(j); }
      }
      sizes.push(size);
    }
    if (next <= 1) return;
    const min = 0.002 * n;
    for (let i = 0; i < n; i++) if (label[i] && sizes[label[i]] < min) d[i] = 0;
  }

  // Separable box blur of a Float32 plane, radius r.
  function boxBlur(src, w, h, r) {
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      let acc = 0;
      const row = y * w;
      for (let x = -r; x <= r; x++) acc += src[row + clamp(x, 0, w - 1)];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc / (2 * r + 1);
        acc += src[row + Math.min(x + r + 1, w - 1)] - src[row + Math.max(x - r, 0)];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[clamp(y, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = acc / (2 * r + 1);
        acc += tmp[Math.min(y + r + 1, h - 1) * w + x] - tmp[Math.max(y - r, 0) * w + x];
      }
    }
    return out;
  }

  function cutWithAlpha(frame, alpha) {
    const out = newImg(frame.w, frame.h, true);
    out.d.set(frame.d);
    for (let i = 0; i < alpha.d.length; i++) out.d[i * 4 + 3] = alpha.d[i];
    return out;
  }

  // Remove background colour bleeding into soft edges. The app uses rembg's decontamination;
  // here soft edge pixels take the colour of the solid subject nearby (a close approximation).
  function cleanFringe(frame, alpha) {
    const out = cutWithAlpha(frame, alpha);
    const { w, h } = frame, n = w * h;
    const wt = new Float32Array(n), ch = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    let edge = false;
    for (let i = 0; i < n; i++) {
      const solid = alpha.d[i] >= 250 ? 1 : 0;
      if (alpha.d[i] > 0 && alpha.d[i] < 255) edge = true;
      wt[i] = solid;
      for (let c = 0; c < 3; c++) ch[c][i] = frame.d[i * 4 + c] * solid;
    }
    if (!edge) return out;
    const r = Math.max(2, Math.round(Math.min(w, h) / 150));
    const bw = boxBlur(boxBlur(wt, w, h, r), w, h, r);
    const bc = ch.map((p) => boxBlur(boxBlur(p, w, h, r), w, h, r));
    for (let i = 0; i < n; i++) {
      const a = alpha.d[i];
      if (a === 0 || a === 255 || bw[i] < 1e-3) continue;
      for (let c = 0; c < 3; c++) out.d[i * 4 + c] = bc[c][i] / bw[i];
    }
    return out;
  }

  // ---------- ink ----------
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const gam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
  const LUT = new Float32Array(256).map((_, i) => lin(i / 255));
  const fLab = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  function lab(r, g, b, out, o) {  // sRGB 0-255 -> CIE Lab (D65), as skimage's rgb2lab
    const R = LUT[r], G = LUT[g], B = LUT[b];
    const X = (0.412453 * R + 0.357580 * G + 0.180423 * B) / 0.95047;
    const Y = 0.212671 * R + 0.715160 * G + 0.072169 * B;
    const Z = (0.019334 * R + 0.119193 * G + 0.950227 * B) / 1.08883;
    const fx = fLab(X), fy = fLab(Y), fz = fLab(Z);
    out[o] = Y > 216 / 24389 ? 116 * fy - 16 : (24389 / 27) * Y;
    out[o + 1] = 500 * (fx - fy);
    out[o + 2] = 200 * (fy - fz);
  }
  function labToRgb(L, a, b) {
    const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
    const inv = (t) => (t * t * t > 216 / 24389 ? t * t * t : (116 * t - 16) / (24389 / 27));
    const X = inv(fx) * 0.95047, Y = inv(fy), Z = inv(fz) * 1.08883;
    const R = 3.240481 * X - 1.537151 * Y - 0.498536 * Z;
    const G = -0.969255 * X + 1.875990 * Y + 0.041556 * Z;
    const B = 0.055647 * X - 0.204041 * Y + 1.057311 * Z;
    return [R, G, B].map((c) => clamp(gam(clamp(c, 0, 1)), 0, 1));
  }
  function percentile(arr, p) {
    const s = Float32Array.from(arr).sort();
    if (!s.length) return 0;
    const k = (s.length - 1) * (p / 100), f = Math.floor(k), c = Math.min(f + 1, s.length - 1);
    return s[f] + (s[c] - s[f]) * (k - f);
  }
  function median(arr) { return percentile(arr, 50); }

  // Make the paper transparent and keep the ink (cutout_ink).
  function cutoutInk(img, strength = 0, paperHex = null) {
    const { w, h } = img, n = w * h;
    const step = Math.max(1, Math.ceil(Math.max(w, h) / 800));
    const labS = [];
    const tmp = [0, 0, 0];
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const p = (y * w + x) * 4;
        lab(img.d[p], img.d[p + 1], img.d[p + 2], tmp, 0);
        labS.push(tmp[0], tmp[1], tmp[2]);
      }
    }
    const m = labS.length / 3;
    const Ls = new Float32Array(m);
    for (let i = 0; i < m; i++) Ls[i] = labS[i * 3];
    const cut60 = percentile(Ls, 60);
    const bright = [];
    for (let i = 0; i < m; i++) if (Ls[i] >= cut60) bright.push(i);
    let paper;
    if (paperHex) {
      const c = parseInt(paperHex.slice(1), 16), o = [0, 0, 0];
      lab(c >> 16 & 255, c >> 8 & 255, c & 255, o, 0);
      paper = o;
    } else {
      paper = [0, 1, 2].map((k) => median(bright.map((i) => labS[i * 3 + k])));
    }
    const dist = (i) => Math.hypot(labS[i * 3] - paper[0], labS[i * 3 + 1] - paper[1], labS[i * 3 + 2] - paper[2]);
    const spread = percentile(bright.map(dist), 75);
    const dS = new Float32Array(m);
    for (let i = 0; i < m; i++) dS[i] = dist(i);
    let lo = Math.max(6, 2.5 * spread + 3);
    let hi = clamp(0.8 * percentile(dS, 99.5), lo + 15, 60);
    const k = 1 - 0.6 * strength;
    lo = Math.max(2, lo * k);
    hi = Math.max(lo + 5, hi * k);
    const P = labToRgb(paper[0], paper[1], paper[2]);

    const out = newImg(w, h, true);
    const L = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      lab(img.d[p], img.d[p + 1], img.d[p + 2], L, 0);
      const d = Math.hypot(L[0] - paper[0], L[1] - paper[1], L[2] - paper[2]);
      const a = clamp((d - lo) / (hi - lo), 0, 1);
      const aa = Math.max(a, 1e-3);
      for (let c = 0; c < 3; c++) {
        const v = img.d[p + c] / 255;
        out.d[p + c] = Math.floor(clamp((v - (1 - aa) * P[c]) / aa, 0, 1) * 255 + 0.5);
      }
      out.d[p + 3] = Math.floor(a * 255 + 0.5);
      if (img.alpha) out.d[p + 3] = Math.min(out.d[p + 3], img.d[p + 3]);
    }
    return out;
  }

  // ---------- tone ----------
  // Brightness / contrast / saturation (and auto levels), as PIL's ImageEnhance + autocontrast.
  function applyTone(img, a) {
    const b = a.bright || 0, c = a.contrast || 0, s = a.sat || 0, auto = !!a.autotone;
    if (!(b || c || s || auto)) return img;
    const out = { w: img.w, h: img.h, d: new Uint8ClampedArray(img.d), alpha: img.alpha };
    const d = out.d, n = img.w * img.h;
    const luma = (p) => (d[p] * 299 + d[p + 1] * 587 + d[p + 2] * 114) / 1000;
    if (auto) {
      const hist = new Float64Array(256);
      let total = 0;
      for (let i = 0; i < n; i++) {
        const p = i * 4;
        if (img.alpha && d[p + 3] <= 128) continue;
        hist[Math.floor(luma(p))]++;
        total++;
      }
      let cut = Math.floor((total * 0.5) / 100);
      let lo = 0, hi = 255;
      for (let rem = cut; lo < 256; lo++) { if (hist[lo] > rem) break; rem -= hist[lo]; }
      for (let rem = cut; hi >= 0; hi--) { if (hist[hi] > rem) break; rem -= hist[hi]; }
      if (hi > lo) {
        const scale = 255 / (hi - lo), off = -lo * scale;
        for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) d[i * 4 + k] = clamp(d[i * 4 + k] * scale + off, 0, 255);
      }
    }
    if (b) {
      const f = 1 + 0.6 * b;
      for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) d[i * 4 + k] = d[i * 4 + k] * f;
    }
    if (c) {
      const f = 1 + 0.8 * c;
      let sum = 0;
      for (let i = 0; i < n; i++) sum += Math.floor(luma(i * 4));
      const mean = Math.floor(sum / n + 0.5);
      for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) d[i * 4 + k] = mean + f * (d[i * 4 + k] - mean);
    }
    if (s) {
      const f = 1 + s;
      for (let i = 0; i < n; i++) {
        const p = i * 4, L = Math.floor(luma(p));
        for (let k = 0; k < 3; k++) d[p + k] = L + f * (d[p + k] - L);
      }
    }
    return out;
  }

  // ---------- finishing ----------
  function trimTransparent(img) {
    if (!img.alpha) return img;
    const { w, h, d } = img;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] > 8) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return img;
    const pad = Math.max(2, Math.floor(0.01 * Math.max(w, h)));
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
    x1 = Math.min(w, x1 + 1 + pad); y1 = Math.min(h, y1 + 1 + pad);
    if (x0 === 0 && y0 === 0 && x1 === w && y1 === h) return img;
    const out = newImg(x1 - x0, y1 - y0, true);
    for (let y = y0; y < y1; y++) out.d.set(d.subarray((y * w + x0) * 4, (y * w + x1) * 4), (y - y0) * out.w * 4);
    return out;
  }

  // Touch-up brushes: red = keep (restore the original), green = erase (apply_edits).
  function applyEdits(cut, frame, editsImage) {
    const c = document.createElement("canvas");
    c.width = cut.w;
    c.height = cut.h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(editsImage, 0, 0, cut.w, cut.h);
    const e = ctx.getImageData(0, 0, cut.w, cut.h).data;
    const out = newImg(cut.w, cut.h, true);
    for (let i = 0; i < cut.w * cut.h; i++) {
      const p = i * 4;
      const fa = frame.alpha ? frame.d[p + 3] / 255 : 1;
      const keep = (e[p] / 255) * fa, erase = e[p + 1] / 255;
      for (let k = 0; k < 3; k++) out.d[p + k] = cut.d[p + k] * (1 - keep) + frame.d[p + k] * keep;
      out.d[p + 3] = Math.max(cut.d[p + 3], keep * 255) * (1 - erase);
    }
    return out;
  }

  // Colour fills (pick_masks + apply_picks): keep or remove every pixel close to a picked
  // colour, everywhere or only the patch touching the clicked point; kept pixels may be recoloured.
  const FILL_TONES = { black: 0, grey: 128 };
  function pickMask(frame, p, labF) {
    const { w, h } = frame, n = w * h, m = new Uint8Array(n), t = new Float32Array(3);
    const hex = parseInt(p.c.slice(1), 16);
    lab(hex >> 16 & 255, hex >> 8 & 255, hex & 255, t, 0);
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(labF[i * 3] - t[0], labF[i * 3 + 1] - t[1], labF[i * 3 + 2] - t[2]);
      m[i] = Math.round(clamp((1.5 * p.tol - d) / (0.5 * p.tol), 0, 1) * 255);
    }
    if (!p.at) return m;
    const cx = Math.min(w - 1, Math.floor(p.at[0] * w)), cy = Math.min(h - 1, Math.floor(p.at[1] * h));
    const r = Math.max(2, Math.round(Math.max(w, h) / 1400 * 2));
    let seed = -1;
    for (let y = Math.max(0, cy - r); y <= Math.min(h - 1, cy + r); y++)
      for (let x = Math.max(0, cx - r); x <= Math.min(w - 1, cx + r); x++)
        if (m[y * w + x] && (seed < 0 || m[y * w + x] > m[seed])) seed = y * w + x;
    const out = new Uint8Array(n);
    if (seed < 0) return out;
    const stack = [seed];
    out[seed] = m[seed];
    while (stack.length) {  // 8-connected, like ndimage.label with a 3x3 structure
      const i = stack.pop(), x = i % w, y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy, j = yy * w + xx;
        if (xx >= 0 && xx < w && yy >= 0 && yy < h && m[j] && !out[j]) { out[j] = m[j]; stack.push(j); }
      }
    }
    return out;
  }

  function applyPicks(cut, frame, picks) {
    if (!picks || !picks.length) return cut;
    const n = frame.w * frame.h, labF = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) lab(frame.d[i * 4], frame.d[i * 4 + 1], frame.d[i * 4 + 2], labF, i * 3);
    const out = newImg(cut.w, cut.h, true);
    out.d.set(cut.d);
    if (!cut.alpha) for (let i = 0; i < n; i++) out.d[i * 4 + 3] = 255;
    const c = Float32Array.from(out.d);
    for (const p of picks) {
      const mk = pickMask(frame, p, labF), tone = FILL_TONES[p.tone];
      for (let i = 0; i < n; i++) {
        if (!mk[i]) continue;
        const q = i * 4, m = (mk[i] / 255) * (frame.alpha ? frame.d[q + 3] / 255 : 1), a = c[q + 3] / 255;
        if (p.act === "erase") { c[q + 3] = a * (1 - m) * 255; continue; }
        const oa = m + a * (1 - m);
        for (let k = 0; k < 3; k++) c[q + k] = ((tone ?? frame.d[q + k]) * m + c[q + k] * a * (1 - m)) / Math.max(oa, 1e-6);
        c[q + 3] = oa * 255;
      }
    }
    out.d.set(c);
    return out;
  }

  function composite(cut, rgb) {
    const out = newImg(cut.w, cut.h, false);
    for (let i = 0; i < cut.w * cut.h; i++) {
      const p = i * 4, a = cut.d[p + 3] / 255;
      for (let k = 0; k < 3; k++) out.d[p + k] = cut.d[p + k] * a + rgb[k] * (1 - a);
      out.d[p + 3] = 255;
    }
    return out;
  }

  const isIdentity = (q) => !!q && q.every(([x, y], i) => Math.abs(x - [0, 1, 1, 0][i]) < 0.002 && Math.abs(y - [0, 0, 1, 1][i]) < 0.002);

  // ---------- the pipeline ----------
  // Same order and decisions as engine.render(): rotate -> crop/straighten -> cut out -> tone.
  // `pre` holds what the real engine decided for the unrotated image: Auto's choice and the
  // detected card corners (detecting them needs the Python edge/line tools).
  function render(img, mode, adjust, getMask, fringeDefault, pre, geometryOnly = false) {
    const rot90 = adjust.rot90 || 0, angle = adjust.angle || 0;
    const turned = quarter(img, rot90, 4);
    if (geometryOnly) {
      const geo = rotateFine(turned, angle, 4);
      return { cut: withAlpha(geo), frame: geo, orig: geo, used: "keep", why: "", quad: null };
    }
    let used = mode, why = "";
    if (mode === "auto") { used = pre.auto.used; why = pre.auto.why; }
    const geo = rotateFine(turned, angle, 4);

    let quad = adjust.crop || null;
    const noCrop = isIdentity(quad);
    if (noCrop) {
      quad = null;
    } else if (!quad && Math.abs(angle) > 0.01 && ["keep", "card", "ink"].includes(used)) {
      quad = inscribedQuad(turned.w, turned.h, angle, geo.w, geo.h);
      if (used === "keep") { used = "card"; why = "straightened"; }
    } else if (!quad && used === "card") {
      quad = turnQuad(mode === "auto" ? pre.auto.quad : pre.cardQuad, rot90);
    } else if (quad && used === "keep") {
      used = "card"; why = "cropped by hand";
    }
    const frame = quad ? warpQuad(geo, quad, 4) : geo;
    const finish = (cut) => {
      const toned = applyTone(frame, adjust);
      return { cut: applyPicks(applyTone(cut, adjust), toned, adjust.picks), frame: toned, orig: frame, used, why, quad };
    };

    if (used === "item" || used === "photo") {
      let mask = rotate(getMask(), rot90, angle, 1);
      if (quad) mask = warpQuad(mask, quad, 1);
      const fill = adjust.fill ?? (used === "item");
      const alpha = refineMask(mask, fill, adjust.grow || 0, adjust.soften || 0);
      if (frame.alpha) for (let i = 0; i < alpha.d.length; i++) alpha.d[i] = Math.min(alpha.d[i], frame.d[i * 4 + 3]);
      const cut = (adjust.fringe ?? fringeDefault) ? cleanFringe(frame, alpha) : cutWithAlpha(frame, alpha);
      return finish(cut);
    }
    if (used === "ink") return finish(cutoutInk(frame, adjust.ink || 0, adjust.paper || null));
    return finish(withAlpha(frame));
  }

  return { fromImage, maskFromImage, toBlob, render, applyEdits, trimTransparent, composite, turnQuad };
})();
