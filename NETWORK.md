# Network activity

Background Studio uses the internet **only during `./setup.sh`**, to download software and model
weights. The app itself makes **no** network connections. Your images are never uploaded anywhere.

## During setup (one time)

| # | What | From | Size | Integrity check |
|---|------|------|------|-----------------|
| 1 | `uv` 0.13.5 (Python package manager, single binary) | `github.com/astral-sh/uv/releases` | ~17 MB | SHA-256 pinned in `setup.sh` |
| 2 | Python 3.12 (standalone build used only by this app) | `github.com/astral-sh/python-build-standalone/releases` (fetched by uv) | ~20 MB download | verified by uv |
| 3 | Python libraries: rembg, onnxruntime, Pillow, numpy, scipy, scikit-image, pymatting, Flask, pillow-heif and their dependencies (44 packages) | `pypi.org` / `files.pythonhosted.org` | ~150 MB | exact versions **and SHA-256 hashes** pinned in `requirements.lock` (`--require-hashes`) |
| 4 | Model weights (default: `isnet-general-use.onnx`) | `github.com/danielgatis/rembg/releases/download/v0.0.0/` | 179 MB (others: see README) | MD5 checksum verified by rembg |
| 5 | Sort & tag auto-suggest model: OpenAI CLIP ViT-B/16 (MIT), quantized ONNX image + text models and tokenizer. Skip with `--no-autosuggest` | `huggingface.co/Xenova/clip-vit-base-patch16`, pinned to revision `342fdf2f` | ~152 MB | SHA-256 of each file pinned in `app/autotag.py` |

What these servers can see is the same as for any software download: your IP address and a user-agent
string (tool version, macOS version, Python version). PyPI records anonymous download counts per
package. No account, token or personal data is sent, and **no images**.

Setup does **not** use Homebrew, does not modify your shell profile, and writes nothing outside the
app folder (`UV_CACHE_DIR`, `UV_PYTHON_INSTALL_DIR` and `REMBG_HOME` all point inside it; the CLIP files go to
`models/clip-vit-base-patch16/`).

Running `./setup.sh --model <name>` later downloads one more model from the same rembg release page.

## While the app runs: none

* **Server is local-only.** It binds to `127.0.0.1` (loopback), so other computers on your network
  cannot reach it. It also rejects requests whose `Host` header isn't `127.0.0.1`/`localhost`
  (stops DNS-rebinding tricks), and every API call needs a random token created at launch (stops
  other websites open in your browser from talking to it).
* **The page can't contact anything else.** Its Content-Security-Policy is
  `default-src 'none'; connect-src 'self'; img-src 'self' blob: data:; ...`: no external
  scripts, fonts, analytics, CDNs or fetches. Everything is served from the app folder.
* **Network guard.** On start-up the app patches Python's socket layer so any attempt by any Python
  library to look up a hostname or connect anywhere other than loopback raises an error and is
  counted. The green "Offline" badge in the top bar shows the count (it should always be 0).
  `setup.sh` runs a self-test that proves outbound connections are blocked.
* **No model downloads at runtime.** rembg would normally download a missing model on first use; the
  app disables that (`pooch.retrieve` is replaced) and only loads weights already on disk. The
  auto-suggest model is only ever loaded from `models/`; if it's missing, the app says to run setup.
* **No remote inference.** rembg 2.0.86 also includes two *cloud* backends (`withoutbg`,
  `atlascloud`) that upload images to paid APIs. They are not in the app's model allowlist, and the
  app double-checks each model reports `is_local()`. onnxruntime ships an `AzureExecutionProvider`
  (remote inference); the app pins providers explicitly to `CPUExecutionProvider` and never
  requests it.
* **No telemetry.** Flask, rembg, Pillow and numpy have none. onnxruntime's telemetry exists only
  in Windows builds. The app has no analytics, crash reporting or update checks.

Things the app does locally that are worth knowing about:

* "Add files…", "Add folder…" and "Change…" run `osascript` to show the standard macOS
  file dialog. "Show in Finder" and "Open folder" run `open`. Neither touches the network.
* Compare & merge only reads the folders you pick, and writes only when you consolidate (copies) or
  confirm moving leftover copies to the Trash (a local move into `~/.Trash`). No network.
* `Background Studio.app` (built by `make-launcher.sh`) is a short shell script. It checks whether the
  app is already running by asking `127.0.0.1` (this computer) with `curl`, then starts `start.sh`
  or opens the page. It uses no network.
* Sort & tag's "Add as Finder tags" writes the `com.apple.metadata:_kMDItemUserTags` extended
  attribute on the files directly (a local file-system call, no helper program, no network).
* Opening the app runs `open http://127.0.0.1:8765/` to show the page in your default browser.

## Check it yourself

* Turn off Wi-Fi after setup and use the app normally. Everything works.
* While the app is running: `lsof -nP -i | grep -i python` shows only
  `TCP 127.0.0.1:8765 (LISTEN)` plus connections from your browser to that address.
* Use an outbound firewall such as LuLu or Little Snitch: the app's Python process makes no
  outbound connections.

Your web browser is separate software and may make its own connections (updates, safe-browsing
lists). The Background Studio page itself only talks to `127.0.0.1`.
