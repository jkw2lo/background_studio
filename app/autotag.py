"""Auto-suggest a category for each picture, entirely on this computer.

Uses OpenAI's CLIP (ViT-B/16, MIT licence) as two small ONNX models, run on the CPU:
an image model that turns a picture into a 512-number "fingerprint", and a text model
that does the same for a category name. A suggestion combines two signals:

  * how well the picture matches the category's *name* (works from the first picture), and
  * how similar it is to pictures you have already put in that category (gets better as you go).

The weights are downloaded once by setup.sh from a pinned Hugging Face revision and
checked against SHA-256 hashes; the app itself never downloads anything.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import threading
import unicodedata
import urllib.request
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

from . import engine

ROOT = Path(__file__).resolve().parent.parent
CLIP_DIR = ROOT / "models" / "clip-vit-base-patch16"
REVISION = "342fdf2f67aded64d138ff074745fb4a5d2bba5f"  # huggingface.co/Xenova/clip-vit-base-patch16
FILES = {  # name in the repo -> SHA-256
    "onnx/vision_model_quantized.onnx": "44eece4fe5fe4e0359a88268a327adf758633a1aade3917690b952bef1501f96",
    "onnx/text_model_quantized.onnx": "9106b51e6c663a56b99182ec617c2b3d53577b037e7e24a7717eb78048a0c97a",
    "tokenizer.json": "72ed5c96db5729294468543e4bc75fce14ca63f58e37300290189ba1c1e52b85",
}
SIZE_MB = 152
MEAN = np.array([0.48145466, 0.4578275, 0.40821073], np.float32)
STD = np.array([0.26862954, 0.26130258, 0.27577711], np.float32)
PROMPTS = ("a photo of a {}.", "a scan of a {}.", "a {}.", "{}")
QUERY_PROMPTS = ("{}", "a photo of {}.", "a scan of {}.")


def installed() -> bool:
    return all((CLIP_DIR / Path(f).name).exists() for f in FILES)


def download() -> None:
    """Used by setup.sh only."""
    CLIP_DIR.mkdir(parents=True, exist_ok=True)
    for name, sha in FILES.items():
        target = CLIP_DIR / Path(name).name
        if target.exists() and _sha256(target) == sha:
            print(f"  {target.name}: already installed")
            continue
        url = f"https://huggingface.co/Xenova/clip-vit-base-patch16/resolve/{REVISION}/{name}"
        print(f"  Downloading {target.name} from huggingface.co ...", flush=True)
        tmp = target.with_name(target.name + ".partial")
        with urllib.request.urlopen(url, timeout=60) as r, open(tmp, "wb") as f:
            while chunk := r.read(1 << 20):
                f.write(chunk)
        if _sha256(tmp) != sha:
            tmp.unlink()
            raise SystemExit(f"Checksum mismatch for {target.name}; nothing was installed. Try again later.")
        os.replace(tmp, target)
    print("  auto-suggest model installed (checksums verified)")


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------- CLIP's text tokenizer (byte-level BPE), so no extra library is needed ----------
def _bytes_to_unicode() -> dict[int, str]:
    bs = list(range(ord("!"), ord("~") + 1)) + list(range(ord("¡"), ord("¬") + 1)) + list(range(ord("®"), ord("ÿ") + 1))
    cs = bs[:]
    n = 0
    for b in range(256):
        if b not in bs:
            bs.append(b)
            cs.append(256 + n)
            n += 1
    return dict(zip(bs, map(chr, cs)))


# Same split as CLIP's \p{L}+ | \p{N} | other-symbols rule, written for Python's re.
_SPLIT = re.compile(r"'s|'t|'re|'ve|'m|'ll|'d|[^\W\d_]+|\d|(?:[^\s\w]|_)+")


class Tokenizer:
    def __init__(self, path: Path):
        d = json.loads(path.read_text("utf-8"))
        self.vocab: dict[str, int] = d["model"]["vocab"]
        merges = d["model"]["merges"]
        self.ranks = {tuple(m.split(" ") if isinstance(m, str) else m): i for i, m in enumerate(merges)}
        self.byte = _bytes_to_unicode()
        self.sot, self.eot = self.vocab["<|startoftext|>"], self.vocab["<|endoftext|>"]

    @lru_cache(maxsize=4096)
    def _bpe(self, token: str) -> tuple[str, ...]:
        word = list(token[:-1]) + [token[-1] + "</w>"]
        while len(word) > 1:
            pairs = [(self.ranks.get((a, b), 1 << 30), i) for i, (a, b) in enumerate(zip(word, word[1:]))]
            rank, i = min(pairs)
            if rank == 1 << 30:
                break
            a, b = word[i], word[i + 1]
            merged, j = [], 0
            while j < len(word):  # merge every occurrence of this pair
                if j < len(word) - 1 and word[j] == a and word[j + 1] == b:
                    merged.append(a + b)
                    j += 2
                else:
                    merged.append(word[j])
                    j += 1
            word = merged
        return tuple(word)

    def encode(self, text: str) -> list[int]:
        text = re.sub(r"\s+", " ", unicodedata.normalize("NFC", text)).strip().lower()
        ids = [self.sot]
        for piece in _SPLIT.findall(text):
            token = "".join(self.byte[b] for b in piece.encode("utf-8"))
            ids += [self.vocab[p] for p in self._bpe(token) if p in self.vocab]
        return ids[:76] + [self.eot]


# ---------- the models ----------
class Clip:
    def __init__(self):
        self.lock = threading.Lock()
        self._vision = self._text = self._tok = None

    def _load(self):
        if self._vision is None:
            if not installed():
                raise RuntimeError("The auto-suggest model isn't installed. Quit the app and run ./setup.sh once.")
            import onnxruntime as ort

            opts = ort.SessionOptions()
            opts.log_severity_level = 3
            prov = ["CPUExecutionProvider"]  # never a remote or CoreML provider (see models.py)
            self._vision = ort.InferenceSession(str(CLIP_DIR / "vision_model_quantized.onnx"), opts, providers=prov)
            self._text = ort.InferenceSession(str(CLIP_DIR / "text_model_quantized.onnx"), opts, providers=prov)
            self._tok = Tokenizer(CLIP_DIR / "tokenizer.json")

    @staticmethod
    def pixels(img: Image.Image) -> np.ndarray:
        if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
            # Cut-outs: put them on white and keep the whole outline in view (no cropping).
            rgba = img.convert("RGBA")
            bbox = rgba.getchannel("A").getbbox() or (0, 0, *rgba.size)
            rgba = rgba.crop(bbox)
            side = max(rgba.size)
            canvas = Image.new("RGB", (side, side), (255, 255, 255))
            canvas.paste(rgba, ((side - rgba.width) // 2, (side - rgba.height) // 2), rgba)
            im = canvas.resize((224, 224), Image.Resampling.BICUBIC)
        else:  # what CLIP was trained on: shortest side to 224, centre crop
            im = img.convert("RGB")
            s = 224 / min(im.size)
            im = im.resize((max(224, round(im.width * s)), max(224, round(im.height * s))), Image.Resampling.BICUBIC)
            left, top = (im.width - 224) // 2, (im.height - 224) // 2
            im = im.crop((left, top, left + 224, top + 224))
        a = (np.asarray(im, np.float32) / 255.0 - MEAN) / STD
        return a.transpose(2, 0, 1)[None]

    def embed_image(self, img: Image.Image) -> np.ndarray:
        px = self.pixels(img)
        with self.lock:
            self._load()
            v = self._vision.run(None, {"pixel_values": px})[0][0]
        return (v / np.linalg.norm(v)).astype(np.float32)

    def embed_query(self, text: str) -> np.ndarray:
        """A free-text search like "temple" or "something pink"."""
        return self._embed_texts(tuple(p.format(text.strip()) for p in QUERY_PROMPTS))

    def embed_name(self, name: str) -> np.ndarray:
        """A category name, averaged over a few phrasings ("a photo of a …", "a scan of a …")."""
        return self._embed_texts(tuple(p.format(name) for p in PROMPTS))

    @lru_cache(maxsize=512)
    def _embed_texts(self, texts: tuple[str, ...]) -> np.ndarray:
        with self.lock:
            self._load()
            vs = []
            for t in texts:
                ids = np.array([self._tok.encode(t)], np.int64)
                v = self._text.run(None, {"input_ids": ids})[0][0]
                vs.append(v / np.linalg.norm(v))
        m = np.mean(vs, axis=0)
        return (m / np.linalg.norm(m)).astype(np.float32)


def load_small(path: Path) -> Image.Image:
    """Open a picture at a modest size, quickly (big JPEGs are decoded straight at a small size)."""
    with Image.open(path) as probe:
        if probe.format == "JPEG":
            probe.draft("RGB", (448, 448))
            probe.load()
            img = ImageOps.exif_transpose(probe).convert("RGB")
        else:
            img = None
    if img is None:
        img, _ = engine.load_image(path)
    img.thumbnail((640, 640), Image.Resampling.BILINEAR)
    return img


def dhash(img: Image.Image, n: int = 16) -> np.ndarray:
    """256-bit "difference hash": which neighbouring pixels get brighter. Near-identical scans
    differ in a handful of bits; look-alikes (two different fortune slips) in dozens."""
    if img.mode in ("RGBA", "LA", "P"):
        rgba = img.convert("RGBA")
        bg = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        bg.alpha_composite(rgba)
        img = bg
    g = np.asarray(img.convert("L").resize((n + 1, n), Image.Resampling.BILINEAR), np.int16)
    return (g[:, 1:] > g[:, :-1]).flatten()


def _softmax(x: np.ndarray) -> np.ndarray:
    e = np.exp(x - x.max())
    return e / e.sum()


def rank(x: np.ndarray, names: np.ndarray, examples: list[np.ndarray | None]) -> np.ndarray:
    """Probabilities over categories for one picture.

    names:    (C, 512) category-name fingerprints
    examples: per category, an (n, 512) array of pictures already tagged with it (or None)
    """
    log_p = np.log(_softmax(100.0 * (names @ x)) + 1e-9)  # 100 = CLIP's own logit scale
    have = [i for i, e in enumerate(examples) if e is not None and len(e)]
    if have:
        sims = np.full(len(examples), np.nan, np.float32)
        for i in have:
            s = np.sort(examples[i] @ x)[::-1]
            sims[i] = s[: min(3, len(s))].mean()  # closest few look-alikes
        sims[np.isnan(sims)] = np.nanmean(sims)  # categories without examples: neutral
        n = sum(len(examples[i]) for i in have)
        w = min(0.85, n / (n + 8.0))  # trust your own examples more as there are more of them
        log_p = (1 - w) * log_p + w * np.log(_softmax(sims / 0.02) + 1e-9)
    return _softmax(log_p)


if __name__ == "__main__":
    if sys.argv[1:] == ["download"]:
        download()
    else:
        print("Usage: python -m app.autotag download")
