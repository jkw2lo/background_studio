"""Prepare the lite demo's assets with the real engine and models.

    .venv/bin/python lite/tools/make_demo.py [--check DIR]

For each demo image this writes lite/demo/<id>/:
  orig.jpg                 the image the browser edits (at most 1200 px)
  thumb.jpg                320 px grid thumbnail
  mask-<model>.png         the AI's raw outline from each model, the only step the browser can't do
and lite/demo/demo.json with what Auto decided, the detected card corners, the skew and the
measured model times. --check DIR also writes the real engine's default result for every
method, to compare with the browser's port (lite/lite-engine.js).

Run it after ./setup.sh --model birefnet-general-lite (both models must be installed).
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from app import engine, models  # noqa: E402

LITE = ROOT / "lite"
SRC = LITE / "demo-src"
OUT = LITE / "demo"
MAX_SIDE = 1200
MODELS = ["isnet-general-use", "birefnet-general-lite"]

# id, file in demo-src (copied from scikit-image for the photos), folder shown in the app, credit
DEMOS = [
    ("sticker", "sticker-on-desk.png", "scans", "Drawn for this demo"),
    ("stamp", "stamped-note.png", "scans", "Drawn for this demo"),
    ("ticket", "museum-ticket.png", "scans", "Drawn for this demo"),
    ("coffee", "coffee.png", "photos", "Rachel Michetti, CC0 (scikit-image sample data)"),
    ("cat", "chelsea.png", "photos", "Stefan van der Walt, CC0 (scikit-image sample data)"),
    ("astronaut", "astronaut.png", "photos", "NASA, public domain (scikit-image sample data)"),
    ("rocket", "rocket.jpg", "photos", "SpaceX, public domain (scikit-image sample data)"),
]


def copy_sample_photos() -> None:
    import skimage

    data = Path(skimage.__file__).parent / "data"
    for _, name, folder, _ in DEMOS:
        if folder == "photos" and not (SRC / name).exists():
            shutil.copy(data / name, SRC / name)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", type=Path, help="also write the engine's result per method here")
    args = ap.parse_args()
    missing = [m for m in MODELS if not models.model_path(m)]
    if missing:
        sys.exit(f"Install these models first: {', '.join(missing)}")
    copy_sample_photos()
    sessions = {m: models.get_session(m) for m in MODELS}
    from rembg import remove

    out = []
    for demo_id, name, folder, credit in DEMOS:
        img, _ = engine.load_image(SRC / name)
        img = img.convert("RGB")
        img.thumbnail((MAX_SIDE, MAX_SIDE), Image.Resampling.LANCZOS)
        d = OUT / demo_id
        d.mkdir(parents=True, exist_ok=True)
        img.save(d / "orig.jpg", quality=90)
        thumb = img.copy()
        thumb.thumbnail((320, 320), Image.Resampling.LANCZOS)
        thumb.save(d / "thumb.jpg", quality=85)
        img = Image.open(d / "orig.jpg").convert("RGB")  # work from exactly what the browser gets

        masks, seconds, auto = {}, {}, {}
        for m in MODELS:
            remove(img, session=sessions[m], only_mask=True)  # warm up, so times are per image
            t = time.perf_counter()
            mask = remove(img, session=sessions[m], only_mask=True).convert("L")
            seconds[m] = round(time.perf_counter() - t, 2)
            if mask.size != img.size:
                mask = mask.resize(img.size, Image.Resampling.BILINEAR)
            mask.save(d / f"mask-{m}.png", optimize=True)
            masks[m] = np.asarray(mask)
            r = engine.render(img, "auto", {}, lambda m=m: masks[m])
            auto[m] = {"used": r["used"], "why": r["why"], "quad": r["quad"]}
        card = engine.render(img, "card", {}, lambda: masks[MODELS[0]])
        entry = {
            "id": demo_id, "name": name, "rel": f"{folder}/{name}", "folder": folder, "credit": credit,
            "size": list(img.size), "seconds": seconds, "auto": auto,
            "card_quad": card["quad"], "skew": engine.estimate_skew(img),
        }
        out.append(entry)
        print(f"  {demo_id:<10} auto: {auto[MODELS[0]]['used']:<5} {auto[MODELS[1]]['used']:<5}  "
              f"skew {entry['skew']:+.2f}  {seconds}")

        if args.check:
            args.check.mkdir(parents=True, exist_ok=True)
            for mode in ("item", "photo", "ink", "card", "keep"):
                r = engine.render(img, mode, {}, lambda: masks[MODELS[0]])
                r["cut"].save(args.check / f"{demo_id}-{mode}.png")

    (OUT / "demo.json").write_text(json.dumps({"models": MODELS, "images": out}, indent=1) + "\n")
    print(f"Wrote {OUT / 'demo.json'}")


if __name__ == "__main__":
    main()
