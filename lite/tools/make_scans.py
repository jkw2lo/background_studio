"""Draw the synthetic "scans" used by the lite demo (a sticker, a stamped note, a tilted ticket).

    .venv/bin/python lite/tools/make_scans.py

Writes lite/demo-src/*.png. Everything is drawn from code (Pillow's bundled Aileron font),
so the demo has no third-party artwork. The photo demos are scikit-image sample images
(public domain / CC0); make_demo.py copies those.
"""

from __future__ import annotations

import math
import random
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

OUT = Path(__file__).resolve().parent.parent / "demo-src"


def font(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.load_default(size)


def noise(w: int, h: int, amount: float, blur: float, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = Image.fromarray((rng.random((h, w)) * 255).astype(np.uint8), "L").filter(ImageFilter.GaussianBlur(blur))
    a = np.asarray(n, np.float32)
    return (a - a.mean()) / (a.std() + 1e-6) * amount


def surface(w: int, h: int, rgb: tuple[int, int, int], seed: int) -> Image.Image:
    """A plain scanner-lid / desk surface: flat colour with soft grain and a faint gradient."""
    base = np.ones((h, w, 3), np.float32) * np.array(rgb, np.float32)
    grain = noise(w, h, 3.0, 0.6, seed) + noise(w, h, 4.0, 18, seed + 1)
    ramp = np.linspace(-4, 4, w)[None, :]
    base += (grain + ramp)[..., None]
    return Image.fromarray(np.clip(base, 0, 255).astype(np.uint8), "RGB")


def shadow_paste(bg: Image.Image, fg: Image.Image, xy: tuple[int, int], blur: float = 6, offset: int = 4,
                 strength: int = 70) -> None:
    alpha = fg.getchannel("A")
    sh = Image.new("L", bg.size, 0)
    sh.paste(alpha.point(lambda v: v * strength // 255), (xy[0] + offset, xy[1] + offset))
    sh = sh.filter(ImageFilter.GaussianBlur(blur))
    bg.paste(Image.new("RGB", bg.size, (40, 36, 30)), (0, 0), sh)
    bg.paste(fg, xy, fg)


def sticker() -> Image.Image:
    """A die-cut travel sticker with a white border, lying on a grey desk."""
    S = 640
    art = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(art)
    c = S // 2
    d.ellipse([20, 20, S - 20, S - 20], fill=(255, 255, 255, 255))           # die-cut white border
    d.ellipse([48, 48, S - 48, S - 48], fill=(23, 112, 128, 255))            # sea
    d.pieslice([48, 48, S - 48, S - 48], 180, 360, fill=(250, 196, 120, 255))  # sky
    d.ellipse([c - 85, 150, c + 85, 320], fill=(239, 98, 63, 255))           # sun
    for i, y in enumerate(range(c + 10, S - 70, 34)):                         # waves
        pts = [(x, y + 9 * math.sin((x + i * 30) / 26)) for x in range(40, S - 40, 6)]
        d.line(pts, fill=(255, 255, 255, 200), width=7)
    ring = Image.new("L", (S, S), 0)
    ImageDraw.Draw(ring).ellipse([48, 48, S - 48, S - 48], fill=255)
    art.putalpha(ImageChops.multiply(art.getchannel("A"), ImageChops.lighter(ring, _disc(S, 20))))
    f = font(70)
    label = "OKINAWA"
    tw = d.textlength(label, font=f)
    d.rounded_rectangle([c - tw / 2 - 26, 372, c + tw / 2 + 26, 462], 22, fill=(255, 255, 255, 255))
    d.text((c, 418), label, font=f, fill=(23, 82, 98, 255), anchor="mm")
    d.text((c, 505), "2026", font=font(36), fill=(255, 255, 255, 255), anchor="mm")
    art = art.rotate(-8, Image.Resampling.BICUBIC, expand=True)

    bg = surface(1100, 900, (178, 176, 170), 3)
    shadow_paste(bg, art, ((1100 - art.width) // 2 + 30, (900 - art.height) // 2 - 10))
    return bg


def _disc(S: int, inset: int) -> Image.Image:
    m = Image.new("L", (S, S), 0)
    ImageDraw.Draw(m).ellipse([inset, inset, S - inset, S - inset], fill=255)
    return m


def stamped_note() -> Image.Image:
    """A rubber stamp and a signature on white paper, as a scanner app would save it."""
    W, H = 1000, 760
    ink = Image.new("L", (W, H), 0)   # stamp ink coverage
    d = ImageDraw.Draw(ink)
    x0, y0, x1, y1 = 170, 150, 830, 430
    d.rounded_rectangle([x0, y0, x1, y1], 18, outline=255, width=12)
    d.rounded_rectangle([x0 + 22, y0 + 22, x1 - 22, y1 - 22], 10, outline=255, width=4)
    d.text(((x0 + x1) / 2, y0 + 105), "RECEIVED", font=font(104), fill=255, anchor="mm")
    d.text(((x0 + x1) / 2, y0 + 205), "30 OCT 2026", font=font(56), fill=255, anchor="mm")
    ink = ink.rotate(4, Image.Resampling.BICUBIC, center=((x0 + x1) / 2, (y0 + y1) / 2))
    # Rubber stamps print unevenly: knock out speckles and soften the edge.
    speck = noise(W, H, 1.0, 1.4, 11)
    ink_a = np.asarray(ink.filter(ImageFilter.GaussianBlur(1.1)), np.float32) / 255
    ink_a *= np.clip(0.95 + 0.6 * speck, 0, 1)

    sig = Image.new("L", (W, H), 0)
    sd = ImageDraw.Draw(sig)
    rng = random.Random(5)
    pts, x, y = [], 300.0, 560.0
    for t in range(240):
        x += 2.2
        y = 560 + 34 * math.sin(t / 9.0) * math.sin(t / 37.0) + rng.uniform(-1.2, 1.2)
        pts.append((x, y))
    sd.line(pts, fill=255, width=5, joint="curve")
    sd.line([(340, 610), (760, 596)], fill=255, width=4)
    sig_a = np.asarray(sig.filter(ImageFilter.GaussianBlur(0.8)), np.float32) / 255

    paper = np.full((H, W, 3), 255.0, np.float32)
    red = np.array([196, 38, 48], np.float32)
    blue = np.array([28, 52, 140], np.float32)
    paper = paper * (1 - ink_a[..., None] * 0.92) + red * ink_a[..., None] * 0.92
    paper = paper * (1 - sig_a[..., None]) + blue * sig_a[..., None]
    return Image.fromarray(np.clip(paper, 0, 255).astype(np.uint8), "RGB")


def ticket() -> Image.Image:
    """An admission ticket scanned slightly crooked, filling most of the scanner bed."""
    TW, TH = 1080, 560
    t = Image.new("RGB", (TW, TH), (246, 236, 214))
    d = ImageDraw.Draw(t)
    d.rectangle([0, 0, 230, TH], fill=(204, 74, 58))
    for y in range(24, TH, 36):                                  # perforation
        d.ellipse([222, y, 238, y + 16], fill=(246, 236, 214))
    d.text((115, TH / 2), "No. 0427", font=font(40), fill=(255, 240, 225), anchor="mm")
    d.text((290, 70), "MUSEUM OF PAPER", font=font(64), fill=(40, 38, 52))
    d.text((292, 160), "General admission · one adult", font=font(38), fill=(90, 84, 92))
    d.line([(290, 236), (1020, 236)], fill=(204, 74, 58), width=5)
    d.text((290, 270), "ADMIT ONE", font=font(120), fill=(30, 98, 110))
    d.text((292, 440), "Thursday 29 October 2026 · 10:30", font=font(36), fill=(90, 84, 92))
    grain = noise(TW, TH, 2.5, 0.7, 21)[..., None]
    t = Image.fromarray(np.clip(np.asarray(t, np.float32) + grain, 0, 255).astype(np.uint8), "RGB")
    t = t.convert("RGBA").rotate(-2.6, Image.Resampling.BICUBIC, expand=True)

    # Scanner apps crop close to the item: the tilted corners run off the scan, leaving
    # slivers of the dark lid along the edges (Auto keeps it as a card and straightens it).
    bed = surface(t.width - 20, t.height - 20, (58, 58, 62), 31)
    bed.paste(t, (-10, -10), t)
    return bed


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, fn in (("sticker-on-desk", sticker), ("stamped-note", stamped_note), ("museum-ticket", ticket)):
        img = fn()
        img.save(OUT / f"{name}.png", optimize=True)
        print(f"  {name}.png  {img.width}x{img.height}")


if __name__ == "__main__":
    main()
