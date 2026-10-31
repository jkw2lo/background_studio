"""Image I/O and background removal for a single image. No network, no global state."""

from __future__ import annotations

import hashlib
import io
import os
from pathlib import Path

import math

import numpy as np
from PIL import Image, ImageEnhance, ImageOps, UnidentifiedImageError

try:  # iPhone photos
    from pillow_heif import register_heif_opener

    register_heif_opener()
    HEIF = True
except Exception:  # pragma: no cover - optional
    HEIF = False

# Allow large photos (e.g. 100 MP scans) but still refuse absurd "decompression bombs".
Image.MAX_IMAGE_PIXELS = 200_000_000

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}
if HEIF:
    IMAGE_EXTS |= {".heic", ".heif"}


class ImageError(Exception):
    """An error with a message that is safe and useful to show the user."""


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def friendly_error(exc: BaseException) -> str:
    if isinstance(exc, ImageError):
        return str(exc)
    if isinstance(exc, FileNotFoundError):
        return "The original file could not be found (it may have been moved or renamed)."
    if isinstance(exc, PermissionError):
        return ("macOS did not allow access to this file or folder. See README → "
                "'Files & Folders permission'.")
    if isinstance(exc, UnidentifiedImageError):
        return "This file is not a readable image (it may be damaged or an unsupported format)."
    if isinstance(exc, Image.DecompressionBombError):
        return "This image is larger than 200 megapixels and was skipped for safety."
    if isinstance(exc, MemoryError):
        return "Not enough memory to process this image."
    if isinstance(exc, OSError) and "truncated" in str(exc).lower():
        return "This image file is incomplete or damaged (truncated)."
    if isinstance(exc, OSError) and getattr(exc, "errno", None) == 28:
        return "The output disk is full."
    return f"{type(exc).__name__}: {exc}"


def load_image(path: Path) -> tuple[Image.Image, bytes | None]:
    """Open an image as RGB or RGBA, upright, plus an ICC profile worth keeping."""
    with Image.open(path) as im:
        if getattr(im, "n_frames", 1) > 1:
            im.seek(0)
        im.load()
        im = ImageOps.exif_transpose(im)  # phone photos are often stored sideways
        icc = im.info.get("icc_profile")
        mode = im.mode

        if mode in ("I;16", "I;16B", "I;16L", "I", "F"):
            arr = np.asarray(im, dtype=np.float64)
            top = 65535.0 if arr.max() > 255 else 255.0
            im = Image.fromarray(np.clip(arr / top * 255.0, 0, 255).astype(np.uint8), "L")
            mode = "L"
        if mode == "CMYK":
            icc = None  # a CMYK profile does not describe the RGB output
        if mode in ("RGBA", "LA", "PA") or (mode == "P" and "transparency" in im.info):
            im = im.convert("RGBA")
        elif im.mode != "RGB":
            im = im.convert("RGB")
        return im, icc


def remove_background(img: Image.Image, session, clean_edges: bool = False) -> Image.Image:
    """Return an RGBA cutout at the original resolution."""
    from rembg import remove

    source_alpha = img.getchannel("A") if img.mode == "RGBA" else None
    rgb = img.convert("RGB")
    cutout = remove(rgb, session=session, decontaminate=clean_edges)
    if cutout.mode != "RGBA":
        cutout = cutout.convert("RGBA")
    if source_alpha is not None:
        # Respect transparency that was already in the original.
        alpha = np.minimum(np.asarray(cutout.getchannel("A")), np.asarray(source_alpha))
        cutout.putalpha(Image.fromarray(alpha, "L"))
    return cutout


# ---------- scanned flat items ----------
# AI background-removal models are trained on photos: they look for a subject inside a
# scene. On a scanned ticket or postcard they treat the printed artwork as the "photo"
# and cut it apart. Everything below handles scans differently, depending on what is
# around the item, and supports per-image manual adjustments.
#
# One pipeline, render(), produces both the fast live preview (on a downscaled copy)
# and the final full-size result, so what you see while adjusting is what gets saved.

# Bump when the cut-out algorithm changes, so earlier AI cut-outs are redone instead of skipped.
# 2: AI outlines get a matte cleanup (fully solid inside, no faint background haze).
ENGINE_VERSION = 2

MODES = ("auto", "item", "ink", "photo", "card", "keep")
MODE_LABELS = {
    "auto": "Auto", "item": "Cut-out item", "ink": "Ink on paper", "photo": "Photo subject",
    "card": "Card (trimmed & straightened)", "keep": "Kept as is",
}

# Manual adjustments and their allowed ranges (see sanitize_adjust).
ADJUST_DEFAULTS = {"crop": None, "ink": 0.0, "paper": None, "grow": 0.0, "soften": 0.0,
                   "fill": None, "fringe": None}


def sanitize_adjust(adj: dict | None) -> dict:
    """Validate adjustments from the browser; drop defaults so an empty dict means 'automatic'."""
    adj = adj or {}
    out: dict = {}

    def num(key, lo, hi):
        try:
            v = float(adj.get(key, 0.0))
        except (TypeError, ValueError):
            raise ValueError(f"Bad value for {key}")
        v = max(lo, min(hi, v))
        if abs(v) > 1e-6:
            out[key] = round(v, 3)

    num("ink", -1.0, 1.0)
    num("grow", -20.0, 20.0)
    num("soften", 0.0, 20.0)
    num("angle", -45.0, 45.0)      # fine straightening, degrees clockwise
    num("bright", -1.0, 1.0)       # tone, applied to the finished cut-out
    num("contrast", -1.0, 1.0)
    num("sat", -1.0, 1.0)
    try:
        rot90 = int(adj.get("rot90", 0)) % 4  # quarter turns clockwise
    except (TypeError, ValueError):
        raise ValueError("Bad rotation")
    if rot90:
        out["rot90"] = rot90
    for key in ("autotone", "invert"):
        if adj.get(key):
            out[key] = True
    if adj.get("paper"):
        out["paper"] = _hex(adj["paper"], "Paper colour")
    for key in ("fill", "fringe"):
        if adj.get(key) is not None:
            out[key] = bool(adj[key])
    crop = adj.get("crop")
    if crop:
        try:
            q = [[float(x), float(y)] for x, y in crop]
        except (TypeError, ValueError):
            raise ValueError("Bad crop")
        if len(q) != 4:
            raise ValueError("Crop needs four corners")
        out["crop"] = [[round(min(1.0, max(0.0, x)), 5), round(min(1.0, max(0.0, y)), 5)] for x, y in q]
    picks = adj.get("picks")
    if picks:
        if not isinstance(picks, list) or len(picks) > 60:
            raise ValueError("Bad colour fills")
        out["picks"] = [_sanitize_pick(p) for p in picks]
    return out


def _hex(v, what: str) -> str:
    if not (isinstance(v, str) and len(v) == 7 and v[0] == "#"):
        raise ValueError(f"{what} must look like #RRGGBB")
    int(v[1:], 16)
    return v.lower()


def _sanitize_pick(p) -> dict:
    """One colour fill: {c: picked colour, tol: range (ΔE), at: clicked point when only the
    touching patch is wanted, act: keep/erase, tone: black/grey to recolour what's kept}."""
    if not isinstance(p, dict):
        raise ValueError("Bad colour fill")
    try:
        q = {"c": _hex(p.get("c"), "Fill colour"), "tol": round(max(2.0, min(80.0, float(p.get("tol", 20)))), 1),
             "act": "erase" if p.get("act") == "erase" else "keep"}
        if p.get("at") is not None:
            x, y = (float(v) for v in p["at"])
            q["at"] = [round(min(1.0, max(0.0, x)), 5), round(min(1.0, max(0.0, y)), 5)]
    except (TypeError, ValueError):
        raise ValueError("Bad colour fill")
    if q["act"] == "keep" and p.get("tone") in ("black", "grey"):
        q["tone"] = p["tone"]
    return q


def _lab(rgb_u8: np.ndarray) -> np.ndarray:
    from skimage.color import rgb2lab
    return rgb2lab(rgb_u8.astype(np.float32) / 255.0).astype(np.float32)


def _border(lab: np.ndarray) -> np.ndarray:
    h, w = lab.shape[:2]
    b = max(3, int(min(h, w) * 0.015))
    return np.concatenate([lab[:b].reshape(-1, 3), lab[-b:].reshape(-1, 3),
                           lab[:, :b].reshape(-1, 3), lab[:, -b:].reshape(-1, 3)])


def scan_surface(img: Image.Image) -> dict:
    """Describe the strip along the scan's edges (at low resolution, so it's fast)."""
    small = img.convert("RGB")
    small.thumbnail((600, 600))
    lab = _lab(np.asarray(small))
    h, w = lab.shape[:2]
    b = max(3, int(min(h, w) * 0.015))
    sides = [lab[:b].reshape(-1, 3), lab[-b:].reshape(-1, 3),
             lab[:, :b].reshape(-1, 3), lab[:, -b:].reshape(-1, 3)]
    border = np.concatenate(sides)
    med = np.median(border, 0)
    spread = float(np.percentile(np.linalg.norm(border - med, axis=1), 75))
    meds = [np.median(s, 0) for s in sides]
    sidediff = float(max(np.linalg.norm(a - c) for a in meds for c in meds))
    return {
        "spread": spread,
        "sidediff": sidediff,
        # A uniform surface has a small spread; a frame-filling item has edges of many colours.
        "score": max(spread, sidediff / 2.5),
        # Scanner apps often blank everything outside the item to pure white.
        "pure_white": bool(med[0] > 97 and spread < 3),
    }


def colourful_fraction(img: Image.Image) -> float:
    """Share of the image that is strongly coloured (packaging, photos), as opposed to ink on paper."""
    small = img.convert("RGB")
    small.thumbnail((500, 500))
    lab = _lab(np.asarray(small))
    return float((np.hypot(lab[..., 1], lab[..., 2]) > 35).mean())


def classify_scan(img: Image.Image) -> tuple[str, str]:
    """Pick a mode for a scan: ink on blank white, item on a surface, or a full-frame item."""
    s = scan_surface(img)
    if s["pure_white"] and colourful_fraction(img) <= 0.2:
        return "ink", "white paper around the item"
    if s["score"] > 14:
        return "keep", "the item fills the whole scan"
    return "item", "item on a plain surface"


def outline_coverage(img: Image.Image, alpha: np.ndarray) -> float:
    """How much of everything that isn't plain surface the AI outline covers (0-1).

    When the AI latches onto one logo on a white ticket instead of the whole ticket,
    this drops well below 0.6 (in testing: 0.37-0.47 for misses, 0.66+ for good cut-outs).
    """
    from scipy import ndimage as ndi

    small = img.convert("RGB")
    small.thumbnail((700, 700))
    lab = _lab(np.asarray(small))
    border = _border(lab)
    surface = np.median(border, 0)
    spread = float(np.percentile(np.linalg.norm(border - surface, axis=1), 75))
    not_surface = np.linalg.norm(lab - surface, axis=2) > max(8.0, 3.0 * spread + 4.0)
    not_surface = ndi.binary_fill_holes(ndi.binary_closing(not_surface, iterations=3))
    ai = np.asarray(Image.fromarray(alpha, "L").resize(small.size)) > 127
    return float((ai & not_surface).sum() / max(not_surface.sum(), 1))


# ----- cards: find the edges, trim scanner slivers, straighten -----

def _line_point(theta: float, dist: float, other: float, horizontal: bool) -> float:
    """Position of a Hough line (x*cos t + y*sin t = d) at a given x (horizontal) or y (vertical)."""
    if horizontal:
        return (dist - other * np.cos(theta)) / np.sin(theta)
    return (dist - other * np.sin(theta)) / np.cos(theta)


def detect_card(img: Image.Image) -> list[list[float]] | None:
    """Find a card's straight edges near the borders of a scan.

    Only thin (<= 5%), plain, neutral strips that differ from the card are treated as
    scanner bed, so lines printed on the card itself are not mistaken for its edge.
    Returns the four corners (TL, TR, BR, BL) in 0-1 image coordinates, or None if
    there is nothing to trim.
    """
    from skimage import feature, transform

    small = img.convert("RGB")
    small.thumbnail((1200, 1200))
    W, H = small.size
    lab = _lab(np.asarray(small))
    edges = feature.canny(lab[..., 0], sigma=2.0, low_threshold=4, high_threshold=10)
    yy, xx = np.mgrid[0:H, 0:W]
    found: dict[str, tuple[float, float, float]] = {}
    for horizontal in (True, False):
        base = np.pi / 2 if horizontal else 0.0
        angles = base + np.deg2rad(np.linspace(-7, 7, 57))
        span, size = (W, H) if horizontal else (H, W)
        hs, th, ds = transform.hough_line(edges, theta=angles)
        peaks = transform.hough_line_peaks(hs, th, ds, num_peaks=30, min_distance=4, threshold=0.3 * span)
        for votes, a, d in zip(*peaks):
            ends = [_line_point(a, d, t, horizontal) for t in (0, span - 1)]
            first = np.mean(ends) < size / 2
            side = ("top" if first else "bottom") if horizontal else ("left" if first else "right")
            near, far = (min(ends), max(ends)) if first else (size - max(ends), size - min(ends))
            if far < 1 or near > 0.05 * size or far > 0.12 * size:
                continue
            # Pixels between the image edge and the line (the would-be scanner bed), and a band just inside.
            pos = _line_point(a, d, xx if horizontal else yy, horizontal)
            coord = yy if horizontal else xx
            offset = (pos - coord) if first else (coord - pos)  # > 0 on the outside of the line
            strip = lab[offset > 1.5]
            inner = lab[(offset < -3) & (offset > -10)]
            if len(strip) >= 3 * span:  # a strip at least ~3 px thick: check it looks like scanner bed
                smed = np.median(strip, 0)
                if np.percentile(np.linalg.norm(strip - smed, axis=1), 95) > 12:
                    continue  # not plain: printed content, not scanner bed
                if np.hypot(smed[1], smed[2]) > 12:
                    continue  # coloured: part of the item, not a white/grey scanner bed
                if len(inner) and np.linalg.norm(smed - np.median(inner, 0)) < 6:
                    continue  # no visible difference between "bed" and card
            outer = (near + far) / 2
            if side not in found or outer < found[side][0]:
                found[side] = (outer, a, d)
    if not found:
        return None
    lines = {
        "top": found.get("top", (0, np.pi / 2, 0.0))[1:],
        "bottom": found.get("bottom", (0, np.pi / 2, H - 1.0))[1:],
        "left": found.get("left", (0, 0.0, 0.0))[1:],
        "right": found.get("right", (0, 0.0, W - 1.0))[1:],
    }

    def meet(l1, l2):
        (a1, d1), (a2, d2) = l1, l2
        A = np.array([[np.cos(a1), np.sin(a1)], [np.cos(a2), np.sin(a2)]])
        x, y = np.linalg.solve(A, [d1, d2])
        return [float(np.clip(x / (W - 1), 0, 1)), float(np.clip(y / (H - 1), 0, 1))]

    quad = [meet(lines["top"], lines["left"]), meet(lines["top"], lines["right"]),
            meet(lines["bottom"], lines["right"]), meet(lines["bottom"], lines["left"])]
    x, y = np.array(quad).T
    area = 0.5 * abs(np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1)))
    if area < 0.6:
        return None
    full = np.array([[0, 0], [1, 0], [1, 1], [0, 1]], float)
    if np.abs(np.array(quad) - full).max() < 0.003:
        return None  # less than ~3 px at 1000 px: not worth resampling the image
    return quad


def warp_quad(img: Image.Image, quad: list[list[float]], resample=Image.Resampling.BICUBIC) -> Image.Image:
    """Cut out the quadrilateral (0-1 coordinates, TL TR BR BL) and straighten it to a rectangle."""
    w, h = img.size
    src = np.array([[x * (w - 1), y * (h - 1)] for x, y in quad])
    out_w = int(round(max(np.linalg.norm(src[1] - src[0]), np.linalg.norm(src[2] - src[3]))))
    out_h = int(round(max(np.linalg.norm(src[3] - src[0]), np.linalg.norm(src[2] - src[1]))))
    out_w, out_h = max(out_w, 8), max(out_h, 8)
    dst = np.array([[0, 0], [out_w - 1, 0], [out_w - 1, out_h - 1], [0, out_h - 1]], dtype=float)
    # Solve for the perspective transform mapping output pixels back to input pixels.
    A, b = [], []
    for (X, Y), (x, y) in zip(dst, src):
        A.append([X, Y, 1, 0, 0, 0, -x * X, -x * Y]); b.append(x)
        A.append([0, 0, 0, X, Y, 1, -y * X, -y * Y]); b.append(y)
    coeffs = np.linalg.solve(np.array(A, float), np.array(b, float))
    return img.transform((out_w, out_h), Image.Transform.PERSPECTIVE, tuple(coeffs), resample)


# ----- masks -----

def refine_mask(raw: np.ndarray, fill: bool, grow: float, soften: float) -> np.ndarray:
    """Fill holes, then grow/shrink and soften the edge. grow/soften are in px per 1000 px."""
    from scipy import ndimage as ndi

    # Matte cleanup: the AI's "certain" areas only reach ~240-254, which leaves cut-outs
    # slightly see-through, and its "certainly background" areas carry a faint haze.
    # Stretch 12..230 to 0..255 so insides are solid and the background is truly clear.
    raw = np.clip((raw.astype(np.float32) - 12.0) * (255.0 / 218.0) + 0.5, 0, 255).astype(np.uint8)
    binary = raw > 127
    filled = ndi.binary_fill_holes(binary) if fill else binary
    if abs(grow) < 1e-6 and soften < 1e-6:
        a = raw.copy()
        if fill:
            a[filled & ~binary] = 255  # fill holes but keep the AI's soft outer edge
        labels, n = ndi.label(a > 127)
        if n > 1:  # drop specks (dust, scanner noise) smaller than 0.2% of the image
            sizes = ndi.sum(np.ones_like(labels), labels, range(1, n + 1))
            a[np.isin(labels, np.flatnonzero(sizes < 0.002 * labels.size) + 1)] = 0
        return a
    h, w = raw.shape
    unit = min(h, w) / 1000.0
    # Work on at most ~12 MP: distance maps are memory-hungry.
    scale = min(1.0, (12e6 / (h * w)) ** 0.5)
    m = filled
    if scale < 1.0:
        m = np.asarray(Image.fromarray(filled.astype(np.uint8) * 255).resize(
            (int(w * scale), int(h * scale)), Image.Resampling.BILINEAR)) > 127
    sd = ndi.distance_transform_edt(m) - ndi.distance_transform_edt(~m)  # + inside, - outside
    width = max(1.0, soften * unit * scale)
    a = np.clip((sd + grow * unit * scale) / width + 0.5, 0.0, 1.0)
    a = (a * 255.0 + 0.5).astype(np.uint8)
    if scale < 1.0:
        a = np.asarray(Image.fromarray(a, "L").resize((w, h), Image.Resampling.BILINEAR))
    return a


def clean_fringe(rgb: Image.Image, alpha: np.ndarray) -> Image.Image:
    """Remove background colour bleeding into soft edges (only edge pixels are changed)."""
    from rembg.bg import decontaminate_cutout

    edge = (alpha > 0) & (alpha < 255)
    out = rgb.convert("RGBA")
    out.putalpha(Image.fromarray(alpha, "L"))
    if not edge.any():
        return out
    w, h = rgb.size
    scale = min(1.0, (8e6 / (w * h)) ** 0.5)  # estimate colours at <= 8 MP, it's slow
    small_rgb = rgb.convert("RGB").resize((max(1, int(w * scale)), max(1, int(h * scale))))
    small_a = Image.fromarray(alpha, "L").resize(small_rgb.size)
    fixed = decontaminate_cutout(small_rgb, small_a).convert("RGB").resize((w, h))
    arr = np.asarray(out).copy()
    arr[edge, :3] = np.asarray(fixed)[edge]
    return Image.fromarray(arr, "RGBA")


# ----- ink -----

def cutout_ink(img: Image.Image, strength: float = 0.0, paper_hex: str | None = None) -> Image.Image:
    """Make the paper transparent and keep the ink (stamps, handwriting, prints, drawings).

    Each pixel's opacity is its colour distance from the paper; its colour is then
    "un-mixed" from the paper so faint ink keeps its true colour on any background.
    strength (-1..1) makes the ink lighter or bolder; paper_hex overrides the paper colour.
    """
    from skimage.color import lab2rgb

    rgb = np.asarray(img.convert("RGB"))
    small = img.convert("RGB")
    small.thumbnail((800, 800))
    lab_s = _lab(np.asarray(small))
    L = lab_s[..., 0]
    bright = lab_s[L >= np.percentile(L, 60)]
    if paper_hex:
        c = int(paper_hex[1:], 16)
        paper = _lab(np.array([[[c >> 16 & 255, c >> 8 & 255, c & 255]]], np.uint8)).reshape(3)
    else:
        paper = np.median(bright, 0)
    spread = float(np.percentile(np.linalg.norm(bright - paper, axis=1), 75))
    d_s = np.linalg.norm(lab_s - paper, axis=2)
    lo = max(6.0, 2.5 * spread + 3.0)
    hi = float(np.clip(0.8 * np.percentile(d_s, 99.5), lo + 15.0, 60.0))
    k = 1.0 - 0.6 * float(strength)  # bolder ink: lower thresholds
    lo, hi = max(2.0, lo * k), max(max(2.0, lo * k) + 5.0, hi * k)
    P = lab2rgb(paper.reshape(1, 1, 3).astype(np.float64)).reshape(3).astype(np.float32)

    h, w = rgb.shape[:2]
    out = np.empty((h, w, 4), np.uint8)
    for y in range(0, h, 256):  # in strips, so a 36 MP scan doesn't need gigabytes of memory
        chunk = rgb[y:y + 256]
        d = np.linalg.norm(_lab(chunk) - paper, axis=2)
        a = np.clip((d - lo) / (hi - lo), 0.0, 1.0)
        c = chunk.astype(np.float32) / 255.0
        aa = np.maximum(a, 1e-3)[..., None]
        fg = np.clip((c - (1.0 - aa) * P) / aa, 0.0, 1.0)
        out[y:y + 256, :, :3] = (fg * 255.0 + 0.5).astype(np.uint8)
        out[y:y + 256, :, 3] = (a * 255.0 + 0.5).astype(np.uint8)
    if img.mode == "RGBA":
        out[..., 3] = np.minimum(out[..., 3], np.asarray(img.getchannel("A")))
    return Image.fromarray(out, "RGBA")


# ----- colour fills -----

FILL_TONES = {"black": 0.0, "grey": 128.0}


def pick_masks(frame: Image.Image, picks: list[dict]) -> list[np.ndarray]:
    """For each colour fill, how strongly each pixel of `frame` matches (uint8): full within
    `tol` of the picked colour, fading out by 1.5 x tol. A fill with `at` keeps only the
    patch connected to that point."""
    from scipy import ndimage

    rgb = np.asarray(frame.convert("RGB"))
    h, w = rgb.shape[:2]
    targets = [_lab(np.array([[[int(p["c"][i:i + 2], 16) for i in (1, 3, 5)]]], np.uint8)).reshape(3) for p in picks]
    masks = [np.empty((h, w), np.uint8) for _ in picks]
    for y in range(0, h, 256):  # in strips, like cutout_ink
        lab = _lab(rgb[y:y + 256])
        for p, t, m in zip(picks, targets, masks):
            d = np.linalg.norm(lab - t, axis=2)
            m[y:y + 256] = (np.clip((1.5 * p["tol"] - d) / (0.5 * p["tol"]), 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
    for p, m in zip(picks, masks):
        if "at" not in p:
            continue
        # The click was made on a smaller preview: look for the best match close to it.
        cx, cy = min(w - 1, int(p["at"][0] * w)), min(h - 1, int(p["at"][1] * h))
        r = max(2, round(max(w, h) / 1400 * 2))
        y0, x0 = max(0, cy - r), max(0, cx - r)
        win = m[y0:cy + r + 1, x0:cx + r + 1]
        if win.max() == 0:
            m[:] = 0
            continue
        sy, sx = np.unravel_index(int(win.argmax()), win.shape)
        labels, _ = ndimage.label(m > 0, structure=np.ones((3, 3), bool))
        m[labels != labels[y0 + sy, x0 + sx]] = 0
    return masks


def apply_picks(cut: Image.Image, frame: Image.Image, picks: list[dict] | None) -> Image.Image:
    """Colour fills from the editor, in order: keep (from the original, or recoloured as black
    or grey ink) or remove every pixel matching a picked colour."""
    if not picks:
        return cut
    masks = pick_masks(frame, picks)
    c = np.asarray(cut.convert("RGBA")).astype(np.float32)
    f = np.asarray(frame.convert("RGBA")).astype(np.float32)
    for p, mk in zip(picks, masks):
        m = (mk.astype(np.float32) / 255.0) * (f[..., 3] / 255.0)  # nothing outside the image
        a = c[..., 3] / 255.0
        if p["act"] == "erase":
            c[..., 3] = a * (1.0 - m) * 255.0
            continue
        tone = f[..., :3] if p.get("tone") not in FILL_TONES else FILL_TONES[p["tone"]]
        out_a = m + a * (1.0 - m)  # the fill laid over what's there
        c[..., :3] = (tone * m[..., None] + c[..., :3] * (a * (1.0 - m))[..., None]) / np.maximum(out_a, 1e-6)[..., None]
        c[..., 3] = out_a * 255.0
    return Image.fromarray(np.clip(c + 0.5, 0, 255).astype(np.uint8), "RGBA")


def keep_whole(img: Image.Image) -> Image.Image:
    return img if img.mode == "RGBA" else img.convert("RGBA")


# ----- rotation & tone -----

_QUARTER = {1: Image.Transpose.ROTATE_270, 2: Image.Transpose.ROTATE_180, 3: Image.Transpose.ROTATE_90}


def rotate_image(img: Image.Image, rot90: int = 0, angle: float = 0.0,
                 resample=Image.Resampling.BICUBIC) -> Image.Image:
    """Quarter turns (lossless) then a fine clockwise rotation; new corners are transparent."""
    if rot90 % 4:
        img = img.transpose(_QUARTER[rot90 % 4])
    if abs(angle) > 0.01:
        if img.mode not in ("RGBA", "L"):
            img = img.convert("RGBA")
        img = img.rotate(-angle, resample=resample, expand=True)
    return img


def inscribed_quad(w: int, h: int, angle: float, out_w: int, out_h: int) -> list[list[float]]:
    """Largest upright rectangle inside a w x h image rotated by `angle` (in the rotated frame, 0-1)."""
    a = math.radians(abs(angle))
    sin_a, cos_a = math.sin(a), math.cos(a)
    long_side, short_side = (w, h) if w >= h else (h, w)
    if short_side <= 2.0 * sin_a * cos_a * long_side or abs(sin_a - cos_a) < 1e-10:
        x = 0.5 * short_side
        wr, hr = (x / sin_a, x / cos_a) if w >= h else (x / cos_a, x / sin_a)
    else:
        cos_2a = cos_a * cos_a - sin_a * sin_a
        wr, hr = (w * cos_a - h * sin_a) / cos_2a, (h * cos_a - w * sin_a) / cos_2a
    inset = 1.5  # px: stay clear of the anti-aliased edge of the rotated image
    x0, y0 = ((out_w - wr) / 2 + inset) / (out_w - 1), ((out_h - hr) / 2 + inset) / (out_h - 1)
    x1, y1 = 1 - x0, 1 - y0
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


def estimate_skew(img: Image.Image) -> float:
    """Angle (degrees, clockwise) that would straighten the dominant lines/edges in a scan."""
    from skimage import feature, transform

    small = img.convert("L")
    small.thumbnail((1000, 1000))
    edges = feature.canny(np.asarray(small, dtype=np.float32) / 255.0, sigma=2.0)
    dev = np.deg2rad(np.linspace(-20, 20, 161))
    hs, th, ds = transform.hough_line(edges, theta=np.concatenate([dev, dev + np.pi / 2]))
    votes, angles, _ = transform.hough_line_peaks(hs, th, ds, num_peaks=25, min_distance=5)
    if not len(votes):
        return 0.0
    skew = np.where(angles > np.pi / 4, angles - np.pi / 2, angles)  # deviation from vertical/horizontal
    order = np.argsort(skew)
    cum = np.cumsum(votes[order])
    median = skew[order][np.searchsorted(cum, cum[-1] / 2)]  # vote-weighted median
    return round(float(-np.rad2deg(median)), 2)  # rotating by minus the skew straightens it


def apply_tone(img: Image.Image, adjust: dict) -> Image.Image:
    """Brightness / contrast / saturation (and optional auto levels, then invert) on colour,
    never on transparency."""
    b, c, s = adjust.get("bright", 0.0), adjust.get("contrast", 0.0), adjust.get("sat", 0.0)
    auto, invert = adjust.get("autotone", False), adjust.get("invert", False)
    if not (b or c or s or auto or invert):
        return img
    alpha = img.getchannel("A") if img.mode == "RGBA" else None
    rgb = img.convert("RGB")
    if auto:
        mask = alpha.point(lambda v: 255 if v > 128 else 0) if alpha is not None else None
        rgb = ImageOps.autocontrast(rgb, cutoff=0.5, mask=mask, preserve_tone=True)
    if b:
        rgb = ImageEnhance.Brightness(rgb).enhance(1.0 + 0.6 * b)
    if c:
        rgb = ImageEnhance.Contrast(rgb).enhance(1.0 + 0.8 * c)
    if s:
        rgb = ImageEnhance.Color(rgb).enhance(1.0 + s)
    if invert:  # white becomes black: white ink for dark backgrounds, or a negative made positive
        rgb = ImageOps.invert(rgb)
    if alpha is not None:
        rgb.putalpha(alpha)
    return rgb


def trim_transparent(img: Image.Image) -> Image.Image:
    """Crop away empty transparent space around a cut-out, leaving a small margin."""
    if img.mode != "RGBA":
        return img
    box = img.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
    if not box:
        return img
    pad = max(2, int(0.01 * max(img.size)))
    box = (max(0, box[0] - pad), max(0, box[1] - pad), min(img.width, box[2] + pad), min(img.height, box[3] + pad))
    return img if box == (0, 0, img.width, img.height) else img.crop(box)


# ----- the pipeline -----

def render(img: Image.Image, mode: str, adjust: dict, get_mask, fringe_default: bool = False,
           geometry_only: bool = False) -> dict:
    """Produce a cut-out for one image.

    Order: rotate -> crop/straighten -> cut out -> tone. get_mask() returns the AI's raw
    mask for the *unrotated* image (uint8, same size as img) and is only called when
    needed; it goes through the same rotation and crop so it lines up.

    Returns {cut, frame, orig, used, why, quad}: `frame` is the toned original that `cut`
    lines up with (used by the keep brush), `orig` the same without tone (for "Before").
    With geometry_only, only rotation is applied (used by the crop tool).
    """
    rot90, angle = adjust.get("rot90", 0), adjust.get("angle", 0.0)
    turned = rotate_image(img, rot90)
    if geometry_only:
        geo = rotate_image(turned, 0, angle)
        return {"cut": keep_whole(geo), "frame": geo, "orig": geo, "used": "keep", "why": "", "quad": None}
    used, why = mode, ""
    if mode == "auto":
        used, why = classify_scan(turned)
    geo = rotate_image(turned, 0, angle)

    quad = adjust.get("crop")
    no_crop = quad is not None and np.abs(np.array(quad) - [[0, 0], [1, 0], [1, 1], [0, 1]]).max() < 0.002
    if no_crop:
        quad = None  # the user chose "No crop": don't trim automatically either
    elif quad is None and abs(angle) > 0.01 and used in ("keep", "card", "ink"):
        quad = inscribed_quad(turned.width, turned.height, angle, geo.width, geo.height)
        if used == "keep":
            used, why = "card", "straightened"
    elif quad is None and (used == "card" or (mode == "auto" and used == "keep")):
        quad = detect_card(geo)
        if quad is not None and used == "keep":
            used, why = "card", "trimmed the scanner edge and straightened"
    elif quad is not None and used == "keep":
        used, why = "card", "cropped by hand"
    frame = warp_quad(geo, quad) if quad else geo

    def finish(cut: Image.Image) -> dict:
        # Colour fills go before tone, so a black fill stays the same as the ink when inverted.
        return {"cut": apply_tone(apply_picks(cut, frame, adjust.get("picks")), adjust),
                "frame": apply_tone(frame, adjust), "orig": frame, "used": used, "why": why, "quad": quad}

    if used in ("item", "photo"):
        turned_mask = rotate_image(Image.fromarray(get_mask(), "L"), rot90)
        # Auto's safety checks run on the scan as scanned (before straightening adds empty
        # corners), and stay on unless the user has hand-tuned the edge itself.
        if mode == "auto" and used == "item" and not ({"grow", "soften", "fill", "fringe"} & adjust.keys()):
            check = refine_mask(np.asarray(turned_mask), True, 0.0, 0.0)
            edge = np.concatenate([check[0], check[-1], check[:, 0], check[:, -1]])
            if (edge > 127).mean() > 0.35:
                used, why = "keep", "the item runs off the edge of the scan"
            elif outline_coverage(turned, check) < 0.55:
                if colourful_fraction(turned) > 0.2:
                    used, why = "keep", "the AI only found part of this colourful item"
                else:
                    used, why = "ink", "the AI only found part of the item"
            if used != "item" and quad is None and abs(angle) > 0.01:
                quad = inscribed_quad(turned.width, turned.height, angle, geo.width, geo.height)
                frame = warp_quad(geo, quad)
                if used == "keep":
                    used = "card"
    if used in ("item", "photo"):
        mask = rotate_image(turned_mask, 0, angle, Image.Resampling.BILINEAR)
        if quad:
            mask = warp_quad(mask, quad, Image.Resampling.BILINEAR)
        raw = np.asarray(mask)
        fill = adjust.get("fill", used == "item")
        alpha = refine_mask(raw, fill, adjust.get("grow", 0.0), adjust.get("soften", 0.0))
        if frame.mode == "RGBA":
            alpha = np.minimum(alpha, np.asarray(frame.getchannel("A")))
        if adjust.get("fringe", fringe_default):
            cut = clean_fringe(frame, alpha)
        else:
            cut = frame.convert("RGBA")
            cut.putalpha(Image.fromarray(alpha, "L"))
        return finish(cut)

    if used == "ink":
        return finish(cutout_ink(frame, adjust.get("ink", 0.0), adjust.get("paper")))
    return finish(keep_whole(frame))  # keep / card


def apply_edits(cut: Image.Image, frame: Image.Image, edits: Image.Image) -> Image.Image:
    """Apply touch-up brush strokes: red channel = keep (restore the original), green = erase."""
    e = np.asarray(edits.convert("RGB").resize(cut.size, Image.Resampling.BILINEAR)).astype(np.float32) / 255.0
    keep, erase = e[..., 0:1], e[..., 1]
    c = np.asarray(cut.convert("RGBA")).astype(np.float32)
    f = np.asarray(frame.convert("RGBA")).astype(np.float32)
    keep = keep * (f[..., 3:4] / 255.0)  # nothing to bring back outside the image (rotated corners)
    rgb = c[..., :3] * (1.0 - keep) + f[..., :3] * keep
    a = np.maximum(c[..., 3], keep[..., 0] * 255.0) * (1.0 - erase)
    out = np.dstack([rgb, a])
    return Image.fromarray(np.clip(out + 0.5, 0, 255).astype(np.uint8), "RGBA")


def composite(cutout: Image.Image, rgb: tuple[int, int, int]) -> Image.Image:
    bg = Image.new("RGB", cutout.size, rgb)
    bg.paste(cutout, mask=cutout.getchannel("A"))
    return bg


def save_png_atomic(img: Image.Image, target: Path, icc: bytes | None = None) -> None:
    """Write next to the target first, then rename, so a crash never leaves half a file."""
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f".{target.name}.partial")
    kwargs = {"optimize": False, "compress_level": 6}
    if icc:
        kwargs["icc_profile"] = icc
    try:
        img.save(tmp, "PNG", **kwargs)
        os.replace(tmp, target)
    finally:
        if tmp.exists():
            tmp.unlink()


def thumbnail_bytes(img: Image.Image, max_side: int, fmt: str) -> bytes:
    im = img.copy()
    im.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    if fmt == "WEBP":
        im.save(buf, "WEBP", quality=88, method=4)
    else:
        if im.mode != "RGB":
            im = im.convert("RGB")
        im.save(buf, "JPEG", quality=85)
    return buf.getvalue()


def preview_of_file(path: Path, max_side: int) -> bytes:
    """Browser-friendly preview of any supported image (HEIC/TIFF/16-bit included)."""
    with Image.open(path) as probe:
        if probe.format == "JPEG":
            probe.draft("RGB", (max_side * 2, max_side * 2))  # fast JPEG downscale on decode
            probe.load()
            img = ImageOps.exif_transpose(probe).convert("RGB")
            return thumbnail_bytes(img, max_side, "JPEG")
    img, _ = load_image(path)
    return thumbnail_bytes(img, max_side, "WEBP" if img.mode == "RGBA" else "JPEG")
