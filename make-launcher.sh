#!/bin/bash
# Builds "Background Studio.app" in this folder: a one-click launcher you can keep in the Dock.
#
#   ./make-launcher.sh          (setup.sh runs this for you; run it again if you move this folder)
#
# Clicking the app starts Background Studio quietly in the background (no Terminal window) and
# opens it in your browser, or, if it's already running, just opens it again. Stop it with Quit in
# the app. The launcher is a tiny shell script; it uses no network and changes nothing outside
# this folder.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"
APP="$ROOT/Background Studio.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp launcher/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Background Studio</string>
  <key>CFBundleDisplayName</key><string>Background Studio</string>
  <key>CFBundleIdentifier</key><string>local.background-studio.launcher</string>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

# Bake in this folder's location, so the app still works if you drag it to Applications.
ROOT_ESCAPED=$(printf '%s' "$ROOT" | sed 's/[\\"$`]/\\&/g')
cat > "$APP/Contents/MacOS/launch" <<SCRIPT
#!/bin/bash
# Background Studio launcher: show the app if it's running, otherwise start it in the background.
ROOT="$ROOT_ESCAPED"
SCRIPT
cat >> "$APP/Contents/MacOS/launch" <<'SCRIPT'
if [[ ! -d "$ROOT/app" ]]; then  # folder moved: try the one this app sits in
  ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
fi
if [[ ! -d "$ROOT/app" ]]; then
  osascript -e 'display alert "Background Studio" message "Couldn’t find the Background Studio folder. Open the folder and run make-launcher.sh again."'
  exit 1
fi

# Already running? Just open it.
RUN="$ROOT/data/server.json"
if [[ -f "$RUN" ]]; then
  URL=$(sed -n 's/.*"url": *"\([^"]*\)".*/\1/p' "$RUN")
  if [[ -n "$URL" ]] && /usr/bin/curl -s -o /dev/null --max-time 2 "$URL"; then
    open "$URL"
    exit 0
  fi
fi

# First time: setup needs a Terminal window (it downloads things once and shows progress).
if [[ ! -x "$ROOT/.venv/bin/python" ]]; then
  open -a Terminal "$ROOT/Background Studio.command"
  exit 0
fi

# Start quietly; the app opens the browser itself once it's ready.
mkdir -p "$ROOT/data"
LOG="$ROOT/data/server.log"
if [[ -f "$LOG" && $(stat -f%z "$LOG") -gt 5000000 ]]; then : > "$LOG"; fi
cd "$ROOT"
nohup ./start.sh "$@" >> "$LOG" 2>&1 < /dev/null &
disown
SCRIPT
chmod +x "$APP/Contents/MacOS/launch"
touch "$APP"  # make Finder pick up the icon

echo "  Created: $APP"
echo "  Drag it to your Dock (or Applications) to start Background Studio with one click."
