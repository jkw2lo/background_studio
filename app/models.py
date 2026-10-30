"""Which background-removal models the app may use, and where their weights live.

Only models that run entirely on this computer are listed. rembg also ships
cloud backends (e.g. "withoutbg", "atlascloud") that upload images to remote
APIs; those are deliberately absent from this allowlist and are refused even if
requested by name.
"""

from __future__ import annotations

import os
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = ROOT / "models"

# Keep all weights inside the app folder. U2NET_HOME would take precedence over
# REMBG_HOME inside rembg, so make sure it is not set.
os.environ["REMBG_HOME"] = str(MODELS_DIR)
os.environ.pop("U2NET_HOME", None)

DEFAULT_MODEL = "isnet-general-use"

# name -> metadata shown in the UI. Sizes are the download sizes of the .onnx files.
MODELS: dict[str, dict] = {
    "isnet-general-use": {
        "label": "IS-Net General",
        "blurb": "Recommended. Good quality on products, people and objects.",
        "size_mb": 179,
        "license": "Apache-2.0",
    },
    "birefnet-general-lite": {
        "label": "BiRefNet Lite",
        "blurb": "Sharper edges and fine detail. About 2-3x slower.",
        "size_mb": 224,
        "license": "MIT",
    },
    "birefnet-general": {
        "label": "BiRefNet (best quality)",
        "blurb": "Highest quality, especially hair and fine detail. Slow on CPU.",
        "size_mb": 973,
        "license": "MIT",
    },
    "u2net": {
        "label": "U²-Net (classic)",
        "blurb": "The original rembg model. Fast and dependable.",
        "size_mb": 176,
        "license": "Apache-2.0",
    },
}


def _session_class(name: str):
    if name not in MODELS:
        raise ValueError(f"Unknown or non-local model: {name!r}")
    from rembg.sessions import sessions

    cls = sessions[name]
    if not cls.is_local():  # belt and braces: never allow a remote backend
        raise ValueError(f"Model {name!r} is not a local model")
    return cls


def model_path(name: str) -> str | None:
    """Path of the downloaded weights, or None if they are not installed."""
    return _session_class(name).resolve_existing(f"{name}.onnx")


def installed() -> dict[str, bool]:
    return {name: model_path(name) is not None for name in MODELS}


def describe() -> list[dict]:
    status = installed()
    return [{"name": n, "installed": status[n], **meta} for n, meta in MODELS.items()]


_sessions: dict[str, object] = {}
_sessions_lock = threading.Lock()


def get_session(name: str):
    """Load a model for inference. Never downloads: missing weights are an error.

    Execution providers are pinned to the CPU. onnxruntime also ships an
    "AzureExecutionProvider" (remote inference), which is never requested, and a
    CoreML provider, which was ~4x faster for IS-Net in testing but hung while
    compiling BiRefNet and calls into macOS analytics, so it is not used.
    """
    if model_path(name) is None:
        raise RuntimeError(
            f"The model '{name}' is not installed. Quit the app and run "
            f"./setup.sh --model {name} (this needs an internet connection once)."
        )
    with _sessions_lock:
        if name not in _sessions:
            from rembg import new_session

            _sessions[name] = new_session(name, providers=["CPUExecutionProvider"])
        return _sessions[name]


def disable_downloads() -> None:
    """Make any accidental model download fail loudly instead of reaching the network."""
    import pooch

    def _refuse(*_args, **_kwargs):
        raise RuntimeError("Model downloads are disabled while the app is running. Use ./setup.sh.")

    pooch.retrieve = _refuse
    # rembg's session modules did `import pooch`, so patching the module attribute covers them.


def download(name: str) -> str:
    """Download weights for one model (used by setup.sh only). Checksums are verified by rembg."""
    cls = _session_class(name)
    path = cls.download_models()
    return str(path)


if __name__ == "__main__":
    # Usage: python -m app.models download <name> [<name> ...] | list
    args = sys.argv[1:]
    if not args or args[0] == "list":
        for m in describe():
            mark = "installed" if m["installed"] else "not installed"
            print(f"  {m['name']:<24} {m['size_mb']:>4} MB  {mark:<14} {m['label']}")
        sys.exit(0)
    if args[0] == "download":
        for name in args[1:] or [DEFAULT_MODEL]:
            if name not in MODELS:
                print(f"Unknown model {name!r}. Choose from: {', '.join(MODELS)}")
                sys.exit(2)
            if model_path(name):
                print(f"  {name}: already installed")
                continue
            print(f"  Downloading {name} (~{MODELS[name]['size_mb']} MB) from github.com/danielgatis/rembg releases ...", flush=True)
            print(f"  saved to {download(name)} (checksum verified)")
        sys.exit(0)
    print(__doc__)
    sys.exit(2)
