import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const CTL_PATH = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'spotify-connect-ctl']);

function runCtlSync(args) {
    try {
        const [ok, stdout, stderr, status] = GLib.spawn_command_line_sync(
            [CTL_PATH, ...args].map(a => GLib.shell_quote(a)).join(' ')
        );
        if (!ok || status !== 0) {
            const dec = new TextDecoder();
            return { error: dec.decode(stderr || new Uint8Array()) || `Exit ${status}` };
        }
        const dec = new TextDecoder();
        const outStr = dec.decode(stdout || new Uint8Array()).trim();
        return outStr ? JSON.parse(outStr) : {};
    } catch (e) {
        return { error: e.message || String(e) };
    }
}

export default class SpotifyTopBarPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const page = new Adw.PreferencesPage();
        window.add(page);

        const accountGroup = new Adw.PreferencesGroup({
            title: 'Spotify Account & Local Bridge',
            description: 'Reuses your signed-in Spotify Desktop session over its local CEF bridge (no external OAuth client ID needed).',
        });
        page.add(accountGroup);

        const statusRow = new Adw.ActionRow({
            title: 'Account & Bridge Status',
            subtitle: 'Checking status…',
        });
        accountGroup.add(statusRow);

        const loginRow = new Adw.ActionRow({
            title: 'Spotify Desktop Window & Login',
            subtitle: 'Open the Spotify app window to sign in to your account or view the full client.',
        });
        const openSpotifyBtn = new Gtk.Button({
            label: 'Open Spotify / Sign In',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        loginRow.add_suffix(openSpotifyBtn);
        accountGroup.add(loginRow);

        const bridgeRow = new Adw.ActionRow({
            title: 'Local CEF Developer Bridge',
            subtitle: 'Automatically configure Spotify prefs and connect on localhost.',
        });
        const setupBridgeBtn = new Gtk.Button({
            label: 'Connect / Repair Bridge',
            valign: Gtk.Align.CENTER,
        });
        bridgeRow.add_suffix(setupBridgeBtn);
        accountGroup.add(bridgeRow);

        const speakerGroup = new Adw.PreferencesGroup({
            title: 'Top-Bar Speaker Toggle',
            description: 'Choose which Spotify Connect speaker the top-bar pill switches between (Speaker ↔ PC).',
        });
        page.add(speakerGroup);

        const speakerEntryRow = new Adw.EntryRow({
            title: 'Preferred Speaker Name',
        });
        speakerGroup.add(speakerEntryRow);

        const discoveredRow = new Adw.ActionRow({
            title: 'Discovered Spotify Connect Speakers',
            subtitle: 'Click a discovered device below to set it as your top-bar toggle speaker.',
        });
        const refreshDevsBtn = new Gtk.Button({
            label: 'Scan Devices',
            valign: Gtk.Align.CENTER,
        });
        discoveredRow.add_suffix(refreshDevsBtn);
        speakerGroup.add(discoveredRow);

        const devicesBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            margin_top: 6,
            margin_bottom: 6,
        });
        const devicesRow = new Adw.ActionRow({
            title: 'Available on Network',
        });
        devicesRow.add_suffix(devicesBox);
        speakerGroup.add(devicesRow);

        const uiGroup = new Adw.PreferencesGroup({
            title: 'Popup & Background Behaviour',
        });
        page.add(uiGroup);

        const wikiSwitchRow = new Adw.SwitchRow({
            title: 'Show Wikipedia (ⓘ) Buttons',
            subtitle: 'Display right-aligned Wikipedia buttons for Artist and Album when an article exists.',
        });
        uiGroup.add(wikiSwitchRow);

        const headlessSwitchRow = new Adw.SwitchRow({
            title: 'Headless Background Mode (Close to Tray)',
            subtitle: 'Keep the top-bar player alive when closing the Spotify Desktop window.',
        });
        uiGroup.add(headlessSwitchRow);

        const portEntryRow = new Adw.EntryRow({
            title: 'CEF Remote Debugging Port',
        });
        uiGroup.add(portEntryRow);

        let isRefreshing = false;

        function saveCurrentSettings() {
            if (isRefreshing) return;
            const payload = {
                preferredSpeaker: (speakerEntryRow.get_text() || '').trim(),
                showWikipedia: wikiSwitchRow.get_active(),
                headlessMode: headlessSwitchRow.get_active(),
                bridgePort: parseInt(portEntryRow.get_text() || '9229', 10) || 9229,
            };
            runCtlSync(['set-config', JSON.stringify(payload)]);
        }

        function refreshDevicesList() {
            let child = devicesBox.get_first_child();
            while (child) {
                const next = child.get_next_sibling();
                devicesBox.remove(child);
                child = next;
            }
            const st = runCtlSync(['discover']);
            const devs = (st.devices || []).filter(d => !d.isLocal);
            if (devs.length === 0) {
                const lbl = new Gtk.Label({
                    label: st.error ? 'Bridge offline' : 'No external speakers found',
                });
                devicesBox.append(lbl);
                return;
            }
            for (const d of devs) {
                const btn = new Gtk.Button({
                    label: d.name,
                    valign: Gtk.Align.CENTER,
                });
                btn.connect('clicked', () => {
                    speakerEntryRow.set_text(d.name);
                    saveCurrentSettings();
                });
                devicesBox.append(btn);
            }
        }

        function refreshState() {
            isRefreshing = true;
            const info = runCtlSync(['get-config']);
            const cfg = info.config || {};
            const accounts = info.userAccounts || [];
            const acctStr = info.loggedIn
                ? `Signed in (${accounts.join(', ')})`
                : 'Not signed in — click "Open Spotify / Sign In" below';
            const bridgeStr = info.bridgeConnected
                ? `Bridge connected (${info.installType || 'local'})`
                : `Bridge disconnected (${info.installType || 'local'})`;
            statusRow.set_subtitle(`${acctStr}  •  ${bridgeStr}`);

            speakerEntryRow.set_text(cfg.preferredSpeaker || '');
            wikiSwitchRow.set_active(cfg.showWikipedia !== false);
            headlessSwitchRow.set_active(cfg.headlessMode !== false);
            portEntryRow.set_text(String(cfg.bridgePort || 9229));
            isRefreshing = false;
        }

        openSpotifyBtn.connect('clicked', () => {
            runCtlSync(['open-login']);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                refreshState();
                return GLib.SOURCE_REMOVE;
            });
        });

        setupBridgeBtn.connect('clicked', () => {
            statusRow.set_subtitle('Configuring Spotify prefs and starting bridge…');
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                runCtlSync(['setup-bridge']);
                refreshState();
                refreshDevicesList();
                return GLib.SOURCE_REMOVE;
            });
        });

        refreshDevsBtn.connect('clicked', () => {
            refreshDevicesList();
        });

        speakerEntryRow.connect('changed', saveCurrentSettings);
        wikiSwitchRow.connect('notify::active', saveCurrentSettings);
        headlessSwitchRow.connect('notify::active', saveCurrentSettings);
        portEntryRow.connect('changed', saveCurrentSettings);

        refreshState();
        refreshDevicesList();
    }
}
