"""Sort & tag: show images one at a time and file each under one of your categories.

Tags are kept in data/tagger.json, keyed by each image's full path, so adding the
same folder again later brings its tags back. Originals are only read. The two
optional exports that touch the outside world are explicit buttons:
  * "Copy into folders" copies (never moves) images into <destination>/<category>/
    and never overwrites anything already there.
  * "Add Finder tags" adds the category names as macOS Finder tags. That changes the
    files' tag labels (an extended attribute), never the image data.
"""

from __future__ import annotations

import csv
import ctypes
import errno
import filecmp
import hashlib
import io
import json
import os
import plistlib
import re
import shutil
import sys
import threading
import uuid
from pathlib import Path

import numpy as np

from . import autotag, engine
from .studio import LRU, _is_hidden

SORTED_MARKER = ".background-studio-sorted"  # written into "copy into folders" destinations
MAX_CATEGORIES = 36  # one per key: 1–0 and the 26 letters
MAX_ROUNDS = 3
RATING = [{"id": f"star{n}", "name": "★" * n, "color": "#eab308"} for n in range(1, 6)]
# Colours roughly matching Finder's tag colours, so Finder tags look like the app.
# (hex, Finder colour index: 1 grey, 2 green, 3 purple, 4 blue, 5 yellow, 6 red, 7 orange)
PALETTE = [("#3b82f6", 4), ("#ef4444", 6), ("#22c55e", 2), ("#f59e0b", 7), ("#a855f7", 3),
           ("#eab308", 5), ("#14b8a6", 2), ("#ec4899", 6), ("#64748b", 1), ("#8b5cf6", 3)]
FINDER_TAGS = "com.apple.metadata:_kMDItemUserTags"


def _item_id(path: str) -> str:
    return hashlib.sha1(path.encode("utf-8", "surrogateescape")).hexdigest()[:16]


def _natural(p: Path):
    """Sort IMG_2 before IMG_10."""
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", p.as_posix())]


def _safe_folder_name(name: str) -> str:
    name = re.sub(r"[/:\\\x00]", "-", name).strip().lstrip(".")
    return name[:80] or "Untitled"


def _finder_colour(hex_colour: str) -> int:
    for h, idx in PALETTE:
        if h == hex_colour:
            return idx
    return 0


class Tagger:
    def __init__(self, data_dir: Path):
        self.path = data_dir / "tagger.json"
        self.lock = threading.RLock()
        self.images = LRU(2500)
        self.big = LRU(6)
        # Rounds of sorting, each with its own categories, e.g. 1) place, 2) content, 3) a star rating.
        # Category ids are unique across rounds, so a picture's tags are one flat list.
        self.rounds: list[dict] = []        # {id, name, kind: "tags" | "rating", categories: [{id, name, color}]}
        self.items: list[str] = []          # paths in the current list, in order
        self.tags: dict[str, list[str]] = {}  # path -> category ids (remembered across lists)
        self.skipped: dict[str, set[str]] = {}  # round id -> paths skipped in that round
        self.roots: list[str] = []          # folders added, rescanned for new images on launch
        self.recent: list[str] = []         # folders used before (offered again in step 1)
        self.sets: list[dict] = []          # saved category sets: {name, categories: [{name, color}]}
        self.dest = ""                      # where "copy into category folders" goes
        self.auto = False                   # auto-suggest on/off
        # Auto-suggest: one CLIP fingerprint per picture, kept on disk between launches.
        self.emb_path = data_dir / "tag-fingerprints.npz"
        self.emb: dict[str, tuple[str, np.ndarray | None]] = {}  # path -> (file signature, vector or None)
        self.emb_dirty = 0
        self.clip = autotag.Clip()
        self.worker: threading.Thread | None = None
        self.auto_error = ""
        self.hashes: dict[str, tuple[str, np.ndarray]] = {}  # path -> (file signature, 256-bit dhash)
        self.auto_tagged: set[str] = set()  # tagged by "auto-tag confident ones", not checked yet
        self._load()
        if not self.rounds:
            self.rounds = [{"id": "r1", "name": "Categories", "kind": "tags", "categories": []}]
        self._load_fingerprints()

    @property
    def categories(self) -> list[dict]:
        """Every category in every round."""
        return [dict(c, round=r["id"]) for r in self.rounds for c in r["categories"]]

    def _round(self, round_id: str | None) -> dict:
        for r in self.rounds:
            if r["id"] == round_id:
                return r
        return self.rounds[0]

    # ---------- persistence ----------
    def _load(self) -> None:
        try:
            d = json.loads(self.path.read_text("utf-8"))
        except (OSError, ValueError):
            return
        self.rounds = [r for r in d.get("rounds", []) if isinstance(r, dict) and r.get("id")]
        if not self.rounds:  # older data: one list of categories becomes round 1
            cats = [c for c in d.get("categories", []) if isinstance(c, dict) and c.get("id")]
            self.rounds = [{"id": "r1", "name": "Categories", "kind": "tags", "categories": cats}]
        self.items = [p for p in d.get("items", []) if isinstance(p, str)]
        self.tags = {p: list(t) for p, t in (d.get("tags") or {}).items() if isinstance(t, list)}
        sk = d.get("skipped") or {}
        if isinstance(sk, list):  # older data
            sk = {self.rounds[0]["id"]: sk}
        self.skipped = {rid: set(v) for rid, v in sk.items() if isinstance(v, list)}
        self.roots = [r for r in d.get("roots", []) if isinstance(r, str)]
        self.recent = [r for r in d.get("recent", []) if isinstance(r, str)][:12]
        self.sets = [x for x in d.get("sets", []) if isinstance(x, dict) and x.get("name")]
        self.dest = str(d.get("dest") or "")
        self.auto = bool(d.get("auto"))
        self.auto_tagged = {p for p in d.get("auto_tagged", []) if p in self.tags}

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(self.path.name + ".partial")
        tmp.write_text(json.dumps({"version": 2, "rounds": self.rounds, "items": self.items,
                                   "tags": self.tags, "skipped": {k: sorted(v) for k, v in self.skipped.items()},
                                   "roots": self.roots,
                                   "recent": self.recent, "sets": self.sets,
                                   "dest": self.dest, "auto": self.auto,
                                   "auto_tagged": sorted(self.auto_tagged & set(self.tags))},
                                  indent=1, ensure_ascii=False), "utf-8")
        os.replace(tmp, self.path)

    # ---------- state ----------
    def _public(self, path: str) -> dict:
        p = Path(path)
        return {"id": _item_id(path), "name": p.name, "folder": p.parent.name, "path": path,
                "tags": self.tags.get(path, []), "skipped": [r for r, v in self.skipped.items() if path in v],
                "auto": path in self.auto_tagged}

    def state(self) -> dict:
        with self.lock:
            return {"rounds": self.rounds, "items": [self._public(p) for p in self.items],
                    "roots": self.roots, "dest": self.dest, "auto": self.auto_status(),
                    "sets": [{"name": x["name"], "categories": x["categories"]} for x in self.sets]}

    def _path(self, item_id: str) -> str:
        for p in self.items:
            if _item_id(p) == item_id:
                return p
        raise KeyError(item_id)

    # ---------- adding images ----------
    def add_paths(self, paths: list[str]) -> dict:
        added, ignored, problems = 0, 0, []
        found: list[Path] = []
        for raw in paths:
            raw = (raw or "").strip()
            if not raw:
                continue
            p = Path(os.path.expanduser(raw))
            try:
                p = p.resolve()
                if p.is_dir():
                    with self.lock:
                        if str(p) not in self.roots:
                            self.roots.append(str(p))
                        self.recent = [str(p)] + [r for r in self.recent if r != str(p)][:11]
                    batch = []
                    for dirpath, dirnames, filenames in os.walk(p):
                        d = Path(dirpath)
                        dirnames[:] = [n for n in dirnames if not n.startswith(".")
                                       and not (d / n / SORTED_MARKER).exists()]
                        for fn in filenames:
                            f = d / fn
                            if _is_hidden(f):
                                continue
                            if f.suffix.lower() in engine.IMAGE_EXTS:
                                batch.append(f)
                            else:
                                ignored += 1
                    found += sorted(batch, key=_natural)
                elif p.is_file():
                    if p.suffix.lower() in engine.IMAGE_EXTS:
                        found.append(p)
                    else:
                        ignored += 1
                else:
                    problems.append(f"{raw}: not found")
            except OSError as e:
                problems.append(f"{raw}: {e.strerror or e}")
        with self.lock:
            existing = set(self.items)
            for f in found:
                s = str(f)
                if s not in existing:
                    self.items.append(s)
                    existing.add(s)
                    added += 1
            self._save()
            remembered = sum(1 for f in found if self.tags.get(str(f)))
        self.kick()
        return {"added": added, "ignored": ignored, "problems": problems, "remembered": remembered}

    def clear(self) -> None:
        with self.lock:
            self.items = []
            self.roots = []
            self.skipped = {}
            self.images.clear()
            self._save()

    def forget_tags(self, round_id: str | None = None) -> None:
        """Untag every picture in the current list, in one round ("*" = every round)."""
        if round_id == "*":
            for r in list(self.rounds):
                self.forget_tags(r["id"])
            return
        with self.lock:
            rnd = self._round(round_id)
            ids = {c["id"] for c in rnd["categories"]}
            for p in self.items:
                left = [t for t in self.tags.get(p, []) if t not in ids]
                if left:
                    self.tags[p] = left
                else:
                    self.tags.pop(p, None)
            self.skipped.get(rnd["id"], set()).difference_update(self.items)
            self._save()

    def rescan(self) -> dict:
        """Pick up new images in the folders added before; drop ones that were moved or deleted."""
        with self.lock:
            roots = [r for r in self.roots if Path(r).is_dir()]
            gone = [p for p in self.items if not os.path.exists(p)]
            if gone:
                self.items = [p for p in self.items if p not in set(gone)]
        r = self.add_paths(roots) if roots else {"added": 0, "ignored": 0, "problems": [], "remembered": 0}
        r["removed"] = len(gone)
        if gone and not r["added"]:
            with self.lock:
                self._save()
        self.kick()
        return r

    def remove_folder(self, folder: str) -> None:
        """Take a folder's pictures off the list ("" = pictures added one by one). Files and tags stay."""
        with self.lock:
            if folder:
                prefix = folder.rstrip("/") + "/"
                self.items = [p for p in self.items if not p.startswith(prefix)]
                self.roots = [r for r in self.roots if r != folder]
            else:
                self.items = [p for p in self.items if any(p.startswith(r.rstrip("/") + "/") for r in self.roots)]
            keep = set(self.items)
            for v in self.skipped.values():
                v &= keep
            self._save()

    def recent_folders(self, extra: list[tuple[str, str]]) -> list[dict]:
        """Folders worth offering in step 1: background-removal folders first, then ones used before."""
        with self.lock:
            current = set(self.roots)
            cands = list(extra) + [(r, "Used before") for r in self.recent]
        out, seen = [], set()
        for path, label in cands:
            if not path or path in seen or path in current:
                continue
            seen.add(path)
            if Path(path).is_dir():
                out.append({"path": path, "name": Path(path).name or path, "label": label})
        return out[:8]

    # ---------- saved category sets ----------
    def save_set(self, name: str, round_id: str | None = None) -> list[dict]:
        name = name.strip()[:60]
        rnd = self._round(round_id)
        if not name:
            raise ValueError("Give the set a name.")
        if not rnd["categories"]:
            raise ValueError("Add some categories first.")
        with self.lock:
            entry = {"name": name, "categories": [{"name": c["name"], "color": c["color"]} for c in rnd["categories"]]}
            self.sets = [x for x in self.sets if x["name"].lower() != name.lower()] + [entry]
            self.sets.sort(key=lambda x: x["name"].lower())
            self._save()
            return self.sets

    def delete_set(self, name: str) -> list[dict]:
        with self.lock:
            self.sets = [x for x in self.sets if x["name"] != name]
            self._save()
            return self.sets

    def use_set(self, name: str, round_id: str | None = None) -> list[dict]:
        """Switch a round to a saved set. Categories with the same name keep their tags."""
        with self.lock:
            entry = next((x for x in self.sets if x["name"] == name), None)
            if entry is None:
                raise ValueError("That set no longer exists.")
            rnd = self._round(round_id)
            by_name = {c["name"].lower(): c for c in rnd["categories"]}
            cats = [{"id": by_name[c["name"].lower()]["id"] if c["name"].lower() in by_name else None,
                     "name": c["name"], "color": c["color"]} for c in entry["categories"]]
        return self.set_categories(cats, rnd["id"])

    # ---------- rounds ----------
    def add_round(self, name: str, kind: str = "tags") -> dict:
        with self.lock:
            if len(self.rounds) >= MAX_ROUNDS:
                raise ValueError(f"Up to {MAX_ROUNDS} rounds.")
            if kind == "rating" and any(r["kind"] == "rating" for r in self.rounds):
                raise ValueError("There's already a rating round.")
            rid = "r" + uuid.uuid4().hex[:6]
            rnd = {"id": rid, "name": (name.strip() or ("Rating" if kind == "rating" else "Round"))[:40],
                   "kind": "rating" if kind == "rating" else "tags",
                   "categories": [dict(c) for c in RATING] if kind == "rating" else []}
            self.rounds.append(rnd)
            self._save()
            return rnd

    def rename_round(self, round_id: str, name: str) -> None:
        with self.lock:
            name = name.strip()[:40]
            if name:
                self._round(round_id)["name"] = name
                self._save()

    def move_round(self, round_id: str, delta: int) -> None:
        with self.lock:
            i = next((k for k, r in enumerate(self.rounds) if r["id"] == round_id), None)
            j = None if i is None else i + (1 if delta > 0 else -1)
            if i is not None and 0 <= j < len(self.rounds):
                self.rounds[i], self.rounds[j] = self.rounds[j], self.rounds[i]
                self._save()

    def delete_round(self, round_id: str) -> None:
        with self.lock:
            if len(self.rounds) <= 1:
                raise ValueError("There has to be at least one round.")
            rnd = self._round(round_id)
            if rnd["id"] != round_id:
                return
            ids = {c["id"] for c in rnd["categories"]}
            for p in list(self.tags):
                left = [t for t in self.tags[p] if t not in ids]
                if left:
                    self.tags[p] = left
                else:
                    del self.tags[p]
            self.skipped.pop(round_id, None)
            self.rounds = [r for r in self.rounds if r["id"] != round_id]
            self._save()

    def set_dest(self, dest: str) -> str:
        d = Path(dest).expanduser().resolve()
        if not d.is_dir():
            raise ValueError("That folder doesn't exist.")
        with self.lock:
            self.dest = str(d)
            self._save()
        return self.dest

    # ---------- categories ----------
    def set_categories(self, cats: list[dict], round_id: str | None = None) -> list[dict]:
        if not isinstance(cats, list):
            raise ValueError("categories must be a list")
        rnd = self._round(round_id)
        if rnd["kind"] == "rating":
            return rnd["categories"]  # the stars are fixed
        old = {c["id"]: c for c in rnd["categories"]}
        taken = {c["id"] for r in self.rounds if r is not rnd for c in r["categories"]}
        out, names = [], set()
        for c in cats[:MAX_CATEGORIES]:
            name = str((c or {}).get("name", "")).strip()[:60]
            if not name or name.lower() in names:
                continue
            names.add(name.lower())
            cid = c.get("id") if c.get("id") in old and c.get("id") not in taken else uuid.uuid4().hex[:8]
            colour = c.get("color") or (old.get(cid) or {}).get("color")
            if not (isinstance(colour, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", colour)):
                used = {x["color"] for x in out}
                colour = next((h for h, _ in PALETTE if h not in used), PALETTE[len(out) % len(PALETTE)][0])
            out.append({"id": cid, "name": name, "color": colour.lower()})
        with self.lock:
            dropped = set(old) - {c["id"] for c in out}
            for p in list(self.tags):
                t = [x for x in self.tags[p] if x not in dropped]
                if t:
                    self.tags[p] = t
                else:
                    del self.tags[p]
            rnd["categories"] = out
            self._save()
            return out

    # ---------- tagging ----------
    def _set(self, path: str, tags: list[str] | None, skipped: bool | None, round_id: str | None) -> None:
        """Set a picture's tags *in one round*; its tags from other rounds are kept."""
        rnd = self._round(round_id)
        ids = {c["id"] for c in rnd["categories"]}
        sk = self.skipped.setdefault(rnd["id"], set())
        if tags is not None:
            clean = list(dict.fromkeys(t for t in tags if t in ids))
            new = [t for t in self.tags.get(path, []) if t not in ids] + clean
            if new:
                self.tags[path] = new
            else:
                self.tags.pop(path, None)
            if clean:
                sk.discard(path)
            self.auto_tagged.discard(path)  # you've looked at it: it's yours now
        if skipped is not None:
            (sk.add if skipped else sk.discard)(path)

    def set_item(self, item_id: str, tags: list[str] | None = None, skipped: bool | None = None,
                 round_id: str | None = None) -> dict:
        with self.lock:
            path = self._path(item_id)
            self._set(path, tags, skipped, round_id)
            self._save()
            return self._public(path)

    def set_many(self, entries: list[dict], auto: bool = False) -> list[dict]:
        """Several changes at once (duplicates tagged together, undoing a bulk auto-tag)."""
        out = []
        with self.lock:
            for e in entries[:20000]:
                try:
                    path = self._path(str(e.get("id", "")))
                except KeyError:
                    continue
                tags = e.get("tags")
                skipped = e.get("skipped")
                self._set(path, list(tags) if isinstance(tags, list) else None,
                          bool(skipped) if skipped is not None else None, e.get("round"))
                if e.get("auto") and self.tags.get(path):
                    self.auto_tagged.add(path)
                out.append(self._public(path))
            self._save()
        return out

    # ---------- fingerprints (auto-suggest, duplicates, search) ----------
    @staticmethod
    def _sig(path: str) -> str:
        st = os.stat(path)
        return f"{st.st_size}:{st.st_mtime_ns}"

    def _load_fingerprints(self) -> None:
        try:
            with np.load(self.emb_path, allow_pickle=False) as z:
                hashes = z["hashes"] if "hashes" in z.files else None
                for k, (path, sig, v) in enumerate(zip(z["paths"], z["sigs"], z["vecs"])):
                    self.emb[str(path)] = (str(sig), v.astype(np.float32))
                    if hashes is not None and hashes[k].any():
                        self.hashes[str(path)] = (str(sig), np.unpackbits(hashes[k]).astype(bool))
        except (OSError, ValueError, KeyError):
            pass

    def _save_fingerprints(self) -> None:
        with self.lock:
            rows = [(p, s, v, self.hashes.get(p)) for p, (s, v) in self.emb.items() if v is not None]
            self.emb_dirty = 0
        if not rows:
            return
        tmp = self.emb_path.with_name(self.emb_path.name + ".partial.npz")
        blank = np.zeros(32, np.uint8)
        np.savez(tmp, paths=np.array([r[0] for r in rows]), sigs=np.array([r[1] for r in rows]),
                 vecs=np.stack([r[2] for r in rows]).astype(np.float16),
                 hashes=np.stack([np.packbits(r[3][1]) if r[3] and r[3][0] == r[1] else blank for r in rows]))
        os.replace(tmp, self.emb_path)

    def _fingerprint(self, path: str) -> np.ndarray | None:
        """The picture's CLIP vector, computing it now if needed. None if the file can't be read."""
        try:
            sig = self._sig(path)
        except OSError:
            return None
        with self.lock:
            have = self.emb.get(path)
        if have and have[0] == sig:
            return have[1]
        try:
            img = autotag.load_small(Path(path))
        except Exception:
            img = None  # unreadable picture: remember, don't retry every time
        v = self.clip.embed_image(img) if img is not None else None  # RuntimeError if the model is missing
        with self.lock:
            self.emb[path] = (sig, v)
            if img is not None:
                self.hashes[path] = (sig, autotag.dhash(img))
            self.emb_dirty += 1
        return v

    def _hash(self, path: str) -> np.ndarray | None:
        with self.lock:
            h, e = self.hashes.get(path), self.emb.get(path)
        if h and e and h[0] == e[0]:
            return h[1]
        try:
            hv = autotag.dhash(autotag.load_small(Path(path)))
        except Exception:
            return None
        with self.lock:
            if e:
                self.hashes[path] = (e[0], hv)
                self.emb_dirty += 1
        return hv

    def auto_status(self) -> dict:
        with self.lock:
            done = sum(1 for p in self.items if p in self.emb)
            return {"on": self.auto, "installed": autotag.installed(), "ready": done, "total": len(self.items),
                    "working": bool(self.worker and self.worker.is_alive()), "error": self.auto_error}

    def set_auto(self, on: bool) -> dict:
        if on and not autotag.installed():
            raise ValueError("The auto-suggest model isn't installed yet. Quit the app and run ./setup.sh once "
                             "(it downloads about %d MB, then works offline)." % autotag.SIZE_MB)
        with self.lock:
            self.auto = on
            self._save()
        self.kick()
        return self.auto_status()

    def kick(self) -> None:
        """Fingerprint the list in the background (pictures still to sort first)."""
        with self.lock:
            if not autotag.installed() or (self.worker and self.worker.is_alive()):
                return
            self.worker = threading.Thread(target=self._work, daemon=True, name="fingerprints")
            self.worker.start()

    def _work(self) -> None:
        self.auto_error = ""
        try:
            while True:
                with self.lock:
                    todo = [p for p in self.items if p not in self.emb]
                    todo.sort(key=lambda p: bool(self.tags.get(p)))  # untagged first
                if not todo:
                    break
                for path in todo[:16]:
                    self._fingerprint(path)
                if self.emb_dirty >= 64:
                    self._save_fingerprints()
        except Exception as e:  # e.g. model missing or damaged
            self.auto_error = str(e)
        finally:
            if self.emb_dirty:
                self._save_fingerprints()

    def _ready(self, need: str = "suggestions") -> None:
        if not autotag.installed():
            raise ValueError(f"{need.capitalize()} need the auto-suggest model. Quit the app and run ./setup.sh once.")

    def _scorer(self, round_id: str | None):
        """A function giving category probabilities for a fingerprint, using your category names plus
        the pictures you've tagged yourself (auto-tags you haven't checked yet don't count)."""
        with self.lock:
            cats = list(self._round(round_id)["categories"])
            tagged = [(p, t) for p, t in self.tags.items() if t and p not in self.auto_tagged]
        names = np.stack([self.clip.embed_name(c["name"]) for c in cats])
        per: dict[str, list[tuple[str, np.ndarray]]] = {c["id"]: [] for c in cats}
        missing = 0
        for p, t in tagged:
            with self.lock:
                e = self.emb.get(p)
            if e is None and missing < 40 and os.path.exists(p):  # just tagged, not fingerprinted yet
                missing += 1
                v = self._fingerprint(p)
            else:
                v = e[1] if e else None
            if v is None:
                continue
            for cid in t:
                if cid in per:
                    per[cid].append((p, v))
        stacks = {cid: (np.stack([v for _, v in vs]), [p for p, _ in vs]) for cid, vs in per.items() if vs}

        def score(path: str, x: np.ndarray) -> np.ndarray:
            examples = []
            for c in cats:
                st = stacks.get(c["id"])
                if st is None:
                    examples.append(None)
                    continue
                keep = [k for k, q in enumerate(st[1]) if q != path]  # never learn from the picture itself
                examples.append(st[0][keep] if keep else None)
            return autotag.rank(x, names, examples)

        return cats, score

    def suggest(self, ids: list[str], round_id: str | None = None) -> dict:
        self._ready()
        rnd = self._round(round_id)
        if rnd["kind"] == "rating" or not rnd["categories"]:
            return {}  # it can recognise things, not judge them
        with self.lock:
            paths = {}
            for i in ids[:8]:
                try:
                    paths[i] = self._path(i)
                except KeyError:
                    pass
        if not paths:
            return {}
        cats, score = self._scorer(rnd["id"])
        out = {}
        for item_id, path in paths.items():
            x = self._fingerprint(path)
            if x is None:
                continue
            prob = score(path, x)
            order = np.argsort(prob)[::-1]
            out[item_id] = {"cat": cats[order[0]]["id"], "conf": round(float(prob[order[0]]), 3),
                            "next": cats[order[1]]["id"] if len(cats) > 1 else None}
        if self.emb_dirty >= 16:
            self._save_fingerprints()
        return out

    def auto_tag(self, threshold: float, apply: bool, round_id: str | None = None) -> dict:
        """Tag every untagged picture it's at least `threshold` sure about. They're marked as
        auto-tagged until you check them, and don't teach the model anything until then."""
        self._ready()
        threshold = min(0.99, max(0.5, float(threshold)))
        rnd = self._round(round_id)
        if rnd["kind"] == "rating":
            raise ValueError("Ratings can't be guessed. Rate these by hand.")
        if not rnd["categories"]:
            raise ValueError("Add some categories first.")
        cats, score = self._scorer(rnd["id"])
        ids = {c["id"] for c in cats}
        with self.lock:
            sk = self.skipped.get(rnd["id"], set())
            todo = [p for p in self.items if not ids & set(self.tags.get(p, [])) and p not in sk]
        picks, not_ready = [], 0
        for p in todo:
            with self.lock:
                e = self.emb.get(p)
            if e is None:
                not_ready += 1
                continue
            if e[1] is None:
                continue
            prob = score(p, e[1])
            k = int(prob.argmax())
            if prob[k] >= threshold:
                picks.append((p, cats[k]["id"]))
        per = {c["id"]: 0 for c in cats}
        for _, cid in picks:
            per[cid] += 1
        if apply and picks:
            with self.lock:
                for p, cid in picks:
                    if not ids & set(self.tags.get(p, [])):
                        self.tags[p] = self.tags.get(p, []) + [cid]
                        self.auto_tagged.add(p)
                self._save()
        return {"count": len(picks), "per": per, "not_ready": not_ready, "untagged": len(todo),
                "ids": [_item_id(p) for p, _ in picks] if apply else []}

    def duplicates(self) -> dict:
        """Groups of near-identical pictures: very similar to CLIP *and* nearly the same pixel pattern
        (so two different fortune slips, which CLIP finds alike, are not called duplicates)."""
        with self.lock:
            rows = [(p, self.emb[p][1]) for p in self.items if p in self.emb and self.emb[p][1] is not None]
        if len(rows) < 2:
            return {"groups": [], "ready": True}
        paths = [p for p, _ in rows]
        V = np.stack([v for _, v in rows])
        parent = list(range(len(paths)))

        def find(i):
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i

        for start in range(0, len(paths), 512):
            block = V[start:start + 512] @ V.T
            for a, b in zip(*np.nonzero(block >= 0.95)):
                i = start + int(a)
                j = int(b)
                if j <= i or find(i) == find(j):
                    continue
                hi, hj = self._hash(paths[i]), self._hash(paths[j])
                if hi is not None and hj is not None and int((hi != hj).sum()) <= 24:
                    parent[find(j)] = find(i)
        groups: dict[int, list[str]] = {}
        for i, p in enumerate(paths):
            groups.setdefault(find(i), []).append(p)
        order = {p: k for k, p in enumerate(self.items)}
        out = [sorted(g, key=order.get) for g in groups.values() if len(g) > 1]
        out.sort(key=lambda g: order[g[0]])
        if self.emb_dirty:
            self._save_fingerprints()
        return {"groups": [[_item_id(p) for p in g] for g in out],
                "ready": not (self.worker and self.worker.is_alive())}

    def search(self, query: str, limit: int = 300) -> list[dict]:
        self._ready("searching")
        query = query.strip()[:200]
        if not query:
            return []
        q = self.clip.embed_query(query)
        with self.lock:
            rows = [(p, self.emb[p][1]) for p in self.items if p in self.emb and self.emb[p][1] is not None]
        if not rows:
            return []
        sims = np.stack([v for _, v in rows]) @ q
        order = np.argsort(sims)[::-1]
        best = float(sims[order[0]])
        # CLIP scores are relative: keep what's close to the best match, not a fixed cut-off.
        keep = [k for k in order[:limit] if sims[k] >= best - 0.035]
        return [{"id": _item_id(rows[k][0]), "score": round(float(sims[k]), 4)} for k in keep]

    def unskip_all(self, round_id: str | None = None) -> None:
        with self.lock:
            self.skipped.get(self._round(round_id)["id"], set()).difference_update(self.items)
            self._save()

    def image(self, item_id: str, size: int) -> bytes:
        cache = self.big if size > 2000 else self.images  # full-size zooms: keep only a few
        with self.lock:
            path = self._path(item_id)
            key = (path, size)
            if key in cache:
                return cache[key]
        data = engine.preview_of_file(Path(path), size)
        with self.lock:
            cache.put(key, data)
        return data

    def path_of(self, item_id: str) -> Path:
        with self.lock:
            return Path(self._path(item_id))

    def paths_with(self, cat_id: str) -> list[str]:
        with self.lock:
            return [p for p in self.items if cat_id in self.tags.get(p, [])]

    # ---------- exports ----------
    def csv_bytes(self) -> bytes:
        with self.lock:
            buf = io.StringIO()
            w = csv.writer(buf)
            w.writerow(["File", "Folder", *[r["name"] for r in self.rounds], "Full path"])  # a column per round
            for p in self.items:
                t = set(self.tags.get(p, []))
                w.writerow([Path(p).name, Path(p).parent.name,
                            *["; ".join(c["name"] for c in r["categories"] if c["id"] in t) for r in self.rounds], p])
        return ("﻿" + buf.getvalue()).encode("utf-8")  # BOM so Excel/Numbers read accents correctly

    def copy_into_folders(self, dest: Path, include_untagged: bool = False, levels: list[str] | None = None) -> dict:
        """Copy pictures into dest/<round 1 category>[/<round 2 category>...] (the rounds in `levels`)."""
        dest = dest.expanduser().resolve()
        with self.lock:
            rounds = [r for rid in (levels or [self.rounds[0]["id"]]) for r in self.rounds if r["id"] == rid]
            if not rounds:
                rounds = self.rounds[:1]
            jobs = []
            for p in self.items:
                t = set(self.tags.get(p, []))
                paths = [""]
                for r in rounds:
                    names = [_safe_folder_name(c["name"]) for c in r["categories"] if c["id"] in t]
                    if not names:
                        if not include_untagged:
                            paths = []
                            break
                        names = ["Untagged"]
                    paths = [f"{a}/{n}" if a else n for a in paths for n in names]
                jobs += [(Path(p), folder) for folder in paths]
        if not jobs:
            raise ValueError("Nothing is tagged yet.")
        dest.mkdir(parents=True, exist_ok=True)
        (dest / SORTED_MARKER).write_text("Created by Background Studio's Sort & tag. "
                                          "This folder is skipped when adding folders to tag.\n", "utf-8")
        copied = already = 0
        problems = []
        for src, folder in jobs:
            try:
                target_dir = dest / folder
                target_dir.mkdir(parents=True, exist_ok=True)
                target = target_dir / src.name
                n = 2
                while target.exists():
                    if filecmp.cmp(src, target, shallow=False):
                        break  # this exact file is already there
                    target = target_dir / f"{src.stem} ({n}){src.suffix}"
                    n += 1
                if target.exists():
                    already += 1
                    continue
                tmp = target_dir / f".{target.name}.partial"
                shutil.copy2(src, tmp)
                if target.exists():  # appeared meanwhile; never overwrite
                    tmp.unlink()
                    already += 1
                    continue
                os.replace(tmp, target)
                copied += 1
            except OSError as e:
                problems.append(f"{src.name}: {e.strerror or e}")
        return {"copied": copied, "already": already, "problems": problems[:20], "dest": str(dest)}

    def finder_tags(self, remove: bool = False) -> dict:
        if sys.platform != "darwin":
            raise ValueError("Finder tags are only available on macOS.")
        with self.lock:
            cats = {c["id"]: c for c in self.categories}
            all_names = {c["name"] for c in self.categories}
            jobs = [(p, [cats[x] for x in self.tags.get(p, []) if x in cats]) for p in self.items]
        changed = 0
        problems = []
        for path, tagged in jobs:
            if not tagged and not remove:
                continue
            try:
                current = _read_finder_tags(path)
                names = [t.split("\n")[0] for t in current]
                if remove:
                    new = [t for t, n in zip(current, names) if n not in all_names]
                else:
                    new = list(current)
                    for c in tagged:
                        if c["name"] not in names:
                            new.append(f"{c['name']}\n{_finder_colour(c['color'])}")
                if new != current:
                    _write_finder_tags(path, new)
                    changed += 1
            except OSError as e:
                problems.append(f"{Path(path).name}: {e.strerror or e}")
        return {"changed": changed, "problems": problems[:20]}


# ---------- Finder tags via the extended attribute (no subprocess, no network) ----------
_libc = None


def _c():
    global _libc
    if _libc is None:
        _libc = ctypes.CDLL("libc.dylib", use_errno=True)
        _libc.getxattr.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_void_p, ctypes.c_size_t,
                                   ctypes.c_uint32, ctypes.c_int]
        _libc.getxattr.restype = ctypes.c_ssize_t
        _libc.setxattr.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_void_p, ctypes.c_size_t,
                                   ctypes.c_uint32, ctypes.c_int]
        _libc.setxattr.restype = ctypes.c_int
        _libc.removexattr.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int]
        _libc.removexattr.restype = ctypes.c_int
    return _libc


ENOATTR = 93  # macOS


def _read_finder_tags(path: str) -> list[str]:
    libc, p, name = _c(), os.fsencode(path), FINDER_TAGS.encode()
    size = libc.getxattr(p, name, None, 0, 0, 0)
    if size < 0:
        err = ctypes.get_errno()
        if err == ENOATTR:
            return []
        raise OSError(err, os.strerror(err))
    buf = ctypes.create_string_buffer(size)
    if libc.getxattr(p, name, buf, size, 0, 0) < 0:
        err = ctypes.get_errno()
        raise OSError(err, os.strerror(err))
    try:
        tags = plistlib.loads(buf.raw)
    except Exception:
        return []
    return [t for t in tags if isinstance(t, str)] if isinstance(tags, list) else []


def _write_finder_tags(path: str, tags: list[str]) -> None:
    libc, p, name = _c(), os.fsencode(path), FINDER_TAGS.encode()
    if not tags:
        if libc.removexattr(p, name, 0) < 0 and ctypes.get_errno() != ENOATTR:
            err = ctypes.get_errno()
            raise OSError(err, os.strerror(err))
        return
    data = plistlib.dumps(tags, fmt=plistlib.FMT_BINARY)
    if libc.setxattr(p, name, data, len(data), 0, 0) < 0:
        err = ctypes.get_errno()
        raise OSError(err if err else errno.EIO, os.strerror(err))
