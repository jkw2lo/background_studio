"""Build the lite demo: the app's real interface (app/static) plus the stand-in server.

    python3 lite/build.py [OUT]       (default: lite/_site)

Copies the UI as it is and makes only the few changes a static page needs (relative
paths, no Python server for images); each change must match exactly, so if the UI moves
on, the build fails loudly instead of shipping a broken demo. Needs only Python 3.
"""

from __future__ import annotations

import re
import shutil
import sys
from pathlib import Path

LITE = Path(__file__).resolve().parent
STATIC = LITE.parent / "app" / "static"


def patch(text: str, pattern: str, repl: str, count: int, what: str, regex: bool = False) -> str:
    n = len(re.findall(pattern, text)) if regex else text.count(pattern)
    if n != count:
        sys.exit(f"build: expected {count} × {what}, found {n}. Update lite/build.py for the new UI.")
    return re.sub(pattern, repl, text) if regex else text.replace(pattern, repl)


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else LITE / "_site"
    if out.exists():
        shutil.rmtree(out)
    (out / "static").mkdir(parents=True)

    html = (STATIC / "index.html").read_text()
    html = patch(html, 'content="__TOKEN__"', 'content="lite"', 1, "token meta")
    html = patch(html, '"/static/', '"static/', 5, "static paths")
    html = patch(html, 'href="/tag"', 'href="#tag"', 2, "Sort & tag links")
    html = patch(html, 'href="/compare"', 'href="#compare"', 1, "Compare link")
    html = patch(html, 'href="/"', 'href="./"', 1, "home tab")
    html = patch(html, '<link rel="stylesheet" href="static/style.css">',
                 '<link rel="stylesheet" href="static/style.css">\n  <link rel="stylesheet" href="static/lite.css">', 1, "stylesheet")
    html = patch(html, '<script src="static/app.js"></script>',
                 '<script src="static/lite-engine.js"></script>\n  <script src="static/lite.js"></script>\n'
                 '  <script src="static/app.js"></script>', 1, "scripts")
    html = patch(html, "<title>Background Studio</title>",
                 '<title>Background Studio · Lite demo</title>\n  <meta name="description" content="Try Background '
                 'Studio\'s interface in your browser on sample pictures. The full app removes backgrounds offline on your Mac.">',
                 1, "title")
    (out / "index.html").write_text(html)

    app = (STATIC / "app.js").read_text()
    app = patch(app, r"const imgUrl = \(id, kind, extra = \"\"\) => `/api/image/[^`]*`;",
                'const imgUrl = (id, kind, extra = "") => LITE.imgUrl(id, kind, extra);', 1, "imgUrl", regex=True)
    (out / "static" / "app.js").write_text(app)

    editor = (STATIC / "editor.js").read_text()
    editor = patch(editor, r"`/api/full/\$\{([^}]+)\}\?t=\$\{encodeURIComponent\(TOKEN\)\}&v=\$\{[^}]+\}`",
                   r"LITE.fullUrl(\1)", 2, "full-size URLs", regex=True)
    editor = patch(editor, r"`/api/edits/\$\{it\.id\}\?t=\$\{encodeURIComponent\(TOKEN\)\}&v=\$\{it\.finished_at\}`",
                   "LITE.editsUrl(it.id)", 1, "touch-up URL", regex=True)
    (out / "static" / "editor.js").write_text(editor)

    for name in ("style.css", "icon.svg"):
        shutil.copy(STATIC / name, out / "static" / name)
    for name in ("lite.js", "lite-engine.js", "lite.css"):
        shutil.copy(LITE / name, out / "static" / name)
    shutil.copytree(LITE / "demo", out / "demo")
    shutil.copytree(LITE.parent / "overview", out / "overview")  # read by the launchpad's showcase
    (out / ".nojekyll").write_text("")
    print(f"Built the lite demo in {out}")


if __name__ == "__main__":
    main()
