# GNOME Spotify Top-Bar Controller, Rotary Knob & Connect Switcher

A native **GNOME Shell 45 / 46 / 47** top-bar controller for Spotify Desktop on Linux (Wayland & X11) that adds:

1. **Analogue Rotary Volume Knob (`St.DrawingArea` + Cairo)** on the top panel — click and drag horizontally left/right (or use the mouse scroll wheel) to sweep Spotify volume from `0%` to `100%`.
2. **One-Click Spotify Connect Speaker Toggle Pill** on the top panel — switch playback between your preferred network speaker (e.g. Sonos, Polk React, Echo, Denon) and your local desktop (`PC`) in a single click.
3. **Song Radio, Artist Discography & Album Track Browser** inside the dropdown card:
   - Search **Songs** and **Albums** simultaneously with full keyboard navigation (`↑` / `↓` / `Enter` / `Esc`) and auto-clearing on play.
   - Selecting a **Song** seeds and starts a 50-track **Spotify Song Radio** session via Spotify's internal `inspiredby-mix` endpoint.
   - Selecting an **Album** drills into its full tracklist (`Play Full Album` or jump straight to any track).
   - Clicking the orange **`Artist:`** link loads all albums by the current artist; clicking the orange **`Album:`** link loads all tracks on the currently playing album.
4. **Verified Wikipedia (`ⓘ`) Buttons for Both Artist and Album** — queries the Wikipedia API when the track changes, lighting up the right-aligned sky-blue `ⓘ` icon if a matching artist/album article exists and greying it out when none exists.
5. **Headless Background Mode (Close to Tray)** — closing the Spotify Desktop window (`×`) unmaps the window while keeping Spotify and the top-bar player running in the background.
6. **Zero External API Keys / OAuth Setup** — bridges directly to your signed-in local Spotify Desktop client (Snap, Flatpak, or native `.deb`) over its local CEF DevTools socket (`127.0.0.1:9229`), bypassing public Web API rate limits (`429`) and Developer Portal app registration.

---

## Quick Start

### Requirements

- Ubuntu 24.04+ / Fedora 40+ / Debian / Arch with **GNOME Shell 45, 46, or 47**
- **Spotify Desktop** installed via Snap (`snap install spotify`), Flatpak (`com.spotify.Client`), or native `.deb` package
- **Node.js 18+** (`node`), `curl`, `unzip`, `python3`, and `x11-utils` (`xlsclients`)

### One-Line Installation

```bash
git clone https://github.com/swiftsuretech/gnome-spotify-topbar.git
cd gnome-spotify-topbar
chmod +x install.sh uninstall.sh
./install.sh
```

---

## Signing In & Configuring Your Speaker (`Settings`)

Because this extension talks directly to your local Spotify Desktop app, you only need to be signed into the Spotify Desktop client once.

Open the **Settings & Login** dialog in any of three ways:
- Click the **gear icon (`⚙`)** at the bottom-right of the top-bar Spotify dropdown menu
- Run `spotify-topbar-settings` from a terminal
- Run `gnome-extensions prefs spotify-search@davewhitehouse`

From the Settings window you can:
1. **Open Spotify / Sign In**: Launches or un-minimises the Spotify Desktop window so you can log into your Spotify account.
2. **Connect / Repair Bridge**: Automatically configures `app.enable-developer-mode=true` and `ui.minimize_to_tray=true` in your Spotify `prefs` (supports Snap, Flatpak, and native installs) and starts the local bridge on `127.0.0.1:9229`.
3. **Select Your Preferred Speaker**: Click **Scan Devices** to list all Spotify Connect speakers discovered on your network/account and click any speaker to bind it to the top-bar toggle pill.
4. **Toggle Wikipedia (`ⓘ`) Buttons** and **Headless Background Mode**.

Configuration is stored in `~/.config/spotify-topbar/config.json`:

```json
{
  "preferredSpeaker": "Polk React",
  "bridgePort": 9229,
  "showWikipedia": true,
  "headlessMode": true
}
```

*(If `preferredSpeaker` is left blank, clicking the top-bar speaker pill automatically toggles between `PC` and the first external Spotify Connect speaker discovered on your network.)*

---

## Command-Line Interface (`spotify-connect-ctl`)

The companion CLI (`~/.local/bin/spotify-connect-ctl`) can also be used standalone or from scripts/keybindings:

```bash
spotify-connect-ctl status                       # JSON status of active & available Connect devices
spotify-connect-ctl toggle                       # Toggle between preferred speaker and local PC
spotify-connect-ctl select "Living Room"         # Transfer playback to a specific Connect device
spotify-connect-ctl volume 0.65                  # Set playback volume (0.0 – 1.0)
spotify-connect-ctl search "Pink Floyd"          # Search tracks & albums via internal GraphQL
spotify-connect-ctl artist-albums "Genesis"      # List full artist discography
spotify-connect-ctl current-album-tracks         # List tracks on the currently playing album
spotify-connect-ctl play-radio <spotify:track:…> # Seed & play 50-track Song Radio
spotify-connect-ctl wiki-lookup "Artist|Album"   # Verify Wikipedia URLs for artist and album
spotify-connect-ctl open-login                   # Show the Spotify Desktop window for login
spotify-connect-ctl setup-bridge                 # Configure Spotify prefs & restart local bridge
```

---

## Architecture

```text
┌───────────────────────────────────────────────────────────────────────────┐
│ GNOME Shell Top Panel (Wayland / X11)                                     │
│  ├─ mediacontrols@cliffniff.github.com (MPRIS track ticker & transport)   │
│  └─ spotify-search@davewhitehouse                                         │
│      ├─ Top Bar: Cairo Rotary Volume Knob + Speaker Toggle Pill           │
│      └─ Popup: Track/Artist/Album links, ⓘ Wikipedia, Search & Tracklist │
└───────────────────────────────┬───────────────────────────────────────────┘
                                │ Gio.Subprocess (JSON)
                                ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ ~/.local/bin/spotify-connect-ctl (Node.js)                                │
│  ├─ Local CEF Bridge (ws://127.0.0.1:9229) -> Spotify Internal Registry   │
│  │   ├─ ConnectAPI / ConnectDevicesAPI (transferPlayback + discovery)     │
│  │   ├─ PlayerAPI / PlaybackAPI / PlaylistAPI                             │
│  │   ├─ GraphQLLoader (searchTracks, searchAlbums, getAlbum, discography) │
│  │   └─ RequestBuilder (/inspiredby-mix/v2/seed_to_playlist)              │
│  └─ Wikipedia MediaWiki API (disambiguated Artist & Album lookup)         │
└───────────────────────────────────────────────────────────────────────────┘
```

## License

MIT © [Swiftsure Tech](https://github.com/swiftsuretech)
