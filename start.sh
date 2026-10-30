#!/bin/bash
# Start Background Studio. Works offline. Opens http://127.0.0.1:8765 in your browser.
cd "$(dirname "$0")"
if [[ ! -x .venv/bin/python ]]; then
  echo "Background Studio isn't set up yet. Run ./setup.sh first (needs internet once)."
  exit 1
fi
export REMBG_HOME="$(pwd)/models"
unset U2NET_HOME
# Belt and braces: tell common libraries to stay offline too.
export HF_HUB_OFFLINE=1 PIP_NO_INDEX=1 NO_PROXY="127.0.0.1,localhost"
exec .venv/bin/python -m app.server "$@"
