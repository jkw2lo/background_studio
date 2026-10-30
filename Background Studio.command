#!/bin/bash
# Double-click this file in Finder to start Background Studio.
# A Terminal window opens and stays open while the app runs; close it (or click Quit in the app) to stop.
cd "$(dirname "$0")"
if [[ ! -x .venv/bin/python ]]; then
  echo "First-time setup is needed (one-time, uses the internet)."
  ./setup.sh
fi
exec ./start.sh
