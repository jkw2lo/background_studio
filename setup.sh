#!/bin/bash
# Background Studio - one-time setup. This is the ONLY step that uses the internet.
#
#   ./setup.sh                         install with the default model (IS-Net, ~179 MB)
#   ./setup.sh --model birefnet-general-lite   also install an extra model (repeatable)
#   ./setup.sh --all-models            install every supported model (~1.6 GB)
#   ./setup.sh --no-autosuggest        skip the Sort & tag auto-suggest model (CLIP, ~152 MB)
#   ./setup.sh --yes                   don't ask for confirmation
#
# Everything is installed inside this folder. To uninstall, delete the folder.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"

UV_VERSION="0.13.5"
UV_SHA_ARM64="743f85035a1996ecb350659e01cd9faea9709829be09b1b4b03c73eaf3c9cd73"
UV_SHA_X86="b0f52b0e3945b4107d89024ea38e625683011fbfc05a0d98f9fa2d6dcee28c66"
PY_VERSION="3.12"

MODELS=("isnet-general-use")
ASSUME_YES=0
AUTOSUGGEST=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) MODELS+=("$2"); shift 2 ;;
    --all-models) MODELS=("isnet-general-use" "birefnet-general-lite" "birefnet-general" "u2net"); shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --no-autosuggest) AUTOSUGGEST=0; shift ;;
    -h|--help) sed -n 2,10p "$0"; exit 0 ;;
    *) echo "Unknown option: $1"; exit 2 ;;
  esac
done

# Keep every tool, cache and download inside this folder (nothing in ~/Library, ~/.cache, etc.).
export UV_CACHE_DIR="$ROOT/.tools/uv-cache"
export UV_PYTHON_INSTALL_DIR="$ROOT/.tools/python"
export UV_NO_MODIFY_PATH=1
export UV_PYTHON_PREFERENCE=only-managed   # use a private Python, never touch the system one
mkdir -p "$ROOT/.tools"

bold() { printf "\033[1m%s\033[0m\n" "$*"; }

bold "Background Studio setup"
AUTO_LINE=""
if [[ $AUTOSUGGEST == 1 ]]; then
  AUTO_LINE="  5. Sort & tag auto-suggest model (CLIP, ~152 MB) from huggingface.co (SHA-256 verified)"
fi
cat <<EOF

This one-time setup downloads the following. After it finishes, the app runs
fully offline and never contacts the internet.

  1. uv $UV_VERSION package manager (~17 MB)      from github.com/astral-sh/uv (SHA-256 verified)
  2. Python $PY_VERSION (~20 MB)                      from github.com/astral-sh/python-build-standalone
  3. Python libraries (~150 MB)               from pypi.org (exact versions + hashes in requirements.lock)
  4. Model weights: ${MODELS[*]}
                                              from github.com/danielgatis/rembg/releases (checksum verified)
$AUTO_LINE

Everything goes into: $ROOT
No accounts, no analytics, no images are uploaded. Details: NETWORK.md

EOF
if [[ $ASSUME_YES -eq 0 ]]; then
  read -r -p "Continue? [Y/n] " ans
  [[ -z "$ans" || "$ans" =~ ^[Yy] ]] || { echo "Cancelled."; exit 1; }
fi

# 1. uv - a pinned release, verified against the checksum above.
UV="$ROOT/.tools/bin/uv"
if [[ ! -x "$UV" ]] || [[ "$("$UV" --version 2>/dev/null)" != "uv $UV_VERSION"* ]]; then
  bold "[1/4] Downloading uv $UV_VERSION"
  case "$(uname -m)" in
    arm64)  TRIPLE="aarch64-apple-darwin"; SHA="$UV_SHA_ARM64" ;;
    x86_64) TRIPLE="x86_64-apple-darwin";  SHA="$UV_SHA_X86" ;;
    *) echo "Unsupported CPU: $(uname -m)"; exit 1 ;;
  esac
  TMP="$(mktemp -d)"
  curl -fL --progress-bar -o "$TMP/uv.tar.gz" \
    "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-$TRIPLE.tar.gz"
  echo "$SHA  $TMP/uv.tar.gz" | shasum -a 256 -c - >/dev/null || { echo "Checksum mismatch for uv - aborting."; exit 1; }
  tar -xzf "$TMP/uv.tar.gz" -C "$TMP"
  mkdir -p "$ROOT/.tools/bin"
  mv "$TMP/uv-$TRIPLE/uv" "$UV"
  rm -rf "$TMP"
else
  bold "[1/4] uv $UV_VERSION already installed"
fi

# 2. Private Python + virtual environment.
bold "[2/4] Setting up Python $PY_VERSION"
# A venv records absolute paths, so it breaks if this folder is moved; rebuild it then.
if ! "$ROOT/.venv/bin/python" -c "" 2>/dev/null; then
  rm -rf "$ROOT/.venv"
  "$UV" venv --quiet --python "$PY_VERSION" "$ROOT/.venv"
fi

# 3. Libraries, exactly as pinned (with hashes) in requirements.lock.
bold "[3/4] Installing libraries (rembg, onnxruntime, Pillow, Flask, ...)"
VIRTUAL_ENV="$ROOT/.venv" "$UV" pip sync --quiet --require-hashes requirements.lock

# 4. Model weights.
bold "[4/4] Downloading model weights"
export REMBG_HOME="$ROOT/models"
unset U2NET_HOME
"$ROOT/.venv/bin/python" -m app.models download "${MODELS[@]}"
if [[ $AUTOSUGGEST == 1 ]]; then
  echo "  Sort & tag auto-suggest model (CLIP ViT-B/16, ~152 MB, from huggingface.co):"
  "$ROOT/.venv/bin/python" -m app.autotag download
fi

"$UV" cache clean --quiet 2>/dev/null || true   # downloaded wheels are no longer needed (~400 MB)
chmod +x "$ROOT/Background Studio.command" "$ROOT/setup.sh" 2>/dev/null || true

bold "Checking that everything works offline ..."
"$ROOT/.venv/bin/python" -m app.selftest

"$ROOT/make-launcher.sh" >/dev/null 2>&1 || true   # the one-click Background Studio.app

echo
bold "Setup complete."
echo "Start the app by double-clicking 'Background Studio.app' in this folder (drag it to your Dock"
echo "for one-click access), or run:  ./start.sh"
