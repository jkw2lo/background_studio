"""Local web server for the Background Studio UI.

Listens on 127.0.0.1 only. Every API call must carry a random token that is
generated at launch and embedded in the page, and requests whose Host header
is not this machine are rejected (protects against other websites and DNS
rebinding). The page's Content-Security-Policy forbids loading or sending
anything to any other origin.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import secrets
import signal
import socket
import subprocess
import sys
import threading
import webbrowser
from pathlib import Path

from . import netguard

netguard.install()  # before anything else gets a chance to open a connection

from flask import Flask, abort, jsonify, request, send_file  # noqa: E402
from werkzeug.serving import make_server  # noqa: E402

from . import engine, models  # noqa: E402
from .studio import Studio  # noqa: E402
from .tagger import SORTED_MARKER, Tagger  # noqa: E402
from .compare import Comparer  # noqa: E402

models.disable_downloads()

ROOT = Path(__file__).resolve().parent.parent
STATIC = Path(__file__).resolve().parent / "static"
TOKEN = secrets.token_urlsafe(24)

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = 4 * 1024 ** 3  # per request (dropped files, touch-up edits)
DATA = Path(os.environ.get("BGSTUDIO_DATA") or ROOT / "data")  # override is for testing
studio = Studio(DATA)
tagger = Tagger(DATA)
comparer = Comparer(tagger, DATA)
RUNFILE = DATA / "server.json"  # tells the launcher (and a second start) where the running app is
ALLOWED_HOSTS: set[str] = set()

CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; "
       "connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")


@app.before_request
def guard():
    if request.host not in ALLOWED_HOSTS:
        abort(403)
    if request.path.startswith("/api/"):
        supplied = request.headers.get("X-Studio-Token") or request.args.get("t", "")
        if not secrets.compare_digest(supplied, TOKEN):
            abort(403)


@app.after_request
def headers(resp):
    resp.headers["Content-Security-Policy"] = CSP
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["Cross-Origin-Resource-Policy"] = "same-origin"
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


@app.errorhandler(ValueError)
def bad_request(e):
    return jsonify(error=str(e)), 400


# ---------- pages ----------
def _page(name: str):
    html = (STATIC / name).read_text("utf-8").replace("__TOKEN__", TOKEN)
    return html, 200, {"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store"}


@app.get("/")
def index():
    return _page("index.html")


@app.get("/tag")
def tag_page():
    return _page("tag.html")


@app.get("/compare")
def compare_page():
    return _page("compare.html")


@app.get("/static/<path:name>")
def static_file(name):
    path = (STATIC / name).resolve()
    if not path.is_file() or STATIC not in path.parents:
        abort(404)
    return send_file(path, max_age=0)


# ---------- state & settings ----------
@app.get("/api/state")
def state():
    snap = studio.snapshot()
    if request.args.get("v") == str(snap["version"]):
        return jsonify(version=snap["version"], unchanged=True)
    snap["models"] = models.describe()
    snap["network"] = netguard.status()
    return jsonify(snap)


@app.get("/api/info")
def info():
    return jsonify(models=models.describe(), network=netguard.status(),
                   formats=sorted(engine.IMAGE_EXTS))


@app.post("/api/settings")
def settings():
    s = studio.update_settings(request.get_json(force=True) or {})
    return jsonify(ok=True, settings=s.__dict__)


# ---------- adding images ----------
@app.post("/api/add-paths")
def add_paths():
    body = request.get_json(force=True) or {}
    return jsonify(studio.add_paths(body.get("paths", [])))


@app.post("/api/upload")
def upload():
    drop_id = request.form.get("drop", "drop")
    rels = request.form.getlist("rel")
    files = request.files.getlist("file")
    added = ignored = dup = 0
    errors = []
    for i, f in enumerate(files):
        rel = rels[i] if i < len(rels) and rels[i] else (f.filename or "image")
        try:
            r = studio.add_upload(drop_id, rel, f.stream)
            added += r.get("added", 0)
            ignored += r.get("ignored", 0)
            dup += r.get("duplicate", 0)
        except Exception as e:  # keep going with the rest of the drop
            errors.append(f"{rel}: {e}")
    return jsonify(added=added, ignored=ignored, duplicates=dup, problems=errors)


def _osascript(script: str) -> list[str]:
    """Show a native macOS dialog. Returns POSIX paths, or [] if the user cancelled."""
    if sys.platform != "darwin":
        raise ValueError("Native file dialogs are only available on macOS. Paste a path instead.")
    proc = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
    if proc.returncode != 0:
        if "-128" in proc.stderr:  # user pressed Cancel
            return []
        raise ValueError(proc.stderr.strip() or "Could not open the file dialog.")
    return [ln for ln in proc.stdout.splitlines() if ln.strip()]


PICK_SCRIPTS = {
    "files": '''activate
set picked to choose file with prompt "Choose images to add" with multiple selections allowed
set out to ""
repeat with f in picked
  set out to out & POSIX path of f & linefeed
end repeat
return out''',
    "folder": '''activate
set picked to choose folder with prompt "Choose folders of images (subfolders are included)" with multiple selections allowed
set out to ""
repeat with f in picked
  set out to out & POSIX path of f & linefeed
end repeat
return out''',
    "output": '''activate
return POSIX path of (choose folder with prompt "Choose where to save results")''',
    "tag-files": '''activate
set picked to choose file with prompt "Choose images to tag" with multiple selections allowed
set out to ""
repeat with f in picked
  set out to out & POSIX path of f & linefeed
end repeat
return out''',
    "tag-folder": '''activate
set picked to choose folder with prompt "Choose folders of images to tag (subfolders are included)" with multiple selections allowed
set out to ""
repeat with f in picked
  set out to out & POSIX path of f & linefeed
end repeat
return out''',
    "compare-folder": '''activate
set picked to choose folder with prompt "Choose two or more folders to compare (hold ⌘ to pick several)" with multiple selections allowed
set out to ""
repeat with f in picked
  set out to out & POSIX path of f & linefeed
end repeat
return out''',
    "compare-dest": '''activate
return POSIX path of (choose folder with prompt "Choose where to create the merged folder")''',
    "tag-dest": '''activate
return POSIX path of (choose folder with prompt "Choose where to put the category folders (images are copied, not moved)")''',
}


_dialog_open = threading.Lock()  # one Finder dialog at a time


@app.post("/api/pick")
def pick():
    kind = (request.get_json(force=True) or {}).get("kind")
    if kind not in PICK_SCRIPTS:
        abort(400)
    if not _dialog_open.acquire(blocking=False):  # a click while the dialog is still opening
        return jsonify(busy=True)
    try:
        paths = _osascript(PICK_SCRIPTS[kind])
    finally:
        _dialog_open.release()
    if not paths:
        return jsonify(cancelled=True)
    if kind == "output":
        s = studio.update_settings({"output_dir": paths[0]})
        return jsonify(settings=s.__dict__)
    if kind in ("tag-files", "tag-folder"):
        return jsonify(tagger.add_paths(paths))
    if kind == "tag-dest":
        return jsonify(dest=tagger.set_dest(paths[0]))
    if kind == "compare-folder":
        return jsonify(paths=paths)
    if kind == "compare-dest":
        return jsonify(dest=paths[0])
    return jsonify(studio.add_paths(paths))


@app.post("/api/remove")
def remove():
    studio.remove((request.get_json(force=True) or {}).get("ids", []))
    return jsonify(ok=True)


@app.post("/api/clear")
def clear():
    studio.clear()
    return jsonify(ok=True)


# ---------- running ----------
@app.post("/api/start")
def start():
    body = request.get_json(silent=True) or {}
    studio.start(retry_failed=bool(body.get("retry_failed")), ids=body.get("ids") or None)
    return jsonify(ok=True)


@app.post("/api/redo")
def redo():
    body = request.get_json(force=True) or {}
    studio.redo(str(body.get("id", "")), str(body.get("mode", "")))
    return jsonify(ok=True)


@app.post("/api/preview")
def preview():
    body = request.get_json(force=True) or {}
    try:
        return jsonify(studio.preview(str(body.get("id", "")), str(body.get("mode", "")), body.get("adjust") or {},
                                      geometry_only=bool(body.get("geometry_only"))))
    except RuntimeError as e:  # e.g. model not installed
        return jsonify(error=str(e)), 400


@app.post("/api/detect-crop")
def detect_crop():
    body = request.get_json(force=True) or {}
    return jsonify(quad=studio.detect_crop(str(body.get("id", "")), body.get("adjust") or {}))


@app.post("/api/straighten")
def straighten():
    body = request.get_json(force=True) or {}
    return jsonify(angle=studio.straighten(str(body.get("id", "")), body.get("adjust") or {}))


@app.get("/api/edits/<item_id>")
def get_edits(item_id):
    path = studio.edits_file(item_id)
    if path is None:
        abort(404)
    return send_file(path, mimetype="image/png", max_age=0)


@app.post("/api/adjust")
def adjust():
    body = request.get_json(force=True) or {}
    studio.save_adjustments(str(body.get("id", "")), str(body.get("mode", "")), body.get("adjust") or {},
                            body.get("edits"), str(body.get("edits_action", "keep")))
    return jsonify(ok=True)


@app.post("/api/cancel")
def cancel():
    studio.cancel()
    return jsonify(ok=True)


# ---------- results ----------
@app.get("/api/image/<item_id>/<kind>")
def image(item_id, kind):
    if kind not in ("original", "result"):
        abort(404)
    size = 1600 if request.args.get("size") == "large" else 320
    try:
        data, mime = studio.image_bytes(item_id, kind, size)
    except KeyError:
        abort(404)
    except Exception:
        abort(422)
    return data, 200, {"Content-Type": mime, "Cache-Control": "private, max-age=3600"}


@app.get("/api/full/<item_id>")
def full(item_id):
    try:
        return send_file(studio.result_path(item_id), mimetype="image/png", max_age=0)
    except KeyError:
        abort(404)


@app.get("/api/zip")
def zip_download():
    path = studio.build_zip()
    return send_file(path, mimetype="application/zip", as_attachment=True, download_name=path.name)


@app.post("/api/reveal")
def reveal():
    body = request.get_json(force=True) or {}
    if body.get("id"):
        p = studio.path_for_reveal(body["id"], body.get("which", "result"))
        subprocess.run(["open", "-R", str(p)], check=False)
    else:
        out = Path(studio.settings.output_dir)
        out.mkdir(parents=True, exist_ok=True)
        subprocess.run(["open", str(out)], check=False)
    return jsonify(ok=True)


# ---------- sort & tag ----------
@app.get("/api/tag/state")
def tag_state():
    return jsonify(tagger.state())


@app.post("/api/tag/add-paths")
def tag_add_paths():
    return jsonify(tagger.add_paths((request.get_json(force=True) or {}).get("paths", [])))


@app.post("/api/tag/clear")
def tag_clear():
    body = request.get_json(silent=True) or {}
    if body.get("forget_tags"):
        tagger.forget_tags(body.get("round"))
    else:
        tagger.clear()
    return jsonify(tagger.state())


@app.post("/api/tag/categories")
def tag_categories():
    body = request.get_json(force=True) or {}
    tagger.set_categories(body.get("categories"), body.get("round"))
    return jsonify(tagger.state())


@app.post("/api/tag/rounds")
def tag_rounds():
    body = request.get_json(force=True) or {}
    action, rid = body.get("action"), str(body.get("round", ""))
    if action == "add":
        tagger.add_round(str(body.get("name", "")), str(body.get("kind", "tags")))
    elif action == "rename":
        tagger.rename_round(rid, str(body.get("name", "")))
    elif action == "move":
        tagger.move_round(rid, int(body.get("delta", 0)))
    elif action == "delete":
        tagger.delete_round(rid)
    else:
        abort(400)
    return jsonify(tagger.state())


@app.post("/api/tag/set")
def tag_set():
    body = request.get_json(force=True) or {}
    tags = body.get("tags")
    skipped = body.get("skipped")
    try:
        return jsonify(tagger.set_item(str(body.get("id", "")), list(tags) if isinstance(tags, list) else None,
                                       bool(skipped) if skipped is not None else None, body.get("round")))
    except KeyError:
        abort(404)


@app.get("/api/tag/recent")
def tag_recent():
    extra = [(studio.settings.output_dir, "Background removal results")]
    extra += [(str(r), "Added to Remove backgrounds") for r in studio.roots]
    return jsonify(folders=tagger.recent_folders(extra))


@app.post("/api/tag/remove-folder")
def tag_remove_folder():
    tagger.remove_folder(str((request.get_json(force=True) or {}).get("folder", "")))
    return jsonify(tagger.state())


@app.post("/api/tag/sets")
def tag_sets():
    body = request.get_json(force=True) or {}
    action, name = body.get("action"), str(body.get("name", ""))
    if action == "save":
        tagger.save_set(name, body.get("round"))
    elif action == "delete":
        tagger.delete_set(name)
    elif action == "use":
        tagger.use_set(name, body.get("round"))
    else:
        abort(400)
    return jsonify(tagger.state())


@app.post("/api/tag/rescan")
def tag_rescan():
    r = tagger.rescan()
    return jsonify(result=r, state=tagger.state())


@app.post("/api/tag/auto")
def tag_auto():
    return jsonify(tagger.set_auto(bool((request.get_json(force=True) or {}).get("on"))))


@app.get("/api/tag/auto")
def tag_auto_status():
    return jsonify(tagger.auto_status())


@app.post("/api/tag/suggest")
def tag_suggest():
    body = request.get_json(force=True) or {}
    ids = body.get("ids") or []
    try:
        return jsonify(suggestions=tagger.suggest([str(i) for i in ids], body.get("round")), auto=tagger.auto_status())
    except RuntimeError as e:  # model missing or damaged
        return jsonify(error=str(e)), 400


@app.post("/api/tag/set-many")
def tag_set_many():
    body = request.get_json(force=True) or {}
    items = body.get("items")
    if not isinstance(items, list):
        raise ValueError("items must be a list")
    return jsonify(items=tagger.set_many([i for i in items if isinstance(i, dict)]))


@app.post("/api/tag/auto-tag")
def tag_auto_tag():
    body = request.get_json(force=True) or {}
    return jsonify(tagger.auto_tag(body.get("threshold", 0.9), bool(body.get("apply")), body.get("round")))


@app.get("/api/tag/duplicates")
def tag_duplicates():
    return jsonify(tagger.duplicates())


@app.post("/api/tag/search")
def tag_search():
    return jsonify(results=tagger.search(str((request.get_json(force=True) or {}).get("q", ""))))


@app.post("/api/tag/unskip")
def tag_unskip():
    tagger.unskip_all((request.get_json(silent=True) or {}).get("round"))
    return jsonify(tagger.state())


@app.get("/api/tag/image/<item_id>")
def tag_image(item_id):
    size = {"thumb": 360, "large": 2000, "full": 5000}.get(request.args.get("size", "large"), 2000)
    try:
        data = tagger.image(item_id, size)
    except KeyError:
        abort(404)
    except Exception:
        abort(422)
    mime = "image/webp" if data[:4] == b"RIFF" else "image/jpeg"
    return data, 200, {"Content-Type": mime, "Cache-Control": "private, max-age=3600"}


@app.get("/api/tag/csv")
def tag_csv():
    return tagger.csv_bytes(), 200, {"Content-Type": "text/csv; charset=utf-8",
                                     "Content-Disposition": 'attachment; filename="image-tags.csv"'}


@app.post("/api/tag/copy")
def tag_copy():
    body = request.get_json(force=True) or {}
    dest = str(body.get("dest") or tagger.dest or "").strip()
    if not dest:
        raise ValueError("Choose a folder for the sorted copies first.")
    levels = [str(x) for x in body.get("levels") or []]
    return jsonify(tagger.copy_into_folders(Path(dest), bool(body.get("include_untagged")), levels))


@app.post("/api/tag/finder")
def tag_finder():
    return jsonify(tagger.finder_tags(remove=bool((request.get_json(force=True) or {}).get("remove"))))


@app.post("/api/tag/send")
def tag_send():
    paths = tagger.paths_with(str((request.get_json(force=True) or {}).get("category", "")))
    if not paths:
        raise ValueError("No images have that tag.")
    return jsonify(studio.add_paths(paths))


@app.post("/api/tag/reveal")
def tag_reveal():
    body = request.get_json(force=True) or {}
    if body.get("id"):
        try:
            subprocess.run(["open", "-R", str(tagger.path_of(str(body["id"])))], check=False)
        except KeyError:
            abort(404)
    else:  # only folders this app sorted images into
        d = Path(str(body.get("dest", ""))).expanduser()
        if not (d.is_dir() and (d / SORTED_MARKER).exists()):
            abort(404)
        subprocess.run(["open", str(d)], check=False)
    return jsonify(ok=True)


# ---------- compare & merge ----------
@app.get("/api/compare/state")
def compare_state():
    if request.args.get("v") == str(comparer.version):
        return jsonify(version=comparer.version, unchanged=True)
    return jsonify(comparer.state())


@app.post("/api/compare/folders")
def compare_folders():
    return jsonify(folders=comparer.set_folders((request.get_json(force=True) or {}).get("folders") or []))


@app.post("/api/compare/start")
def compare_start():
    comparer.start()
    return jsonify(ok=True)


@app.post("/api/compare/cancel")
def compare_cancel():
    comparer.cancel()
    return jsonify(ok=True)


@app.post("/api/compare/keep")
def compare_keep():
    body = request.get_json(force=True) or {}
    try:
        comparer.set_keep(int(body.get("group", -1)), list(body.get("keep") or []))
    except (IndexError, TypeError):
        abort(404)
    return jsonify(ok=True)


@app.post("/api/compare/consolidate")
def compare_consolidate():
    body = request.get_json(force=True) or {}
    return jsonify(comparer.consolidate(str(body.get("mode", "")), body.get("dest")))


@app.post("/api/compare/trash")
def compare_trash():
    return jsonify(comparer.trash())


@app.get("/api/compare/image/<int:fid>")
def compare_image(fid):
    size = {"thumb": 360, "large": 1600}.get(request.args.get("size", "thumb"), 360)
    try:
        data = comparer.image(fid, size)
    except IndexError:
        abort(404)
    except Exception:
        abort(422)
    return data, 200, {"Content-Type": "image/webp" if data[:4] == b"RIFF" else "image/jpeg",
                       "Cache-Control": "private, max-age=600"}


@app.post("/api/compare/reveal")
def compare_reveal():
    body = request.get_json(force=True) or {}
    if "fid" in body:
        try:
            subprocess.run(["open", "-R", comparer.file(int(body["fid"]))["path"]], check=False)
        except (IndexError, ValueError):
            abort(404)
    else:  # only the folder the last consolidation created or filled
        d = comparer.last.get("dest")
        if not d or not Path(d).is_dir():
            abort(404)
        subprocess.run(["open", d], check=False)
    return jsonify(ok=True)


@app.post("/api/quit")
def quit_app():
    RUNFILE.unlink(missing_ok=True)
    threading.Timer(0.3, lambda: os._exit(0)).start()
    return jsonify(ok=True)


# ---------- launch ----------
def _free_port(preferred: int) -> int:
    for port in [preferred, *range(preferred + 1, preferred + 20)]:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise SystemExit("No free port found between %d and %d" % (preferred, preferred + 19))


def _already_running() -> str | None:
    """The URL of a Background Studio already running from this folder, if there is one."""
    try:
        info = json.loads(RUNFILE.read_text("utf-8"))
        os.kill(int(info["pid"]), 0)  # is that process still alive?
        with socket.create_connection(("127.0.0.1", int(info["port"])), timeout=1):
            return str(info["url"])
    except (OSError, ValueError, KeyError, TypeError):
        RUNFILE.unlink(missing_ok=True)
        return None


def main() -> None:
    ap = argparse.ArgumentParser(description="Background Studio (local, offline)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    if not any(models.installed().values()):
        raise SystemExit("No background-removal model is installed yet. Run ./setup.sh first.")

    running = _already_running()
    if running:  # one copy at a time: just show the one that's open
        print(f"\n  Background Studio is already running at {running}. Opening it.\n", flush=True)
        if not args.no_browser:
            webbrowser.open(running)
        return

    port = _free_port(args.port)
    ALLOWED_HOSTS.update({f"127.0.0.1:{port}", f"localhost:{port}"})
    logging.getLogger("werkzeug").setLevel(logging.WARNING)
    server = make_server("127.0.0.1", port, app, threaded=True)
    url = f"http://127.0.0.1:{port}/"
    print(f"\n  Background Studio is running at {url}")
    print("  It only listens on this computer (127.0.0.1); nothing is sent anywhere.")
    print("  Keep this window open while you use the app. Press Ctrl+C here (or 'Quit' in the app) to stop.\n",
          flush=True)
    def _stop(*_):  # started from the launcher, the app is stopped with SIGTERM (e.g. at log-out)
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, _stop)
    RUNFILE.parent.mkdir(parents=True, exist_ok=True)
    RUNFILE.write_text(json.dumps({"pid": os.getpid(), "port": port, "url": url}), "utf-8")
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.")
    finally:
        RUNFILE.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
