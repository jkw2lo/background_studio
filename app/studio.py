"""The batch: queued images, settings, the worker thread and the output manifest.

Safety rules enforced here (not just in the UI):
  * Originals are only ever opened for reading.
  * The output folder must be separate from every folder images were added from.
  * A file in the output folder is only overwritten if this app created it
    (it is listed in the folder's manifest). Anything else is left untouched.
  * Every write goes to a temporary file first and is then renamed into place.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import shutil
import threading
import time
import uuid
import zipfile
from collections import OrderedDict, deque
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image

from . import engine, models

MANIFEST_NAME = ".background-studio.json"
PRIVATE_DIR = ".background-studio"  # cached AI outlines and touch-up edits, inside the output folder
BACKGROUNDS = {"transparent", "white", "black", "custom"}
HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


@dataclass
class Settings:
    output_dir: str = str(Path.home() / "Pictures" / "Background Studio Output")
    background: str = "transparent"
    custom_color: str = "#f2efe9"
    model: str = models.DEFAULT_MODEL
    skip_existing: bool = True
    clean_edges: bool = False
    mode: str = "auto"  # what kind of images: auto | item | ink | photo (see engine.MODES)
    trim: bool = True   # crop away empty transparent space around cut-outs

    def bg_rgb(self) -> tuple[int, int, int] | None:
        if self.background == "white":
            return (255, 255, 255)
        if self.background == "black":
            return (0, 0, 0)
        if self.background == "custom":
            c = self.custom_color.lstrip("#")
            return (int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16))
        return None

    def variant_dir(self) -> str | None:
        if self.background in ("white", "black"):
            return f"on-{self.background}"
        if self.background == "custom":
            return f"on-{self.custom_color.lstrip('#').lower()}"
        return None


@dataclass
class Item:
    id: str
    source: str            # file that is read (the original, or our copy of a dropped file)
    rel: str               # relative display path, e.g. "Products/shoes/IMG_01.jpg"
    origin: str            # "disk" or "dropped"
    out_rel: str           # transparent PNG path inside the output folder
    status: str = "queued"  # queued | processing | done | skipped | failed
    error: str = ""
    note: str = ""
    seconds: float = 0.0
    variant_rel: str = ""
    mode_override: str = ""  # per-image choice from "Redo as…" (empty: use the batch setting)
    used_mode: str = ""      # what was actually applied (auto resolves to item / ink / keep)
    out_dir: str = ""      # output folder this result was saved in
    adjust: dict = field(default_factory=dict)  # manual adjustments (see engine.sanitize_adjust)
    edits_sha: str = ""    # id of saved touch-up brush edits ("" = none)
    crop_used: list | None = None  # corners actually used (manual or auto-detected)
    explicit: bool = False  # the user set this image's options in this session
    size: tuple[int, int] | None = None
    sha256: str = ""
    finished_at: float = 0.0

    def public(self) -> dict:
        d = asdict(self)
        d["name"] = Path(self.rel).name
        d["source"] = self.source if self.origin == "disk" else f"(dropped) {self.rel}"
        d.pop("sha256")
        d.pop("explicit")
        d["has_edits"] = bool(self.edits_sha)
        return d


@dataclass
class Run:
    total: int = 0
    done: int = 0
    skipped: int = 0
    failed: int = 0
    started_at: float = field(default_factory=time.time)
    finished_at: float = 0.0
    running: bool = True
    cancel_requested: bool = False
    cancelled: bool = False
    phase: str = "starting"   # starting | loading-model | processing | finished
    current: str = ""
    infer_seconds: float = 0.0
    infer_count: int = 0
    fatal: str = ""

    def public(self) -> dict:
        d = asdict(self)
        finished = self.done + self.skipped + self.failed
        remaining = max(self.total - finished, 0)
        avg = self.infer_seconds / self.infer_count if self.infer_count else None
        d["completed"] = finished
        d["eta_seconds"] = round(avg * remaining) if (avg and self.running) else None
        d["elapsed"] = round((self.finished_at or time.time()) - self.started_at, 1)
        return d


class Manifest:
    """Records which files in an output folder this app created, and from what."""

    def __init__(self, out_dir: Path):
        self.path = out_dir / MANIFEST_NAME
        self.entries: dict[str, dict] = {}
        if self.path.exists():
            try:
                self.entries = json.loads(self.path.read_text("utf-8")).get("files", {})
            except Exception:
                # Keep the damaged file for inspection and start a fresh record.
                self.path.replace(self.path.with_name(MANIFEST_NAME + f".damaged-{int(time.time())}"))
                self.entries = {}
        self._owned = set()
        for rel, e in self.entries.items():
            self._owned.add(rel.lower())
            self._owned.update(v.lower() for v in e.get("variants", []))

    def owns(self, rel: str) -> bool:
        return rel.lower() in self._owned

    def get(self, rel: str) -> dict | None:
        return self.entries.get(rel)

    def record(self, rel: str, entry: dict) -> None:
        self.entries[rel] = entry
        self._owned.add(rel.lower())
        self._owned.update(v.lower() for v in entry.get("variants", []))

    def save(self) -> None:
        tmp = self.path.with_name(self.path.name + ".partial")
        tmp.write_text(json.dumps({"app": "Background Studio", "version": 1, "files": self.entries},
                                  indent=1, ensure_ascii=False), "utf-8")
        os.replace(tmp, self.path)


def _clean_rel(rel: str) -> str:
    """Normalise a relative path from the browser or a folder scan; no '..', no absolute paths."""
    parts = [p for p in re.split(r"[\\/]+", rel) if p not in ("", ".", "..")]
    parts = [p.replace("\x00", "") for p in parts]
    if not parts:
        raise ValueError("empty path")
    return "/".join(parts)


def _is_hidden(p: Path) -> bool:
    return p.name.startswith(".")  # .DS_Store, ._AppleDouble files, hidden folders


def _is_within(child: Path, parent: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


class LRU(OrderedDict):
    def __init__(self, cap: int):
        super().__init__()
        self.cap = cap

    def put(self, k, v):
        self[k] = v
        self.move_to_end(k)
        while len(self) > self.cap:
            self.popitem(last=False)


class Studio:
    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self.inbox = data_dir / "inbox"
        self.exports = data_dir / "exports"
        self.settings_path = data_dir / "settings.json"
        for d in (self.inbox, self.exports):
            shutil.rmtree(d, ignore_errors=True)  # only our own temporary copies
            d.mkdir(parents=True, exist_ok=True)

        self.lock = threading.RLock()
        self.items: "OrderedDict[str, Item]" = OrderedDict()
        self.roots: list[Path] = []      # folders added from disk
        self.file_dirs: set[Path] = set()  # parent folders of individually added files
        self.run: Run | None = None
        self.version = 0
        self.thumbs = LRU(3000)
        self.previews = LRU(8)  # downscaled originals for live editing
        self.queue: deque = deque()  # images waiting in the running batch
        self.settings = self._load_settings()

    # ---------- settings ----------
    def _load_settings(self) -> Settings:
        s = Settings()
        try:
            saved = json.loads(self.settings_path.read_text("utf-8"))
            for k, v in saved.items():
                if hasattr(s, k):
                    setattr(s, k, v)
        except Exception:
            pass
        try:
            self._validate(s)
        except ValueError:
            s = Settings()
        if not models.installed().get(s.model):
            s.model = models.DEFAULT_MODEL
        return s

    @staticmethod
    def _validate(s: Settings) -> None:
        if s.mode not in ("auto", "item", "ink", "photo"):
            raise ValueError("Unknown image type")
        if s.background not in BACKGROUNDS:
            raise ValueError("Unknown background option")
        if not HEX_RE.match(s.custom_color):
            raise ValueError("Custom colour must look like #RRGGBB")
        if s.model not in models.MODELS:
            raise ValueError("Unknown model")
        if not os.path.isabs(os.path.expanduser(s.output_dir)):
            raise ValueError("The output folder must be a full path")

    def update_settings(self, changes: dict) -> Settings:
        with self.lock:
            if self.run and self.run.running:
                raise ValueError("Settings can't be changed while a batch is running.")
            s = Settings(**{**asdict(self.settings), **{k: v for k, v in changes.items() if hasattr(self.settings, k)}})
            s.output_dir = str(Path(os.path.expanduser(s.output_dir)).resolve()) if s.output_dir else s.output_dir
            s.skip_existing = bool(s.skip_existing)
            s.trim = bool(s.trim)
            s.clean_edges = bool(s.clean_edges)
            self._validate(s)
            if not models.installed().get(s.model):
                raise ValueError(f"The model '{s.model}' is not installed. Run ./setup.sh --model {s.model}")
            self.settings = s
            self.settings_path.write_text(json.dumps(asdict(s), indent=1), "utf-8")
            self.version += 1
            return s

    # ---------- adding images ----------
    def _taken_out_names(self) -> set[str]:
        return {it.out_rel.lower() for it in self.items.values()}

    def _assign_out_rel(self, rel: str, taken: set[str]) -> str:
        stem, ext = os.path.splitext(rel)
        candidates = [stem + ".png", f"{stem}_{ext.lstrip('.').lower()}.png"]
        candidates += [f"{stem} ({n}).png" for n in range(2, 10_000)]
        for c in candidates:
            if c.lower() not in taken:
                taken.add(c.lower())
                return c
        raise ValueError("Too many files with the same name")

    def _add(self, source: Path, rel: str, origin: str, taken: set[str], sha: str = "") -> Item:
        item = Item(id=uuid.uuid4().hex[:12], source=str(source), rel=rel, origin=origin,
                    out_rel=self._assign_out_rel(rel, taken), sha256=sha)
        self.items[item.id] = item
        return item

    def add_paths(self, paths: list[str]) -> dict:
        """Add files and/or folders (recursively) from disk, by path. Nothing is copied."""
        added, ignored, problems = 0, 0, []
        out_dir = Path(self.settings.output_dir)
        with self.lock:
            existing = {it.source for it in self.items.values() if it.origin == "disk"}
            taken = self._taken_out_names()
            for raw in paths:
                raw = (raw or "").strip()
                if not raw:
                    continue
                p = Path(os.path.expanduser(raw))
                try:
                    p = p.resolve()
                    if p.is_dir():
                        found = []
                        for dirpath, dirnames, filenames in os.walk(p):
                            d = Path(dirpath)
                            dirnames[:] = sorted(n for n in dirnames
                                                 if not n.startswith(".") and not _is_within(d / n, out_dir))
                            for fn in sorted(filenames):
                                f = d / fn
                                if _is_hidden(f) or f.suffix.lower() not in engine.IMAGE_EXTS:
                                    if not _is_hidden(f):
                                        ignored += 1
                                    continue
                                found.append(f)
                        if p not in self.roots:
                            self.roots.append(p)
                        for f in found:
                            if str(f) in existing:
                                continue
                            rel = _clean_rel(f"{p.name}/{f.relative_to(p).as_posix()}")
                            self._add(f, rel, "disk", taken)
                            existing.add(str(f))
                            added += 1
                    elif p.is_file():
                        if p.suffix.lower() not in engine.IMAGE_EXTS:
                            ignored += 1
                            continue
                        if str(p) in existing:
                            continue
                        self.file_dirs.add(p.parent)
                        self._add(p, _clean_rel(p.name), "disk", taken)
                        existing.add(str(p))
                        added += 1
                    else:
                        problems.append(f"Not found: {raw}")
                except PermissionError:
                    problems.append(f"macOS denied access to {raw} (see README → Files & Folders permission)")
                except OSError as e:
                    problems.append(f"{raw}: {e.strerror or e}")
            self.version += 1
        return {"added": added, "ignored": ignored, "problems": problems}

    def add_upload(self, drop_id: str, rel: str, stream) -> dict:
        """Store a dropped file in the private inbox (a copy) and queue it."""
        rel = _clean_rel(rel)
        if Path(rel).suffix.lower() not in engine.IMAGE_EXTS or _is_hidden(Path(rel)):
            return {"added": 0, "ignored": 1}
        drop_id = re.sub(r"[^a-zA-Z0-9_-]", "", drop_id)[:40] or "drop"
        dest = self.inbox / drop_id / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        with open(dest, "wb") as f:
            shutil.copyfileobj(stream, f, 1 << 20)
        sha = engine.file_sha256(dest)
        with self.lock:
            for it in self.items.values():
                if it.origin == "dropped" and it.sha256 == sha and it.rel == rel:
                    dest.unlink(missing_ok=True)  # same file dropped twice
                    return {"added": 0, "ignored": 0, "duplicate": 1}
            self._add(dest, rel, "dropped", self._taken_out_names(), sha)
            self.version += 1
        return {"added": 1, "ignored": 0}

    def remove(self, ids: list[str]) -> None:
        with self.lock:
            for i in ids:
                it = self.items.get(i)
                if it and it.status != "processing":
                    self.items.pop(i)
            self.version += 1

    def clear(self) -> None:
        with self.lock:
            if self.run and self.run.running:
                raise ValueError("Cancel the running batch before clearing.")
            self.items.clear()
            self.roots.clear()
            self.file_dirs.clear()
            self.thumbs.clear()
            self.previews.clear()
            self.run = None
            shutil.rmtree(self.inbox, ignore_errors=True)
            self.inbox.mkdir(parents=True, exist_ok=True)
            self.version += 1

    # ---------- running ----------
    def _check_output_dir(self) -> Path:
        out = Path(self.settings.output_dir).resolve()
        for root in self.roots:
            if _is_within(out, root):
                raise ValueError(f"The output folder is inside a folder you are processing ({root}). "
                                 "Choose a separate output folder so originals and results never mix.")
        for d in self.file_dirs:
            if out == d:
                raise ValueError(f"The output folder is the same folder as some originals ({d}). "
                                 "Choose a separate output folder.")
        if _is_within(out, self.inbox.parent):
            raise ValueError("Choose an output folder outside the app's private data folder.")
        out.mkdir(parents=True, exist_ok=True)
        if not os.access(out, os.W_OK):
            raise ValueError(f"Can't write to the output folder {out}.")
        return out

    def start(self, retry_failed: bool = False, ids: list[str] | None = None) -> None:
        with self.lock:
            if self.run and self.run.running:
                raise ValueError("A batch is already running.")
            if ids:  # retry specific images only
                for i in ids:
                    it = self.items.get(i)
                    if it and it.status == "failed":
                        it.status, it.error, it.note = "queued", "", ""
                queued = [i for i in ids if i in self.items and self.items[i].status == "queued"]
                if not queued:
                    raise ValueError("Nothing to retry.")
            elif retry_failed:
                for it in self.items.values():
                    if it.status == "failed":
                        it.status, it.error, it.note = "queued", "", ""
            if not ids:
                queued = [it.id for it in self.items.values() if it.status == "queued"]
            if not queued:
                # Nothing new: re-run everything (finished items will be skipped if unchanged).
                for it in self.items.values():
                    it.status, it.error, it.note = "queued", "", ""
                queued = list(self.items)
            if not queued:
                raise ValueError("Add some images first.")
            out_dir = self._check_output_dir()
            settings = Settings(**asdict(self.settings))
            self.run = Run(total=len(queued))
            self.queue = deque(queued)
            self.version += 1
            threading.Thread(target=self._worker, args=(settings, out_dir, self.run),
                             daemon=True, name="bg-worker").start()

    # ---------- per-image editing ----------
    def _item(self, item_id: str) -> Item:
        item = self.items.get(item_id)
        if item is None:
            raise ValueError("That image is no longer in the list.")
        return item

    def _item_out_dir(self, item: Item) -> Path:
        return Path(item.out_dir or self.settings.output_dir)

    @staticmethod
    def _mask_path(out_dir: Path, item: Item, model: str) -> Path:
        return out_dir / PRIVATE_DIR / "masks" / f"{item.sha256[:24]}-{model}.png"

    @staticmethod
    def _edits_path(out_dir: Path, item: Item) -> Path:
        key = hashlib.sha1(item.out_rel.encode("utf-8")).hexdigest()[:16]
        return out_dir / PRIVATE_DIR / "edits" / f"{key}.png"

    def _mask_getter(self, item: Item, img: Image.Image, out_dir: Path, model: str, session_fn):
        """Return a function giving the AI's raw outline for img, cached on disk per source + model."""
        def get() -> np.ndarray:
            path = self._mask_path(out_dir, item, model)
            if path.exists():
                try:
                    with Image.open(path) as m:
                        return np.asarray(m.convert("L").resize(img.size, Image.Resampling.BILINEAR))
                except Exception:
                    pass  # damaged cache: recompute
            from rembg import remove
            mask = remove(img.convert("RGB"), session=session_fn(), only_mask=True).convert("L")
            stored = mask.copy()
            stored.thumbnail((2048, 2048))
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                tmp = path.with_name(path.name + ".partial")
                stored.save(tmp, "PNG")
                os.replace(tmp, path)
            except OSError:
                pass  # caching is an optimisation only
            if mask.size != img.size:
                mask = mask.resize(img.size, Image.Resampling.BILINEAR)
            return np.asarray(mask)
        return get

    def _preview_base(self, item: Item) -> Image.Image:
        key = (item.id, "base")
        with self.lock:
            if key in self.previews:
                return self.previews[key]
        img, _ = engine.load_image(Path(item.source))
        img.thumbnail((1400, 1400), Image.Resampling.LANCZOS)
        with self.lock:
            self.previews.put(key, img)
        return img

    def preview(self, item_id: str, mode: str, adjust: dict, geometry_only: bool = False) -> dict:
        """Fast render at preview size for live adjustments (nothing is written except the AI-outline cache)."""
        if mode not in engine.MODES:
            raise ValueError("Unknown mode")
        adjust = engine.sanitize_adjust(adjust)
        with self.lock:
            item = self._item(item_id)
            s = Settings(**asdict(self.settings))
            out_dir = self._item_out_dir(item)
        if not item.sha256:
            item.sha256 = engine.file_sha256(Path(item.source))
        base = self._preview_base(item)
        get_mask = self._mask_getter(item, base, out_dir, s.model, lambda: models.get_session(s.model))
        r = engine.render(base, mode, adjust, get_mask, s.clean_edges, geometry_only=geometry_only)

        def data_url(img: Image.Image, fmt: str) -> str:
            buf = io.BytesIO()
            if fmt == "PNG":
                img.save(buf, "PNG", compress_level=1)
            else:  # JPEG can't hold transparency (rotated corners): flatten onto grey
                flat = Image.new("RGB", img.size, (128, 128, 128))
                flat.paste(img, mask=img.getchannel("A") if img.mode == "RGBA" else None)
                flat.save(buf, "JPEG", quality=90)
            return f"data:image/{fmt.lower()};base64," + base64.b64encode(buf.getvalue()).decode("ascii")

        # Frames with transparent (rotated) corners go as PNG so the keep brush can't paint them.
        frame_fmt = "PNG" if r["frame"].mode == "RGBA" else "JPEG"
        toned = r["frame"] is not r["orig"]
        return {
            "cut": data_url(r["cut"], "PNG"),
            "frame": data_url(r["frame"], frame_fmt),
            "orig": data_url(r["orig"], frame_fmt) if toned else None,
            "used": r["used"], "why": r["why"], "quad": r["quad"],
            "width": r["cut"].width, "height": r["cut"].height,
        }

    def _geometry(self, item: Item, adjust: dict) -> tuple[Image.Image, Image.Image]:
        base = self._preview_base(item)
        turned = engine.rotate_image(base, adjust.get("rot90", 0))
        return turned, engine.rotate_image(turned, 0, adjust.get("angle", 0.0))

    def detect_crop(self, item_id: str, adjust: dict | None = None) -> list[list[float]]:
        """Suggested crop corners in the rotated frame (scanner edges, or the straightened area)."""
        adjust = engine.sanitize_adjust(adjust)
        with self.lock:
            item = self._item(item_id)
        turned, geo = self._geometry(item, adjust)
        if abs(adjust.get("angle", 0.0)) > 0.01:
            return engine.inscribed_quad(turned.width, turned.height, adjust["angle"], geo.width, geo.height)
        quad = engine.detect_card(geo)
        return quad or [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]

    def straighten(self, item_id: str, adjust: dict | None = None) -> float:
        """Suggested fine rotation (degrees clockwise) that levels the image's lines and edges."""
        adjust = engine.sanitize_adjust(adjust)
        with self.lock:
            item = self._item(item_id)
        turned, _ = self._geometry(item, adjust)
        return engine.estimate_skew(turned)

    def edits_file(self, item_id: str) -> Path | None:
        with self.lock:
            item = self._item(item_id)
            if not item.edits_sha:
                return None
            p = self._edits_path(self._item_out_dir(item), item)
        return p if p.exists() else None

    def save_adjustments(self, item_id: str, mode: str, adjust: dict, edits: str | None,
                         edits_action: str = "keep") -> None:
        """Store an image's manual choices and reprocess it at full size.

        edits_action: "keep" existing brush edits, "replace" them with `edits`
        (a PNG data URL: red = keep, green = erase) or "clear" them.
        """
        if mode not in engine.MODES:
            raise ValueError("Unknown mode")
        if edits_action not in ("keep", "replace", "clear"):
            raise ValueError("Bad edits action")
        adjust = engine.sanitize_adjust(adjust)
        with self.lock:
            item = self._item(item_id)
            if item.status == "processing":
                raise ValueError("This image is being processed right now. Try again in a moment.")
            out_dir = self._item_out_dir(item)
        path = self._edits_path(out_dir, item)
        if edits_action == "replace":
            if not edits or not edits.startswith("data:image/png;base64,"):
                raise ValueError("Touch-up edits must be a PNG image")
            data = base64.b64decode(edits.split(",", 1)[1])
            with Image.open(io.BytesIO(data)) as im:  # validate before writing
                im.verify()
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_name(path.name + ".partial")
            tmp.write_bytes(data)
            os.replace(tmp, path)
            new_sha = hashlib.sha256(data).hexdigest()[:16]
        elif edits_action == "clear":
            path.unlink(missing_ok=True)
            new_sha = ""
        else:
            new_sha = item.edits_sha
        with self.lock:
            item.mode_override = "" if mode == self.settings.mode else mode
            item.adjust = adjust
            item.edits_sha = new_sha
            item.explicit = True
            item.status, item.error, item.note = "queued", "", ""
            self.version += 1
            if self.run and self.run.running:  # join the running batch instead of waiting for it
                if item_id not in self.queue:
                    self.queue.append(item_id)
                    self.run.total += 1
                return
        self.start(ids=[item_id])

    def redo(self, item_id: str, mode: str) -> None:
        """Reprocess one image with a different method, keeping its other adjustments."""
        with self.lock:
            adjust = dict(self._item(item_id).adjust)
        self.save_adjustments(item_id, mode, adjust, None, "keep")

    def cancel(self) -> None:
        with self.lock:
            if self.run and self.run.running:
                self.run.cancel_requested = True
                self.version += 1

    def _worker(self, s: Settings, out_dir: Path, run: Run) -> None:
        manifest = Manifest(out_dir)
        sessions: dict = {}

        def get_session():  # load the AI model only when an image actually needs it
            if "s" not in sessions:
                with self.lock:
                    run.phase = "loading-model"
                    self.version += 1
                sessions["s"] = models.get_session(s.model)
                with self.lock:
                    run.phase = "processing"
            return sessions["s"]

        input_paths = {str(Path(it.source).resolve()).lower() for it in self.items.values()}
        n = 0
        try:
            while True:
                with self.lock:
                    if run.cancel_requested:
                        run.cancelled = True
                        break
                    item_id = self.queue.popleft() if self.queue else None
                if item_id is None:
                    # Save the record first, then stop only if nothing was queued meanwhile
                    # (edits saved in the editor join the running batch).
                    manifest.save()
                    with self.lock:
                        if self.queue:
                            continue
                        self._finish(run)
                        return
                with self.lock:
                    item = self.items.get(item_id)
                    if item is None or item.status != "queued":
                        run.total -= 1
                        continue
                    item.status = "processing"
                    for size in (320, 1600):
                        self.thumbs.pop((item.id, "result", size), None)
                    run.current = item.rel
                    run.phase = "processing"
                    self.version += 1

                t0 = time.time()
                try:
                    status, note = self._process(item, s, out_dir, manifest, get_session, input_paths)
                    err = ""
                except Exception as exc:  # one bad image never stops the batch
                    status, note, err = "failed", "", engine.friendly_error(exc)
                    if isinstance(exc, RuntimeError) and "not installed" in str(exc):
                        run.fatal = err
                elapsed = time.time() - t0

                with self.lock:
                    item.status, item.note, item.error = status, note, err
                    item.seconds = round(elapsed, 2)
                    item.finished_at = time.time()
                    if status == "done":
                        run.done += 1
                        run.infer_seconds += elapsed
                        run.infer_count += 1
                    elif status == "skipped":
                        run.skipped += 1
                    else:
                        run.failed += 1
                    self.version += 1
                n += 1
                if status != "failed" and n % 10 == 0:
                    manifest.save()
                if run.fatal:
                    break
        except Exception:
            pass
        try:
            manifest.save()
        except Exception:
            pass
        with self.lock:
            self._finish(run)

    def _finish(self, run: Run) -> None:
        """Mark the run finished (caller holds the lock)."""
        if not run.running:
            return
        self.queue.clear()
        for it in self.items.values():
            if it.status == "processing":
                it.status = "queued"
        run.running = False
        run.phase = "finished"
        run.current = ""
        run.finished_at = time.time()
        self.version += 1

    @staticmethod
    def _mode(item: Item, s: Settings) -> str:
        return item.mode_override or s.mode

    @staticmethod
    def _adopt_manual(item: Item, entry: dict | None) -> None:
        """Re-apply manual choices saved with an earlier result (so they survive restarts)."""
        if item.explicit or not entry or not entry.get("manual"):
            return
        if entry.get("sha256") != item.sha256:
            return  # the original has changed since: start fresh
        item.mode_override = entry.get("override", "")
        item.adjust = dict(entry.get("adjust") or {})
        item.edits_sha = entry.get("edits_sha", "")
        item.explicit = True

    def _can_reuse(self, item: Item, s: Settings, out_dir: Path, manifest: Manifest) -> bool:
        if not s.skip_existing:
            return False
        target = out_dir / item.out_rel
        entry = manifest.get(item.out_rel)
        if not (entry and target.exists()):
            return False
        mode = self._mode(item, s)
        if (entry.get("sha256") != item.sha256 or entry.get("mode", "photo") != mode
                or (entry.get("adjust") or {}) != item.adjust
                or entry.get("edits_sha", "") != item.edits_sha):
            return False
        if bool(entry.get("trim", False)) != s.trim:
            return False
        used = entry.get("used_mode") or mode
        if used in ("ink", "keep", "card"):  # no AI model involved
            return True
        if entry.get("engine", 1) != engine.ENGINE_VERSION:
            return False  # made by an older cut-out algorithm: redo it
        if entry.get("model") != s.model:
            return False
        return "fringe" in item.adjust or bool(entry.get("clean_edges")) == s.clean_edges

    def _safe_target(self, out_dir: Path, rel: str, manifest: Manifest, input_paths: set[str]) -> Path:
        target = (out_dir / rel).resolve()
        if not _is_within(target, out_dir):
            raise engine.ImageError("Unsafe output path.")
        if str(target).lower() in input_paths:
            raise engine.ImageError("Refusing to write over an original image.")
        if target.exists() and not manifest.owns(rel):
            raise engine.ImageError(
                f"'{rel}' already exists in the output folder and was not made by Background Studio, "
                "so it was left untouched. Rename it or choose another output folder.")
        return target

    def _process(self, item: Item, s: Settings, out_dir: Path, manifest: Manifest, get_session,
                 input_paths: set[str]) -> tuple[str, str]:
        src = Path(item.source)
        if not src.exists():
            raise FileNotFoundError(src)
        variant_dir = s.variant_dir()
        variant_rel = f"{variant_dir}/{item.out_rel}" if variant_dir else ""
        bg = s.bg_rgb()

        if not item.sha256:
            item.sha256 = engine.file_sha256(src)
        self._adopt_manual(item, manifest.get(item.out_rel))
        if self._can_reuse(item, s, out_dir, manifest):
            entry = manifest.get(item.out_rel)
            target = out_dir / item.out_rel
            note = "Already processed — skipped"
            item.size = tuple(entry.get("size") or ()) or None
            item.used_mode = entry.get("used_mode") or entry.get("mode", "photo")
            item.crop_used = entry.get("crop_used")
            if variant_rel and not (out_dir / variant_rel).exists() or (
                    variant_rel and variant_rel not in entry.get("variants", [])):
                vt = self._safe_target(out_dir, variant_rel, manifest, input_paths)
                with Image.open(target) as cut:
                    cut.load()
                    engine.save_png_atomic(engine.composite(cut.convert("RGBA"), bg), vt,
                                           cut.info.get("icc_profile"))
                entry["variants"] = sorted(set(entry.get("variants", [])) | {variant_rel})
                manifest.record(item.out_rel, entry)
                note = "Reused existing cutout, added background"
            item.variant_rel = variant_rel
            item.out_dir = str(out_dir)
            return "skipped", note

        target = self._safe_target(out_dir, item.out_rel, manifest, input_paths)
        vt = self._safe_target(out_dir, variant_rel, manifest, input_paths) if variant_rel else None

        img, icc = engine.load_image(src)
        mode = self._mode(item, s)
        get_mask = self._mask_getter(item, img, out_dir, s.model, get_session)
        r = engine.render(img, mode, item.adjust, get_mask, s.clean_edges)
        cutout, used, why = r["cut"], r["used"], r["why"]
        notes = []
        if mode == "auto" and why:
            notes.append(f"Auto chose {engine.MODE_LABELS[used].lower()}: {why}")
        if item.edits_sha:
            ep = self._edits_path(out_dir, item)
            if ep.exists():
                with Image.open(ep) as edits:
                    cutout = engine.apply_edits(cutout, r["frame"], edits)
            else:
                notes.append("Touch-up edits were not found and were skipped")
        if item.adjust or item.edits_sha or item.mode_override:
            notes.append("Manually adjusted")
        if s.trim:
            cutout = engine.trim_transparent(cutout)
        note = " · ".join(notes)
        engine.save_png_atomic(cutout, target, icc)
        variants = []
        if vt is not None:
            engine.save_png_atomic(engine.composite(cutout, bg), vt, icc)
            variants.append(variant_rel)
        old = manifest.get(item.out_rel) or {}
        if old.get("sha256") == item.sha256:  # same source: keep other colour variants we made
            variants = sorted(set(variants) | set(old.get("variants", [])))
        manifest.record(item.out_rel, {
            "source": item.source if item.origin == "disk" else f"(dropped) {item.rel}",
            "sha256": item.sha256, "model": s.model, "clean_edges": s.clean_edges,
            "mode": mode, "used_mode": used, "override": item.mode_override, "engine": engine.ENGINE_VERSION,
            "trim": s.trim,
            "adjust": item.adjust, "edits_sha": item.edits_sha, "crop_used": r["quad"],
            "manual": bool(item.mode_override or item.adjust or item.edits_sha),
            "size": list(cutout.size), "variants": variants,
            "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
        })
        item.size = cutout.size
        item.used_mode = used
        item.crop_used = r["quad"]
        item.variant_rel = variant_rel
        item.out_dir = str(out_dir)
        self.thumbs.put((item.id, "result", 320), engine.thumbnail_bytes(cutout, 320, "WEBP"))
        return "done", note

    # ---------- reading results ----------
    def snapshot(self) -> dict:
        with self.lock:
            items = [it.public() for it in self.items.values()]
            counts = {k: 0 for k in ("queued", "processing", "done", "skipped", "failed")}
            for it in self.items.values():
                counts[it.status] += 1
            return {
                "version": self.version,
                "settings": asdict(self.settings),
                "items": items,
                "counts": counts,
                "run": self.run.public() if self.run else None,
            }

    def image_bytes(self, item_id: str, kind: str, size: int) -> tuple[bytes, str]:
        with self.lock:
            item = self.items.get(item_id)
            if item is None:
                raise KeyError(item_id)
            key = (item_id, kind, size)
            if key in self.thumbs:
                data = self.thumbs[key]
                return data, _mime(data)
            out_dir = Path(item.out_dir or self.settings.output_dir)
        if kind == "original":
            data = engine.preview_of_file(Path(item.source), size)
        else:
            path = out_dir / item.out_rel
            if item.status not in ("done", "skipped") or not path.exists():
                raise KeyError(item_id)
            with Image.open(path) as im:
                im.load()
                data = engine.thumbnail_bytes(im.convert("RGBA"), size, "WEBP")
        with self.lock:
            self.thumbs.put(key, data)
        return data, _mime(data)

    def result_path(self, item_id: str) -> Path:
        with self.lock:
            item = self.items[item_id]
            p = Path(item.out_dir or self.settings.output_dir) / item.out_rel
        if item.status not in ("done", "skipped") or not p.exists():
            raise KeyError(item_id)
        return p

    def build_zip(self) -> Path:
        with self.lock:
            files = []
            for it in self.items.values():
                if it.status in ("done", "skipped"):
                    base = Path(it.out_dir or self.settings.output_dir)
                    files.append((base, it.out_rel))
                    if it.variant_rel:
                        files.append((base, it.variant_rel))
        if not files:
            raise ValueError("There are no finished results to download yet.")
        for old in self.exports.glob("*.zip"):
            old.unlink(missing_ok=True)
        zpath = self.exports / f"background-studio-{time.strftime('%Y%m%d-%H%M%S')}.zip"
        # PNGs are already compressed; storing them is much faster and barely larger.
        with zipfile.ZipFile(zpath, "w", zipfile.ZIP_STORED, allowZip64=True) as z:
            seen = set()
            for base, rel in files:
                p = base / rel
                if p.exists() and rel not in seen:
                    seen.add(rel)
                    z.write(p, rel)
        return zpath

    def path_for_reveal(self, item_id: str, which: str) -> Path:
        with self.lock:
            item = self.items[item_id]
            if which == "original":
                return Path(item.source)
            return Path(item.out_dir or self.settings.output_dir) / item.out_rel


def _mime(data: bytes) -> str:
    if data[:4] == b"RIFF":
        return "image/webp"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    return "image/png"
