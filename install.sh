#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_UUID="spotify-search@davewhitehouse"
MC_UUID="mediacontrols@cliffniff.github.com"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"
MC_DIR="$HOME/.local/share/gnome-shell/extensions/$MC_UUID"
BIN_DIR="$HOME/.local/bin"

echo "==> Installing CLI utilities to $BIN_DIR..."
mkdir -p "$BIN_DIR"
cp "$REPO_DIR/bin/spotify-connect-ctl" "$BIN_DIR/spotify-connect-ctl"
cp "$REPO_DIR/bin/spotify-topbar-settings" "$BIN_DIR/spotify-topbar-settings"
chmod +x "$BIN_DIR/spotify-connect-ctl" "$BIN_DIR/spotify-topbar-settings"

if [ ! -d "$MC_DIR" ]; then
    echo "==> Installing base Media Controls extension ($MC_UUID v2.4.4)..."
    mkdir -p "$MC_DIR"
    TMP_ZIP="$(mktemp --suffix=.zip)"
    curl -fsSL "https://github.com/sakithb/media-controls/releases/download/v2.4.4/$MC_UUID.shell-extension.zip" -o "$TMP_ZIP"
    unzip -qo "$TMP_ZIP" -d "$MC_DIR"
    rm -f "$TMP_ZIP"
    if [ -d "$MC_DIR/schemas" ]; then
        glib-compile-schemas "$MC_DIR/schemas"
    fi
fi

echo "==> Configuring Media Controls GSettings for Spotify..."
SCHEMA_DIR="$MC_DIR/schemas"
if [ -d "$SCHEMA_DIR" ]; then
    gsettings --schemadir "$SCHEMA_DIR" set org.gnome.shell.extensions.mediacontrols blacklisted-players "['Chrome', 'google-chrome.desktop', 'Brave', 'brave-browser.desktop', 'chromium', 'firefox', 'firefox.desktop']" || true
    gsettings --schemadir "$SCHEMA_DIR" set org.gnome.shell.extensions.mediacontrols label-width 320 || true
    gsettings --schemadir "$SCHEMA_DIR" set org.gnome.shell.extensions.mediacontrols show-control-icons-seek-backward false || true
    gsettings --schemadir "$SCHEMA_DIR" set org.gnome.shell.extensions.mediacontrols show-control-icons-seek-forward false || true
fi

echo "==> Installing $EXT_UUID to $EXT_DIR..."
mkdir -p "$EXT_DIR"
cp "$REPO_DIR/extension/metadata.json" "$EXT_DIR/metadata.json"
cp "$REPO_DIR/extension/extension.js" "$EXT_DIR/extension.js"
cp "$REPO_DIR/extension/ui.js" "$EXT_DIR/ui.js"
cp "$REPO_DIR/extension/prefs.js" "$EXT_DIR/prefs.js"
printf "ui.js\n" > "$EXT_DIR/ui-file.txt"

echo "==> Configuring Spotify Desktop local CEF bridge..."
"$BIN_DIR/spotify-connect-ctl" setup-bridge >/dev/null 2>&1 || true

echo "==> Enabling GNOME Shell extensions..."
gnome-extensions enable "$MC_UUID" 2>/dev/null || true
gnome-extensions disable "$EXT_UUID" 2>/dev/null || true
sleep 0.3
gnome-extensions enable "$EXT_UUID" 2>/dev/null || true

echo ""
echo "Installation complete!"
echo "  • Open Settings / Sign-In UI anytime:  $BIN_DIR/spotify-topbar-settings"
echo "  • Or click the gear icon (⚙) inside the top-bar Spotify dropdown."
