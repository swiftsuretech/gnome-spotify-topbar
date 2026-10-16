#!/usr/bin/env bash
set -euo pipefail

EXT_UUID="spotify-search@davewhitehouse"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"
BIN_DIR="$HOME/.local/bin"

echo "==> Disabling $EXT_UUID..."
gnome-extensions disable "$EXT_UUID" 2>/dev/null || true

echo "==> Removing extension files..."
rm -f "$EXT_DIR/metadata.json" "$EXT_DIR/extension.js" "$EXT_DIR/ui.js" "$EXT_DIR/prefs.js" "$EXT_DIR/ui-file.txt"
rmdir "$EXT_DIR" 2>/dev/null || true

echo "==> Removing CLI utilities..."
rm -f "$BIN_DIR/spotify-connect-ctl" "$BIN_DIR/spotify-topbar-settings"

echo "Uninstalled $EXT_UUID."
