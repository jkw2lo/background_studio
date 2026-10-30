"""Compare & merge: find what's the same and what's different across two or more folders.

Every file ends up in one of these:
  * exact duplicate   – byte-for-byte the same file (any type), wherever it lives
  * same picture      – looks identical but the file differs (re-saved, smaller export, HEIC vs JPG…)
  * versions          – the same subject, edited (cropped, rotated, cut out, recoloured…)
  * same name         – files with the same name that are different pictures (they'd collide)
  * only in one folder

Consolidating never changes the folders you compared unless you choose to: it either copies one of
everything into a new folder, or copies what's missing into the first ("main") folder. Afterwards,
redundant copies can optionally be moved to the Trash (recoverable). Nothing is ever deleted.
"""

from __future__ import annotations

import filecmp
import hashlib
import json
import os
import re
import shutil
import threading
import time
from pathlib import Path

import numpy as np
from PIL import Image

from . import autotag, engine
from .studio import LRU, _is_hidden

PRIVATE = (".background-studio", ".background-studio.json")
# Similarity rules (checked against real scans: re-saves and cut-outs of the same scan differ by
# 0–14 of 256 pattern bits; two *different* fortune slips CLIP rates 0.97 alike differ by 34+).
SAME_COS, SAME_BITS = 0.97, 12      # visually the same picture
VERSION_COS, VERSION_BITS = 0.93, 24  # an edited version
RELATED_COS = 0.80                  # if the file names say they're related, a looser match is enough
PATTERN_BITS = 6                    # pixel patterns this close are the same picture whatever CLIP says
                                    # (CLIP frames transparent cut-outs differently from flat pictures)
NO_CLIP_SAME_BITS, NO_CLIP_RELATED_BITS = 8, 48

# Only real "edited copy" markers: IMG_12 (2), IMG_12 copy 2, IMG_12 edited, IMG_12 Background Removed,
# Finder's "IMG_12 2". Never ordinary numbering, so IMG_12 and IMG_13 stay unrelated.
_SUFFIX = re.compile(r"(?:\s*\(\d+\)|\s+copy(?:\s+\d+)?|[\s_-]+(?:edited|edit|retouched|final|nobg|"
                     r"background removed|cut-?out|v\d+)|\s\d{1,2})+$", re.I)


def related_stem(name: str) -> str:
    """'IMG_1234 edited.jpg', 'IMG_1234 (2).png' and 'Copy of IMG_1234.heic' all give 'img_1234'."""
    stem = Path(name).stem.lower().strip()
    stem = re.sub(r"^copy of\s+", "", stem)
    base = _SUFFIX.sub("", stem).strip(" _-")
    return base or stem


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class Comparer:
    def __init__(self, tagger, data_dir: Path):
        self.tagger = tagger  # shares the picture fingerprints (and their cache) with Sort & tag
        self.lock = threading.RLock()
        self.path = data_dir / "compare.json"  # remembers the folders you picked
        self.folders: list[str] = []
        try:
            self.folders = [f for f in json.loads(self.path.read_text("utf-8")).get("folders", []) if Path(f).is_dir()]
        except (OSError, ValueError, AttributeError):
            pass
        self.files: list[dict] = []
        self.groups: list[dict] = []
        self.conflicts: list[list[int]] = []
        self.job = {"running": False, "phase": "", "done": 0, "total": 0, "error": "", "finished": 0.0}
        self.cancel_flag = False
        self.version = 0
        self.thumbs = LRU(1500)
        self.last = {}  # result of the last consolidation (for the Trash step)

    # ---------- folders ----------
    def set_folders(self, folders: list[str]) -> list[str]:
        out: list[str] = []
        for raw in folders:
            p = Path(os.path.expanduser(str(raw))).resolve()
            if not p.is_dir():
                raise ValueError(f"Not a folder: {raw}")
            if str(p) in out:
                continue
            for q in out:
                if str(p).startswith(q + "/") or q.startswith(str(p) + "/"):
                    raise ValueError(f"“{p.name}” and “{Path(q).name}” are inside one another. Pick folders side by side.")
            out.append(str(p))
        with self.lock:
            if self.job["running"]:
                raise ValueError("A comparison is running. Cancel it first.")
            self.folders = out[:8]
            self.files, self.groups, self.conflicts, self.last = [], [], [], {}
            self.version += 1
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                self.path.write_text(json.dumps({"folders": self.folders}), "utf-8")
            except OSError:
                pass
        return self.folders

    # ---------- the comparison ----------
    def start(self) -> None:
        with self.lock:
            if self.job["running"]:
                return
            if len(self.folders) < 2:
                raise ValueError("Choose at least two folders.")
            self.cancel_flag = False
            self.job = {"running": True, "phase": "Listing files", "done": 0, "total": 0, "error": "", "finished": 0.0}
            self.files, self.groups, self.conflicts, self.last = [], [], [], {}
            self.version += 1
        threading.Thread(target=self._run, daemon=True, name="compare").start()

    def cancel(self) -> None:
        self.cancel_flag = True

    def _phase(self, name: str, total: int) -> None:
        with self.lock:
            self.job.update(phase=name, done=0, total=total)
            self.version += 1

    def _tick(self, n: int = 1) -> None:
        with self.lock:
            self.job["done"] += n
            if self.job["done"] % 25 == 0 or self.job["done"] == self.job["total"]:
                self.version += 1
        if self.cancel_flag:
            raise InterruptedError

    def _run(self) -> None:
        try:
            files = self._list()
            groups, conflicts = self._compare(files)
            with self.lock:
                self.files, self.groups, self.conflicts = files, groups, conflicts
                self.job.update(running=False, phase="done", finished=time.time())
        except InterruptedError:
            with self.lock:
                self.job.update(running=False, phase="cancelled")
        except Exception as e:  # keep the app alive; show the problem
            with self.lock:
                self.job.update(running=False, phase="error", error=engine.friendly_error(e))
        finally:
            with self.lock:
                self.version += 1
            if self.tagger.emb_dirty:
                self.tagger._save_fingerprints()

    def _list(self) -> list[dict]:
        files = []
        for fi, root in enumerate(self.folders):
            for dirpath, dirnames, filenames in os.walk(root):
                dirnames[:] = sorted(n for n in dirnames if not n.startswith(".") and n not in PRIVATE)
                for fn in sorted(filenames):
                    f = Path(dirpath) / fn
                    if _is_hidden(f) or fn in PRIVATE or fn.endswith(".partial"):
                        continue
                    try:
                        st = f.stat()
                    except OSError:
                        continue
                    files.append({"id": len(files), "folder": fi, "path": str(f), "rel": f.relative_to(root).as_posix(),
                                  "name": fn, "size": st.st_size, "mtime": st.st_mtime,
                                  "image": f.suffix.lower() in engine.IMAGE_EXTS})
                    if len(files) % 200 == 0:
                        self._tick(0)
        return files

    def _compare(self, files: list[dict]) -> tuple[list[dict], list[list[int]]]:
        # 1) Exact duplicates: only files of the same size can be identical, so only those are read.
        by_size: dict[int, list[dict]] = {}
        for f in files:
            by_size.setdefault(f["size"], []).append(f)
        to_hash = [f for g in by_size.values() if len(g) > 1 for f in g]
        self._phase("Checking for exact copies", len(to_hash))
        for f in to_hash:
            try:
                f["sha"] = _sha256(f["path"])
            except OSError:
                f["sha"] = f"unreadable:{f['id']}"
            self._tick()
        variant_of: dict[str, int] = {}  # sha -> variant index
        variants: list[list[int]] = []   # each: ids of byte-identical files
        for f in files:
            key = f.get("sha") or f"unique:{f['id']}"
            if key not in variant_of:
                variant_of[key] = len(variants)
                variants.append([])
            variants[variant_of[key]].append(f["id"])
            f["variant"] = variant_of[key]

        # 2) Pictures: one representative per variant gets a fingerprint and a pixel-pattern hash.
        reps = [v[0] for v in variants if files[v[0]]["image"]]
        self._phase("Looking at the pictures", len(reps))
        use_clip = autotag.installed()
        vecs: dict[int, np.ndarray] = {}
        bits: dict[int, np.ndarray] = {}
        for fid in reps:
            f = files[fid]
            try:
                with Image.open(f["path"]) as im:
                    f["w"], f["h"] = im.size
                    f["alpha"] = im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info)
            except Exception:
                f["broken"] = True
            if not f.get("broken"):
                if use_clip:
                    v = self.tagger._fingerprint(f["path"])
                    h = self.tagger._hash(f["path"]) if v is not None else None
                    if v is not None:
                        vecs[fid] = v
                else:
                    try:
                        h = autotag.dhash(autotag.load_small(Path(f["path"])))
                    except Exception:
                        h = None
                if h is not None:
                    bits[fid] = h
            self._tick()
        for v in variants:  # copies share the representative's dimensions
            for fid in v[1:]:
                for k in ("w", "h", "alpha", "broken"):
                    if k in files[v[0]]:
                        files[fid][k] = files[v[0]][k]

        # 3) Which pictures belong together, and how.
        self._phase("Grouping", 1)
        ids = [fid for fid in reps if fid in bits]
        pairs: dict[tuple[int, int], str] = {}

        def verdict(a: int, b: int, related: bool) -> str | None:
            fa, fb = files[a], files[b]
            d = int((bits[a] != bits[b]).sum())
            cos = float(vecs[a] @ vecs[b]) if a in vecs and b in vecs else None
            textured = min(int(bits[a].sum()), int(bits[b].sum())) >= 32  # a blank page has no pattern
            if textured and d <= PATTERN_BITS:
                visually_same = True
            elif cos is not None:
                visually_same = cos >= SAME_COS and d <= SAME_BITS
                if not visually_same and not (cos >= VERSION_COS and d <= VERSION_BITS) and not (related and cos >= RELATED_COS):
                    return None
            else:
                visually_same = d <= NO_CLIP_SAME_BITS
                if not visually_same and not (related and d <= NO_CLIP_RELATED_BITS):
                    return None
            # Same-looking but cropped / cut out / rotated counts as a version, not a copy.
            ra = fa.get("w", 1) / max(1, fa.get("h", 1))
            rb = fb.get("w", 1) / max(1, fb.get("h", 1))
            if visually_same and abs(ra - rb) <= 0.02 * max(ra, rb) and fa.get("alpha") == fb.get("alpha"):
                return "same"
            return "version"

        if use_clip and len(ids) > 1:
            order = [i for i in ids if i in vecs]
            V = np.stack([vecs[i] for i in order]) if order else None
            for start in range(0, len(order), 512):
                block = V[start:start + 512] @ V.T
                for x, y in zip(*np.nonzero(block >= VERSION_COS)):
                    a, b = order[start + int(x)], order[int(y)]
                    if a < b and (a, b) not in pairs:
                        v = verdict(a, b, False)
                        if v:
                            pairs[(a, b)] = v
        elif len(ids) > 1:  # no fingerprints: compare pixel patterns directly
            B = np.stack([bits[i] for i in ids]).astype(np.uint8)
            for k, a in enumerate(ids):
                d = (B[k + 1:] != B[k]).sum(axis=1)
                for j in np.nonzero(d <= NO_CLIP_SAME_BITS)[0]:
                    b = ids[k + 1 + int(j)]
                    v = verdict(min(a, b), max(a, b), False)
                    if v:
                        pairs[(min(a, b), max(a, b))] = v
        # related names get a second, looser look
        buckets: dict[str, list[int]] = {}
        for fid in ids:
            buckets.setdefault(related_stem(files[fid]["name"]), []).append(fid)
        for members in buckets.values():
            if 1 < len(members) <= 50:
                for i, a in enumerate(members):
                    for b in members[i + 1:]:
                        key = (min(a, b), max(a, b))
                        if key not in pairs:
                            v = verdict(key[0], key[1], True)
                            if v:
                                pairs[key] = v

        # union the variants into groups
        parent = {i: i for i in range(len(variants))}

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        for (a, b) in pairs:
            ra, rb = find(files[a]["variant"]), find(files[b]["variant"])
            if ra != rb:
                parent[rb] = ra
        members: dict[int, list[int]] = {}
        for vi in range(len(variants)):
            members.setdefault(find(vi), []).append(vi)
        kind_of_pair = {}
        for (a, b), v in pairs.items():
            kind_of_pair.setdefault(find(files[a]["variant"]), set()).add(v)

        groups = []
        for root, vis in members.items():
            nfiles = sum(len(variants[v]) for v in vis)
            if nfiles < 2:
                continue
            kind = "exact" if len(vis) == 1 else ("versions" if "version" in kind_of_pair.get(root, set()) else "same")
            gv = []
            for v in vis:
                fids = sorted(variants[v], key=lambda i: (files[i]["folder"], len(files[i]["rel"]), files[i]["rel"]))
                gv.append({"files": fids})
            # best first: most pixels, then biggest file, then newest
            gv.sort(key=lambda x: (-(files[x["files"][0]].get("w", 0) * files[x["files"][0]].get("h", 0)),
                                   -files[x["files"][0]]["size"], -files[x["files"][0]]["mtime"]))
            # Variants that are the *same picture* as each other form a "twin" set; by default only the
            # best of each set is kept (so a smaller re-export of one version doesn't survive), while
            # every genuinely different version is kept.
            vidx = {v: k for k, v in enumerate(vis)}
            twin = list(range(len(vis)))

            def tfind(k):
                while twin[k] != k:
                    twin[k] = twin[twin[k]]
                    k = twin[k]
                return k

            for (a, b), v in pairs.items():
                va, vb = files[a]["variant"], files[b]["variant"]
                if v == "same" and va in vidx and vb in vidx:
                    twin[tfind(vidx[vb])] = tfind(vidx[va])
            for x in gv:
                vi = files[x["files"][0]]["variant"]
                x["set"] = tfind(vidx[vi])
            seen_sets = set()
            for x in gv:  # gv is best-first
                x["keep"] = x["set"] not in seen_sets
                seen_sets.add(x["set"])
            labels = {}
            for x in gv:
                x["set"] = labels.setdefault(x["set"], len(labels))
            folders_in = sorted({files[i]["folder"] for x in gv for i in x["files"]})
            groups.append({"id": len(groups), "kind": kind, "variants": gv, "folders": folders_in})
        groups.sort(key=lambda g: min(files[i]["folder"] * 10**9 + i for x in g["variants"] for i in x["files"]))
        for k, g in enumerate(groups):
            g["id"] = k
            for x in g["variants"]:
                for i in x["files"]:
                    files[i]["group"] = k

        # 4) Same name, different picture (they'd collide when merged).
        by_name: dict[str, list[int]] = {}
        for f in files:
            by_name.setdefault(f["name"].lower(), []).append(f["id"])
        conflicts = []
        for fids in by_name.values():
            if len({files[i]["folder"] for i in fids}) < 2:
                continue
            if len({files[i].get("group", f"solo{i}") for i in fids}) > 1:
                conflicts.append(fids)
        self._tick()
        return groups, conflicts

    # ---------- state ----------
    def state(self) -> dict:
        with self.lock:
            out = {"version": self.version, "folders": self.folders, "job": dict(self.job), "last": self.last}
            if self.job["phase"] == "done":
                out.update(files=self.files, groups=self.groups, conflicts=self.conflicts, summary=self._summary())
            return out

    def _summary(self) -> dict:
        s = {"files": len(self.files), "exact": 0, "same": 0, "versions": 0, "conflicts": len(self.conflicts),
             "only": [0] * len(self.folders), "saved_bytes": 0}
        for g in self.groups:
            s[g["kind"]] += 1
            for x in g["variants"]:
                f0 = self.files[x["files"][0]]
                extra = len(x["files"]) - 1 if x["keep"] else len(x["files"])
                s["saved_bytes"] += extra * f0["size"]
        for f in self.files:
            if "group" not in f:
                s["only"][f["folder"]] += 1
        return s

    def set_keep(self, group_id: int, keep: list[int]) -> None:
        with self.lock:
            g = self.groups[group_id]
            ks = set(int(k) for k in keep)
            if not ks:
                raise ValueError("Keep at least one.")
            for k, x in enumerate(g["variants"]):
                x["keep"] = k in ks
            self.version += 1

    def file(self, fid: int) -> dict:
        with self.lock:
            return self.files[fid]

    def image(self, fid: int, size: int) -> bytes:
        f = self.file(fid)
        key = (f["path"], size)
        with self.lock:
            if key in self.thumbs:
                return self.thumbs[key]
        data = engine.preview_of_file(Path(f["path"]), size)
        with self.lock:
            self.thumbs.put(key, data)
        return data

    # ---------- consolidating ----------
    def _plan(self) -> list[tuple[int, str, bool]]:
        """(file id to keep, its relative path, is a version) — one entry per thing that survives."""
        out = []
        with self.lock:
            files, groups = self.files, self.groups
            for f in files:
                if "group" not in f:
                    out.append((f["id"], f["rel"], False))
            for g in groups:
                for x in g["variants"]:
                    if x["keep"]:
                        out.append((x["files"][0], files[x["files"][0]]["rel"], g["kind"] == "versions"))
        out.sort(key=lambda t: (files[t[0]]["folder"], t[1]))
        return out

    @staticmethod
    def _free_name(dest: Path, rel: str, taken: set[str], version: bool) -> str:
        p = Path(rel)
        cand, n = rel, 2
        while cand.lower() in taken or (dest / cand).exists():
            label = f" (version {n})" if version else f" ({n})"
            cand = (p.parent / f"{p.stem}{label}{p.suffix}").as_posix()
            n += 1
        taken.add(cand.lower())
        return cand

    def consolidate(self, mode: str, dest: str | None = None) -> dict:
        with self.lock:
            if self.job["phase"] != "done":
                raise ValueError("Compare the folders first.")
            folders = list(self.folders)
        plan = self._plan()
        if mode == "new":
            if not dest:
                raise ValueError("Choose where the merged folder should go.")
            target = Path(dest).expanduser().resolve()
            for f in folders:
                if str(target) == f or str(target).startswith(f + "/"):
                    raise ValueError("The merged folder can't be inside one of the folders you're comparing.")
            target.mkdir(parents=True, exist_ok=True)
            todo = plan
        elif mode == "into_first":
            target = Path(folders[0])
            todo = [(fid, rel, ver) for fid, rel, ver in plan if self.files[fid]["folder"] != 0]
        else:
            raise ValueError("Unknown way to consolidate.")
        copied, already, problems = 0, 0, []
        taken: set[str] = set()
        placed: dict[int, str] = {}  # file id -> where it now lives in the target
        for fid, rel, ver in todo:
            src = Path(self.files[fid]["path"])
            try:
                want = target / rel
                if want.exists() and filecmp.cmp(src, want, shallow=False):
                    already += 1
                    placed[fid] = str(want)
                    taken.add(rel.lower())
                    continue
                rel2 = self._free_name(target, rel, taken, ver)
                out = target / rel2
                out.parent.mkdir(parents=True, exist_ok=True)
                tmp = out.with_name(f".{out.name}.partial")
                shutil.copy2(src, tmp)
                if out.exists():  # appeared meanwhile; never overwrite
                    tmp.unlink()
                    problems.append(f"{rel2}: already exists, left alone")
                    continue
                os.replace(tmp, out)
                placed[fid] = str(out)
                copied += 1
            except OSError as e:
                problems.append(f"{rel}: {e.strerror or e}")
        result = {"mode": mode, "dest": str(target), "copied": copied, "already": already,
                  "kept": len(plan), "problems": problems[:30], "when": time.time()}
        with self.lock:
            self.last = dict(result, trash=self._trash_list(mode, plan, placed) if mode == "into_first" else [])
            result["trash_count"] = len(self.last["trash"])
            self.last["trash_count"] = result["trash_count"]
            self.version += 1
        return result

    def _trash_list(self, mode: str, plan, placed: dict[int, str]) -> list[int]:
        """After merging into the main folder: files elsewhere (or extra copies in it) that are now redundant."""
        keep_in_main = set()
        for fid, _rel, _ver in plan:
            f = self.files[fid]
            if f["folder"] == 0:
                keep_in_main.add(fid)
            elif fid not in placed:
                return []  # something wasn't copied; don't offer to trash anything
        # everything outside the main folder, plus extra copies / dropped versions inside it
        return [f["id"] for f in self.files if f["id"] not in keep_in_main and (f["folder"] != 0 or "group" in f)]

    def trash(self) -> dict:
        with self.lock:
            ids = list(self.last.get("trash", []))
            if not ids:
                raise ValueError("Nothing to move to the Trash.")
            paths = [self.files[i]["path"] for i in ids]
        moved, problems = 0, []
        for p in paths:
            try:
                _to_trash(Path(p))
                moved += 1
            except OSError as e:
                problems.append(f"{Path(p).name}: {e.strerror or e}")
        with self.lock:
            self.last["trash"] = []
            self.last["trashed"] = moved
            self.version += 1
        return {"moved": moved, "problems": problems[:30]}


def _to_trash(path: Path) -> None:
    """Move a file to the Trash (recoverable). Uses the Trash on the file's own disk."""
    home_trash = Path.home() / ".Trash"
    dev = path.stat().st_dev
    if home_trash.exists() and home_trash.stat().st_dev == dev:
        trash = home_trash
    else:  # external disk: its own .Trashes/<uid>
        mount = path
        while mount.parent != mount and mount.parent.stat().st_dev == dev:
            mount = mount.parent
        trash = mount / ".Trashes" / str(os.getuid())
        trash.mkdir(parents=True, exist_ok=True)
    target = trash / path.name
    n = 2
    while target.exists():
        target = trash / f"{path.stem} {n}{path.suffix}"
        n += 1
    os.rename(path, target)
