#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."

uuid=$(python3 -c 'import json; print(json.load(open("metadata.json"))["uuid"])')
target="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid"

rm -rf "$target"
mkdir -p "$target"
cp -r metadata.json prefs.js stylesheet.css schemas "$target"/
glib-compile-schemas "$target/schemas"
SOURCE_DIR="$PWD" python3 -c '
import os, sys
template = open("tools/hotReload.js").read()
open(sys.argv[1], "w").write(template.replace("@SOURCE_DIR@", os.environ["SOURCE_DIR"]))
' "$target/extension.js"

echo "Installed the hot reloading build to $target"
echo "Log out and back in once to load it. After that, saving a file in lib/ or"
echo "stylesheet.css reloads the dock. Follow it with:"
echo "  journalctl --user -f -g GlideDock"
echo "prefs.js, schemas and metadata.json need this script again."
echo "./build.sh --install puts the normal build back."
