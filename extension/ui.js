import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const CTL_PATH = GLib.build_filenamev([
    GLib.get_home_dir(),
    '.local',
    'bin',
    'spotify-connect-ctl',
]);
const SETTINGS_APP_PATH = GLib.build_filenamev([
    GLib.get_home_dir(),
    '.local',
    'bin',
    'spotify-topbar-settings',
]);

const POLL_INTERVAL_SECONDS = 4;
const DRAG_PIXELS_FULL_SWEEP = 140; // px left/right for 0% -> 100%
const POPUP_BOX_WIDTH = 344;
const STANDARD_MENU_WIDTH = 320;
const ROW_TEXT_WIDTH = 236;
const ALBUM_ART_SIZE = 260;
const INFO_ICON_PATH = '/usr/share/icons/Yaru/scalable/status/info-symbolic.svg';

function formatDuration(ms) {
    if (!ms || ms <= 0)
        return '';
    const totalSec = Math.round(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}:${sec < 10 ? '0' : ''}${sec}`;
}

function bindReliableClick(actor, onClick) {
    actor.reactive = true;
    actor.can_focus = true;
    actor.track_hover = true;
    let lastTriggerMs = 0;
    const trigger = () => {
        const now = GLib.get_monotonic_time() / 1000;
        if (now - lastTriggerMs < 220)
            return;
        lastTriggerMs = now;
        onClick();
    };

    if (typeof Clutter.ClickGesture !== 'undefined') {
        const clickGesture = new Clutter.ClickGesture();
        clickGesture.set_n_clicks_required(1);
        if (clickGesture.set_recognize_on_press)
            clickGesture.set_recognize_on_press(true);
        clickGesture.connect('recognize', () => {
            trigger();
            return Clutter.EVENT_STOP;
        });
        actor.add_action(clickGesture);
    } else if (typeof Clutter.ClickAction !== 'undefined') {
        const clickAction = new Clutter.ClickAction();
        clickAction.connect('clicked', () => {
            trigger();
        });
        actor.add_action(clickAction);
    }

    actor.connect('button-press-event', (_a, event) => {
        if (event.get_button() === Clutter.BUTTON_PRIMARY) {
            trigger();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    });
}

export class SpotifySpeakerController {
    enable() {
        this._enabled = true;
        this._busy = false;
        this._statusInFlight = false;
        this._dragging = false;
        this._dragGrab = null;
        this._dragStartX = 0;
        this._dragStartVol = 0.5;
        this._volume = 0.5;
        this._lastVolSendMs = 0;
        this._volFlushTimeoutId = null;
        this._searchDebounceId = null;
        this._focusTimeoutId = null;
        this._searchSeq = 0;
        this._lastItems = [];
        this._resultRows = [];
        this._selectedIndex = 0;
        this._lastState = null;

        this._attachedBtn = null;
        this._customLabelsBox = null;
        this._titleLabel = null;
        this._linksRow = null;
        this._artistLinkBtn = null;
        this._artistLinkLabel = null;
        this._artistWikiBtn = null;
        this._artistWikiIcon = null;
        this._artistWikiUrl = null;
        this._albumLinkBtn = null;
        this._albumLinkLabel = null;
        this._albumWikiBtn = null;
        this._albumWikiIcon = null;
        this._albumWikiUrl = null;
        this._lastWikiKey = '';
        this._wikiSeq = 0;

        this._knobPill = null;
        this._knobCanvas = null;
        this._knobLabel = null;
        this._speakerPill = null;
        this._speakerIcon = null;
        this._speakerLabel = null;

        this._menuSeparator = null;
        this._searchMenuItem = null;
        this._searchEntry = null;
        this._searchStatusLabel = null;
        this._resultsScroll = null;
        this._resultsBox = null;

        this._menuOpenId = null;
        this._btnDestroyId = null;

        this._syncAttachment();
        this._refreshStatus();

        this._pollId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            POLL_INTERVAL_SECONDS,
            () => {
                if (!this._enabled)
                    return GLib.SOURCE_REMOVE;
                this._syncAttachment();
                if (!this._busy && !this._dragging)
                    this._refreshStatus();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    disable() {
        this._enabled = false;
        this._endKnobDrag();
        if (this._volFlushTimeoutId) {
            GLib.source_remove(this._volFlushTimeoutId);
            this._volFlushTimeoutId = null;
        }
        if (this._searchDebounceId) {
            GLib.source_remove(this._searchDebounceId);
            this._searchDebounceId = null;
        }
        if (this._focusTimeoutId) {
            GLib.source_remove(this._focusTimeoutId);
            this._focusTimeoutId = null;
        }
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = null;
        }
        this._detach();
    }

    _detach() {
        this._endKnobDrag();
        if (this._attachedBtn && this._menuOpenId && this._attachedBtn.menu) {
            try {
                this._attachedBtn.menu.disconnect(this._menuOpenId);
            } catch (_) {}
        }
        this._menuOpenId = null;

        if (this._attachedBtn && this._btnDestroyId) {
            try {
                this._attachedBtn.disconnect(this._btnDestroyId);
            } catch (_) {}
        }
        this._btnDestroyId = null;

        if (this._attachedBtn?.menuLabelTitle) {
            try {
                this._attachedBtn.menuLabelTitle.show();
            } catch (_) {}
        }
        if (this._attachedBtn?.menuLabelSubtitle) {
            try {
                this._attachedBtn.menuLabelSubtitle.show();
            } catch (_) {}
        }

        if (this._attachedBtn?.menuControls) {
            try {
                this._attachedBtn.menuControls.show();
                this._attachedBtn.menuControls.height = -1;
            } catch (_) {}
        }

        if (this._customLabelsBox) {
            try {
                this._customLabelsBox.destroy();
            } catch (_) {}
            this._customLabelsBox = null;
            this._titleLabel = null;
            this._linksRow = null;
            this._artistLinkBtn = null;
            this._artistLinkLabel = null;
            this._artistWikiBtn = null;
            this._artistWikiIcon = null;
            this._artistWikiUrl = null;
            this._albumLinkBtn = null;
            this._albumLinkLabel = null;
            this._albumWikiBtn = null;
            this._albumWikiIcon = null;
            this._albumWikiUrl = null;
            this._lastWikiKey = '';
        }

        if (this._knobPill) {
            try {
                this._knobPill.destroy();
            } catch (_) {}
            this._knobPill = null;
            this._knobCanvas = null;
            this._knobLabel = null;
        }
        if (this._speakerPill) {
            try {
                this._speakerPill.destroy();
            } catch (_) {}
            this._speakerPill = null;
            this._speakerIcon = null;
            this._speakerLabel = null;
        }
        if (this._menuSeparator) {
            try {
                this._menuSeparator.destroy();
            } catch (_) {}
            this._menuSeparator = null;
        }
        if (this._searchMenuItem) {
            try {
                this._searchMenuItem.destroy();
            } catch (_) {}
            this._searchMenuItem = null;
            this._searchEntry = null;
            this._searchStatusLabel = null;
            this._resultsScroll = null;
            this._resultsBox = null;
        }
        this._attachedBtn = null;
    }

    _syncCustomMenuLabels(mcBtn) {
        if (!mcBtn?.menuLabels)
            return;

        try {
            if (mcBtn.menu?.box) {
                mcBtn.menu.box.style = `width: ${POPUP_BOX_WIDTH}px; min-width: ${POPUP_BOX_WIDTH}px; max-width: ${POPUP_BOX_WIDTH}px;`;
            }
            if (mcBtn.menuBox) {
                mcBtn.menuBox.style = `width: ${STANDARD_MENU_WIDTH}px; min-width: ${STANDARD_MENU_WIDTH}px; max-width: ${STANDARD_MENU_WIDTH}px;`;
            }
            if (mcBtn.menuImage) {
                mcBtn.menuImage.set_size(ALBUM_ART_SIZE, ALBUM_ART_SIZE);
                mcBtn.menuImage.icon_size = ALBUM_ART_SIZE;
            }
            // Hide dropdown play controls completely (use toolbar controls instead)
            if (mcBtn.menuControls) {
                mcBtn.menuControls.hide();
                mcBtn.menuControls.height = 0;
            }
        } catch (_) {}

        // Hide Media Controls' built-in ScrollingLabels completely so they take zero vertical space
        if (mcBtn.menuLabelTitle) {
            try {
                mcBtn.menuLabelTitle.hide();
                mcBtn.menuLabelTitle.height = 0;
            } catch (_) {}
        }
        if (mcBtn.menuLabelSubtitle) {
            try {
                mcBtn.menuLabelSubtitle.hide();
                mcBtn.menuLabelSubtitle.height = 0;
            } catch (_) {}
        }

        if (!this._customLabelsBox || this._customLabelsBox.get_parent() !== mcBtn.menuLabels) {
            if (this._customLabelsBox) {
                try {
                    this._customLabelsBox.destroy();
                } catch (_) {}
            }

            this._customLabelsBox = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
                style: `width: ${STANDARD_MENU_WIDTH}px; min-width: ${STANDARD_MENU_WIDTH}px; max-width: ${STANDARD_MENU_WIDTH}px; spacing: 6px; margin-top: 4px; margin-bottom: 2px;`,
            });

            const hasYaruInfoIcon = GLib.file_test(INFO_ICON_PATH, GLib.FileTest.EXISTS);
            const infoGIcon = hasYaruInfoIcon
                ? Gio.FileIcon.new(Gio.File.new_for_path(INFO_ICON_PATH))
                : null;
            const createInfoIconActor = () => new St.Icon({
                ...(infoGIcon ? { gicon: infoGIcon } : { icon_name: 'dialog-information-symbolic' }),
                icon_size: 15,
                style_class: 'symbolic-icon',
                y_align: Clutter.ActorAlign.CENTER,
                style: '-st-icon-style: symbolic; color: rgba(255, 255, 255, 0.20);',
            });

            // 1. Left-aligned Track Title row (wraps across 2 lines without clipping)
            this._titleLabel = new St.Label({
                text: '',
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.CENTER,
                style: `font-size: 12px; color: rgba(255,255,255,0.98); width: ${STANDARD_MENU_WIDTH}px; max-width: ${STANDARD_MENU_WIDTH}px; text-align: left; margin: 0; padding: 0;`,
            });
            this._titleLabel.clutter_text.use_markup = true;
            this._titleLabel.clutter_text.single_line_mode = false;
            this._titleLabel.clutter_text.line_wrap = true;
            this._titleLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            this._titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            this._titleLabel.clutter_text.line_alignment = Pango.Alignment.LEFT;

            // 2. Left-aligned Artist link + Right-aligned Wikipedia 'i'-in-circle button
            const artistRow = new St.BoxLayout({
                vertical: false,
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.CENTER,
                style: `spacing: 5px; width: ${STANDARD_MENU_WIDTH}px; min-width: ${STANDARD_MENU_WIDTH}px; max-width: ${STANDARD_MENU_WIDTH}px; margin: 0; padding: 0;`,
            });
            const artistPrefix = new St.Label({
                text: 'Artist:',
                y_align: Clutter.ActorAlign.CENTER,
                style: 'font-size: 11.5px; font-weight: 600; opacity: 0.6; min-width: 46px;',
            });
            this._artistLinkBtn = new St.BoxLayout({
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'margin: 0; padding: 0;',
            });
            this._artistLinkLabel = new St.Label({
                text: 'Artist',
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.CENTER,
                style: `font-size: 11.5px; font-weight: 600; text-decoration: underline; color: rgb(233, 84, 32); max-width: ${STANDARD_MENU_WIDTH - 76}px; text-align: left;`,
            });
            this._artistLinkLabel.clutter_text.single_line_mode = true;
            this._artistLinkLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            this._artistLinkBtn.add_child(this._artistLinkLabel);

            this._artistLinkBtn.connect('notify::hover', () => {
                if (!this._artistLinkLabel)
                    return;
                this._artistLinkLabel.style = this._artistLinkBtn.hover
                    ? `font-size: 11.5px; font-weight: 700; text-decoration: underline; color: rgb(255, 132, 76); max-width: ${STANDARD_MENU_WIDTH - 76}px; text-align: left;`
                    : `font-size: 11.5px; font-weight: 600; text-decoration: underline; color: rgb(233, 84, 32); max-width: ${STANDARD_MENU_WIDTH - 76}px; text-align: left;`;
            });

            bindReliableClick(this._artistLinkBtn, () => {
                this._showArtistAlbums();
            });

            // Right-aligned 'i' in a circle (official Yaru info-symbolic.svg) for Artist Wikipedia
            this._artistWikiBtn = new St.BoxLayout({
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'padding: 1px 2px;',
            });
            this._artistWikiIcon = createInfoIconActor();
            this._artistWikiBtn.add_child(this._artistWikiIcon);
            this._artistWikiBtn.connect('notify::hover', () => {
                this._updateWikiIconStyles();
            });
            bindReliableClick(this._artistWikiBtn, () => {
                if (this._artistWikiUrl) {
                    this._openWikiUrl(this._artistWikiUrl);
                }
            });

            artistRow.add_child(artistPrefix);
            artistRow.add_child(this._artistLinkBtn);
            artistRow.add_child(this._artistWikiBtn);

            // 3. Left-aligned Album link + Right-aligned Wikipedia 'i'-in-circle button
            this._linksRow = new St.BoxLayout({
                vertical: false,
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.CENTER,
                style: `spacing: 5px; width: ${STANDARD_MENU_WIDTH}px; min-width: ${STANDARD_MENU_WIDTH}px; max-width: ${STANDARD_MENU_WIDTH}px; margin: 0; padding: 0;`,
            });
            const albumPrefix = new St.Label({
                text: 'Album:',
                y_align: Clutter.ActorAlign.CENTER,
                style: 'font-size: 11.5px; font-weight: 600; opacity: 0.6; min-width: 46px;',
            });
            this._albumLinkBtn = new St.BoxLayout({
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'margin: 0; padding: 0;',
            });
            this._albumLinkLabel = new St.Label({
                text: 'Album',
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.CENTER,
                style: `font-size: 11.5px; font-weight: 600; text-decoration: underline; color: rgb(233, 84, 32); max-width: ${STANDARD_MENU_WIDTH - 76}px; text-align: left;`,
            });
            this._albumLinkLabel.clutter_text.single_line_mode = true;
            this._albumLinkLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            this._albumLinkBtn.add_child(this._albumLinkLabel);

            this._albumLinkBtn.connect('notify::hover', () => {
                if (!this._albumLinkLabel)
                    return;
                this._albumLinkLabel.style = this._albumLinkBtn.hover
                    ? `font-size: 11.5px; font-weight: 700; text-decoration: underline; color: rgb(255, 132, 76); max-width: ${STANDARD_MENU_WIDTH - 76}px; text-align: left;`
                    : `font-size: 11.5px; font-weight: 600; text-decoration: underline; color: rgb(233, 84, 32); max-width: ${STANDARD_MENU_WIDTH - 76}px; text-align: left;`;
            });

            bindReliableClick(this._albumLinkBtn, () => {
                this._showCurrentAlbumTracks();
            });

            // Right-aligned 'i' in a circle (official Yaru info-symbolic.svg) for Album Wikipedia
            this._albumWikiBtn = new St.BoxLayout({
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'padding: 1px 2px;',
            });
            this._albumWikiIcon = createInfoIconActor();
            this._albumWikiBtn.add_child(this._albumWikiIcon);
            this._albumWikiBtn.connect('notify::hover', () => {
                this._updateWikiIconStyles();
            });
            bindReliableClick(this._albumWikiBtn, () => {
                if (this._albumWikiUrl) {
                    this._openWikiUrl(this._albumWikiUrl);
                }
            });

            this._linksRow.add_child(albumPrefix);
            this._linksRow.add_child(this._albumLinkBtn);
            this._linksRow.add_child(this._albumWikiBtn);

            this._customLabelsBox.add_child(this._titleLabel);
            this._customLabelsBox.add_child(artistRow);
            this._customLabelsBox.add_child(this._linksRow);
            mcBtn.menuLabels.add_child(this._customLabelsBox);
        }

        const titleText = mcBtn.playerProxy?.metadata?.['xesam:title'] || '';
        const artistText = mcBtn.playerProxy?.metadata?.['xesam:artist']?.join(', ') || 'Unknown artist';
        const albumText = mcBtn.playerProxy?.metadata?.['xesam:album'] || '';

        if (this._titleLabel) {
            const escapedTitle = GLib.markup_escape_text(titleText, -1);
            const markup = `<span alpha="60%" weight="600">Track:</span>   <b>${escapedTitle}</b>`;
            if (this._titleLabel.clutter_text.get_text() !== `Track:   ${titleText}`) {
                this._titleLabel.clutter_text.set_markup(markup);
            }
        }

        if (this._artistLinkLabel && this._artistLinkLabel.text !== artistText)
            this._artistLinkLabel.text = artistText;

        if (albumText) {
            if (this._albumLinkLabel && this._albumLinkLabel.text !== albumText)
                this._albumLinkLabel.text = albumText;
            this._linksRow?.show();
        } else {
            this._linksRow?.hide();
        }

        const primaryArtist = mcBtn.playerProxy?.metadata?.['xesam:artist']?.[0] || artistText;
        const wikiKey = `${primaryArtist}|${albumText}`;
        if (wikiKey !== this._lastWikiKey) {
            this._lastWikiKey = wikiKey;
            this._artistWikiUrl = null;
            this._albumWikiUrl = null;
            this._updateWikiIconStyles();
            this._lookupWikiUrls(primaryArtist, albumText);
        }
    }

    _updateWikiIconStyles() {
        if (this._artistWikiIcon) {
            if (this._artistWikiUrl) {
                const h = !!this._artistWikiBtn?.hover;
                this._artistWikiIcon.style = h
                    ? '-st-icon-style: symbolic; color: rgb(155, 222, 255);'
                    : '-st-icon-style: symbolic; color: rgb(90, 190, 250);';
            } else {
                this._artistWikiIcon.style = '-st-icon-style: symbolic; color: rgba(255, 255, 255, 0.20);';
            }
        }
        if (this._albumWikiIcon) {
            if (this._albumWikiUrl) {
                const h = !!this._albumWikiBtn?.hover;
                this._albumWikiIcon.style = h
                    ? '-st-icon-style: symbolic; color: rgb(155, 222, 255);'
                    : '-st-icon-style: symbolic; color: rgb(90, 190, 250);';
            } else {
                this._albumWikiIcon.style = '-st-icon-style: symbolic; color: rgba(255, 255, 255, 0.20);';
            }
        }
    }

    _lookupWikiUrls(artistName, albumName) {
        const seq = ++this._wikiSeq;
        this._runCtl(['wiki-lookup', `${artistName}|${albumName}`], (res) => {
            if (!this._enabled || seq !== this._wikiSeq)
                return;
            this._artistWikiUrl = res?.artistWikiUrl || null;
            this._albumWikiUrl = res?.albumWikiUrl || null;
            this._updateWikiIconStyles();
        });
    }

    _openWikiUrl(url) {
        if (!url)
            return;
        try {
            Gio.AppInfo.launch_default_for_uri(url, null);
            this._attachedBtn?.menu?.close();
        } catch (_) {}
    }

    _syncAttachment() {
        const mcBtn = Main.panel?.statusArea?.['Media Controls'];
        if (!mcBtn || !mcBtn.buttonBox) {
            if (this._attachedBtn)
                this._detach();
            return;
        }

        if (this._attachedBtn !== mcBtn) {
            this._detach();
            this._attachedBtn = mcBtn;
            if (typeof mcBtn.playerProxy?.volume === 'number' && !Number.isNaN(mcBtn.playerProxy.volume)) {
                this._volume = Math.max(0, Math.min(1, mcBtn.playerProxy.volume));
            }
            // Purge any leftover children from earlier extension iterations
            const validBtnChildren = new Set(
                [mcBtn.buttonIcon, mcBtn.buttonLabel, mcBtn.buttonControls].filter(Boolean)
            );
            for (const ch of mcBtn.buttonBox.get_children()) {
                if (!validBtnChildren.has(ch)) {
                    try {
                        ch.destroy();
                    } catch (_) {}
                }
            }
            if (mcBtn.menuBox) {
                const validMenuBoxChildren = new Set(
                    [
                        mcBtn.menuPlayers,
                        mcBtn.menuImage,
                        mcBtn.menuLabels,
                        mcBtn.menuSlider,
                        mcBtn.menuControls,
                    ].filter(Boolean)
                );
                for (const ch of mcBtn.menuBox.get_children()) {
                    if (!validMenuBoxChildren.has(ch)) {
                        try {
                            ch.destroy();
                        } catch (_) {}
                    }
                }
            }
            this._btnDestroyId = mcBtn.connect('destroy', () => {
                this._attachedBtn = null;
                this._customLabelsBox = null;
                this._titleLabel = null;
                this._linksRow = null;
                this._artistLinkBtn = null;
                this._artistLinkLabel = null;
                this._linksSepLabel = null;
                this._albumLinkBtn = null;
                this._albumLinkLabel = null;
                this._knobPill = null;
                this._knobCanvas = null;
                this._knobLabel = null;
                this._speakerPill = null;
                this._speakerIcon = null;
                this._speakerLabel = null;
                this._menuSeparator = null;
                this._searchMenuItem = null;
                this._searchEntry = null;
                this._searchStatusLabel = null;
                this._resultsScroll = null;
                this._resultsBox = null;
                this._menuOpenId = null;
                this._btnDestroyId = null;
            });
            if (mcBtn.menu) {
                this._menuOpenId = mcBtn.menu.connect('open-state-changed', (_menu, isOpen) => {
                    if (isOpen) {
                        this._syncCustomMenuLabels(mcBtn);
                        if (this._searchEntry) {
                            if (this._focusTimeoutId) {
                                GLib.source_remove(this._focusTimeoutId);
                            }
                            this._focusTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                                this._focusTimeoutId = null;
                                try {
                                    this._searchEntry?.grab_key_focus();
                                } catch (_) {}
                                return GLib.SOURCE_REMOVE;
                            });
                        }
                    }
                });
            }
        }

        this._syncCustomMenuLabels(mcBtn);

        // 1. Analogue rotary volume knob pill on top bar
        if (!this._knobPill || this._knobPill.get_parent() !== mcBtn.buttonBox) {
            if (this._knobPill) {
                try {
                    this._knobPill.destroy();
                } catch (_) {}
            }

            this._knobPill = new St.BoxLayout({
                reactive: true,
                can_focus: true,
                track_hover: true,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'margin-left: 8px; padding: 1px 7px 1px 5px; border-radius: 99px; background-color: rgba(255,255,255,0.12); border: 1px solid rgba(255,255,255,0.22); spacing: 4px;',
            });

            this._knobCanvas = new St.DrawingArea({
                width: 20,
                height: 20,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._knobCanvas.connect('repaint', (area) => this._drawKnob(area));

            this._knobLabel = new St.Label({
                text: `${Math.round(this._volume * 100)}%`,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums;',
            });

            this._knobPill.add_child(this._knobCanvas);
            this._knobPill.add_child(this._knobLabel);

            this._knobPill.connect('button-press-event', (_actor, event) => {
                if (event.get_button() === Clutter.BUTTON_PRIMARY) {
                    this._startKnobDrag(event);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });

            this._knobPill.connect('motion-event', (_actor, event) => {
                if (this._dragging) {
                    this._onKnobDragMotion(event);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });

            this._knobPill.connect('button-release-event', () => {
                if (this._dragging) {
                    this._endKnobDrag();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });

            this._knobPill.connect('scroll-event', (_actor, event) => {
                const dir = event.get_scroll_direction();
                let delta = 0;
                if (dir === Clutter.ScrollDirection.UP) {
                    delta = 0.04;
                } else if (dir === Clutter.ScrollDirection.DOWN) {
                    delta = -0.04;
                } else if (dir === Clutter.ScrollDirection.SMOOTH) {
                    const [dx, dy] = event.get_scroll_delta();
                    delta = (-dy + dx) * 0.03;
                }
                if (delta !== 0) {
                    this._setVolumeImmediate(this._volume + delta, true);
                }
                return Clutter.EVENT_STOP;
            });

            mcBtn.buttonBox.add_child(this._knobPill);
            this._knobCanvas.queue_repaint();
        }

        // 2. Speaker toggle pill on top bar
        if (!this._speakerPill || this._speakerPill.get_parent() !== mcBtn.buttonBox) {
            if (this._speakerPill) {
                try {
                    this._speakerPill.destroy();
                } catch (_) {}
            }

            this._speakerPill = new St.BoxLayout({
                reactive: true,
                can_focus: true,
                track_hover: true,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'margin-left: 6px; padding: 2px 8px; border-radius: 99px; background-color: rgba(255,255,255,0.12); spacing: 5px;',
            });

            this._speakerIcon = new St.Icon({
                icon_name: 'audio-speakers-symbolic',
                icon_size: 14,
                style_class: 'system-status-icon no-margin',
                y_align: Clutter.ActorAlign.CENTER,
            });

            this._speakerLabel = new St.Label({
                text: 'Speaker',
                y_align: Clutter.ActorAlign.CENTER,
                style: 'font-size: 11.5px; font-weight: 600;',
            });

            this._speakerPill.add_child(this._speakerIcon);
            this._speakerPill.add_child(this._speakerLabel);

            this._speakerPill.connect('button-press-event', (_actor, event) => {
                const button = event.get_button();
                if (button === Clutter.BUTTON_PRIMARY) {
                    this._togglePolkReact();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });

            this._speakerPill.connect('touch-event', (_actor, event) => {
                if (event.type() === Clutter.EventType.TOUCH_BEGIN) {
                    this._togglePolkReact();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });

            mcBtn.buttonBox.add_child(this._speakerPill);
            this._renderState();
        }

        // 3. Fixed-width Spotify Search & Album/Track browser inside mcBtn.menuBox (same box & padding as controls)
        if (mcBtn.menuBox && (!this._searchMenuItem || this._searchMenuItem.get_parent() !== mcBtn.menuBox)) {
            if (this._searchMenuItem) {
                try {
                    this._searchMenuItem.destroy();
                } catch (_) {}
            }

            this._searchMenuItem = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                style: `width: ${STANDARD_MENU_WIDTH}px; min-width: ${STANDARD_MENU_WIDTH}px; max-width: ${STANDARD_MENU_WIDTH}px; spacing: 6px; margin-top: 4px; padding: 0;`,
            });

            this._menuSeparator = new St.Widget({
                x_expand: true,
                style: `height: 1px; background-color: rgba(255,255,255,0.14); width: ${STANDARD_MENU_WIDTH}px; margin-bottom: 4px;`,
            });

            const container = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                style: `padding: 0; spacing: 5px; width: ${STANDARD_MENU_WIDTH}px; min-width: ${STANDARD_MENU_WIDTH}px; max-width: ${STANDARD_MENU_WIDTH}px;`,
            });

            this._searchEntry = new St.Entry({
                hint_text: 'Search songs or albums…',
                can_focus: true,
                reactive: true,
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                primary_icon: new St.Icon({
                    icon_name: 'system-search-symbolic',
                    icon_size: 14,
                    style: 'color: rgba(255,255,255,0.7);',
                }),
                secondary_icon: new St.Icon({
                    icon_name: 'edit-clear-symbolic',
                    icon_size: 14,
                    style: 'color: rgba(255,255,255,0.6);',
                }),
                style: `border-radius: 8px; padding: 6px 10px; background-color: rgba(255,255,255,0.10); border: 1.5px solid rgb(233, 84, 32); font-size: 12px; width: ${STANDARD_MENU_WIDTH}px; min-width: ${STANDARD_MENU_WIDTH}px; max-width: ${STANDARD_MENU_WIDTH}px;`,
            });

            this._searchEntry.connect('secondary-icon-clicked', () => {
                this._searchEntry.set_text('');
                this._clearSearchResults('Click Artist (albums) or Album (tracks), or search');
                this._searchEntry.grab_key_focus();
            });

            const handleSearchKeyPress = (_actor, event) => {
                const sym = event.get_key_symbol();
                if (sym === Clutter.KEY_Escape)
                    return Clutter.EVENT_PROPAGATE;
                if (sym === Clutter.KEY_Down || sym === Clutter.KEY_KP_Down) {
                    if (this._lastItems.length > 0) {
                        this._selectedIndex = (this._selectedIndex + 1) % this._lastItems.length;
                        this._updateResultRowStyles();
                        this._scrollSelectedIntoView();
                    }
                    return Clutter.EVENT_STOP;
                }
                if (sym === Clutter.KEY_Up || sym === Clutter.KEY_KP_Up) {
                    if (this._lastItems.length > 0) {
                        this._selectedIndex =
                            (this._selectedIndex - 1 + this._lastItems.length) %
                            this._lastItems.length;
                        this._updateResultRowStyles();
                        this._scrollSelectedIntoView();
                    }
                    return Clutter.EVENT_STOP;
                }
                if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) {
                    const q = (this._searchEntry.get_text() || '').trim();
                    if (this._searchDebounceId) {
                        GLib.source_remove(this._searchDebounceId);
                        this._searchDebounceId = null;
                    }
                    if (this._lastItems.length > 0) {
                        const idx = Math.max(
                            0,
                            Math.min(this._lastItems.length - 1, this._selectedIndex)
                        );
                        this._activateResultItem(this._lastItems[idx]);
                    } else if (q.length >= 2) {
                        this._performSearch(q);
                    }
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            };

            this._searchEntry.clutter_text.connect('key-press-event', handleSearchKeyPress);

            // Prevent space/left/right keys from bubbling up to PopupMenu navigation
            this._searchEntry.connect('key-press-event', (_actor, event) => {
                const sym = event.get_key_symbol();
                if (sym === Clutter.KEY_Escape)
                    return Clutter.EVENT_PROPAGATE;
                return Clutter.EVENT_STOP;
            });

            this._searchEntry.clutter_text.connect('text-changed', () => {
                const q = (this._searchEntry.get_text() || '').trim();
                if (this._searchDebounceId) {
                    GLib.source_remove(this._searchDebounceId);
                    this._searchDebounceId = null;
                }
                if (q.length < 2) {
                    this._clearSearchResults('Click Artist (albums) or Album (tracks), or search');
                    return;
                }
                this._searchStatusLabel.text = 'Searching Spotify…';
                this._searchDebounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 260, () => {
                    this._searchDebounceId = null;
                    this._performSearch(q);
                    return GLib.SOURCE_REMOVE;
                });
            });

            const statusFooterRow = new St.BoxLayout({
                vertical: false,
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.CENTER,
                style: `width: ${STANDARD_MENU_WIDTH}px; min-width: ${STANDARD_MENU_WIDTH}px; max-width: ${STANDARD_MENU_WIDTH}px; spacing: 6px;`,
            });

            this._searchStatusLabel = new St.Label({
                text: 'Click Artist (albums) or Album (tracks), or search',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                style: `font-size: 10.5px; opacity: 0.65; padding-left: 2px; max-width: ${STANDARD_MENU_WIDTH - 28}px;`,
            });
            this._searchStatusLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;

            const settingsBtn = new St.BoxLayout({
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'padding: 2px 3px; border-radius: 4px;',
            });
            const settingsIcon = new St.Icon({
                icon_name: 'emblem-system-symbolic',
                icon_size: 14,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'color: rgba(255, 255, 255, 0.55);',
            });
            settingsBtn.add_child(settingsIcon);
            settingsBtn.connect('notify::hover', () => {
                settingsIcon.style = settingsBtn.hover
                    ? 'color: rgb(233, 84, 32);'
                    : 'color: rgba(255, 255, 255, 0.55);';
            });
            bindReliableClick(settingsBtn, () => {
                this._openSettingsWindow();
            });

            statusFooterRow.add_child(this._searchStatusLabel);
            statusFooterRow.add_child(settingsBtn);

            this._resultsScroll = new St.ScrollView({
                x_expand: false,
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
                style: `width: ${STANDARD_MENU_WIDTH}px; min-width: ${STANDARD_MENU_WIDTH}px; max-width: ${STANDARD_MENU_WIDTH}px; max-height: 280px;`,
            });

            this._resultsBox = new St.BoxLayout({
                vertical: true,
                x_expand: false,
                style: `spacing: 3px; width: ${STANDARD_MENU_WIDTH}px; min-width: ${STANDARD_MENU_WIDTH}px; max-width: ${STANDARD_MENU_WIDTH}px;`,
            });

            this._resultsScroll.set_child(this._resultsBox);
            this._resultsScroll.hide();

            this._searchMenuItem.add_child(this._menuSeparator);
            container.add_child(this._searchEntry);
            container.add_child(statusFooterRow);
            container.add_child(this._resultsScroll);
            this._searchMenuItem.add_child(container);

            mcBtn.menuBox.add_child(this._searchMenuItem);
        }
    }

    _openSettingsWindow() {
        try {
            GLib.spawn_async(
                null,
                [SETTINGS_APP_PATH],
                null,
                GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD,
                null
            );
            this._attachedBtn?.menu?.close();
        } catch (_) {}
    }

    _scrollSelectedIntoView() {
        if (!this._resultsScroll || !this._resultRows[this._selectedIndex])
            return;
        try {
            const row = this._resultRows[this._selectedIndex];
            const adj = this._resultsScroll.vscroll?.adjustment;
            if (!adj)
                return;
            const [, rowY] = row.get_transformed_position();
            const [, scrollY] = this._resultsScroll.get_transformed_position();
            const relY = rowY - scrollY;
            const rowH = row.get_height() || 36;
            const viewH = this._resultsScroll.get_height() || 280;
            if (relY < 0) {
                adj.value = Math.max(adj.lower, adj.value + relY - 4);
            } else if (relY + rowH > viewH) {
                adj.value = Math.min(adj.upper - adj.page_size, adj.value + (relY + rowH - viewH) + 4);
            }
        } catch (_) {}
    }

    _clearSearchResults(statusMsg) {
        this._lastItems = [];
        this._resultRows = [];
        this._selectedIndex = 0;
        this._lastQuery = '';
        if (this._searchStatusLabel && statusMsg)
            this._searchStatusLabel.text = statusMsg;
        if (this._resultsBox)
            this._resultsBox.destroy_all_children();
        if (this._resultsScroll)
            this._resultsScroll.hide();
    }

    _updateResultRowStyles() {
        for (let i = 0; i < this._resultRows.length; i++) {
            const row = this._resultRows[i];
            const isSelected = i === this._selectedIndex;
            row.style = isSelected
                ? `padding: 5px 8px; border-radius: 7px; background-color: rgba(30,215,96,0.24); border: 1px solid rgba(30,215,96,0.65); spacing: 8px; width: ${STANDARD_MENU_WIDTH}px; min-width: ${STANDARD_MENU_WIDTH}px; max-width: ${STANDARD_MENU_WIDTH}px;`
                : `padding: 5px 8px; border-radius: 7px; background-color: rgba(255,255,255,0.06); border: 1px solid transparent; spacing: 8px; width: ${STANDARD_MENU_WIDTH}px; min-width: ${STANDARD_MENU_WIDTH}px; max-width: ${STANDARD_MENU_WIDTH}px;`;
        }
    }

    _renderResultItems(items, headerText) {
        this._lastItems = items;
        this._resultRows = [];
        this._selectedIndex = 0;
        if (!this._resultsBox)
            return;
        this._resultsBox.destroy_all_children();

        if (this._searchStatusLabel && headerText)
            this._searchStatusLabel.text = headerText;

        if (items.length === 0) {
            this._resultsScroll?.hide();
            return;
        }
        this._resultsScroll?.show();
        try {
            if (this._resultsScroll?.vscroll?.adjustment)
                this._resultsScroll.vscroll.adjustment.value = 0;
        } catch (_) {}

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const row = new St.BoxLayout({
                x_expand: false,
                y_align: Clutter.ActorAlign.CENTER,
                style: `padding: 5px 8px; border-radius: 7px; background-color: rgba(255,255,255,0.06); border: 1px solid transparent; spacing: 8px; width: ${STANDARD_MENU_WIDTH}px; min-width: ${STANDARD_MENU_WIDTH}px; max-width: ${STANDARD_MENU_WIDTH}px;`,
            });

            row.connect('notify::hover', () => {
                if (row.hover) {
                    this._selectedIndex = i;
                    this._updateResultRowStyles();
                }
            });

            let iconName = 'audio-x-generic-symbolic';
            let iconColor = 'rgb(30, 215, 96)';
            if (item.kind === 'album') {
                iconName = 'media-optical-cd-audio-symbolic';
                iconColor = 'rgb(255, 196, 70)';
            } else if (item.kind === 'play-album') {
                iconName = 'media-playback-start-symbolic';
                iconColor = 'rgb(30, 215, 96)';
            } else if (item.kind === 'album-track') {
                iconName = 'audio-x-generic-symbolic';
                iconColor = 'rgb(130, 230, 170)';
            }

            const itemIcon = new St.Icon({
                icon_name: iconName,
                icon_size: 14,
                y_align: Clutter.ActorAlign.CENTER,
                style: `color: ${iconColor};`,
            });

            const textCol = new St.BoxLayout({
                vertical: true,
                x_expand: false,
                y_align: Clutter.ActorAlign.CENTER,
                style: `width: ${ROW_TEXT_WIDTH}px; min-width: ${ROW_TEXT_WIDTH}px; max-width: ${ROW_TEXT_WIDTH}px;`,
            });

            const titleLbl = new St.Label({
                text: item.name || 'Unknown',
                style: 'font-size: 11.5px; font-weight: 600;',
            });
            titleLbl.clutter_text.single_line_mode = false;
            titleLbl.clutter_text.line_wrap = true;
            titleLbl.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            titleLbl.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

            const subLbl = new St.Label({
                text: item.subtitle || '',
                style: 'font-size: 10px; opacity: 0.72;',
            });
            subLbl.clutter_text.ellipsize = Pango.EllipsizeMode.END;

            textCol.add_child(titleLbl);
            textCol.add_child(subLbl);

            const rightLbl = new St.Label({
                text: item.rightText || '',
                y_align: Clutter.ActorAlign.CENTER,
                style: 'font-size: 10px; opacity: 0.65; font-variant-numeric: tabular-nums;',
            });

            row.add_child(itemIcon);
            row.add_child(textCol);
            row.add_child(rightLbl);

            bindReliableClick(row, () => {
                this._activateResultItem(item);
            });

            this._resultRows.push(row);
            this._resultsBox.add_child(row);
        }
        this._updateResultRowStyles();
    }

    _performSearch(query) {
        const seq = ++this._searchSeq;
        this._lastQuery = query;
        if (this._searchStatusLabel)
            this._searchStatusLabel.text = `Searching "${query}"…`;

        this._runCtl(['search', query], (parsed) => {
            if (!this._enabled || seq !== this._searchSeq)
                return;
            const tracks = parsed?.tracks || [];
            const albums = parsed?.albums || [];
            if (tracks.length === 0 && albums.length === 0) {
                this._renderResultItems([], 'No matching songs or albums found');
                return;
            }
            const items = [];
            for (const a of albums) {
                items.push({
                    kind: 'album',
                    uri: a.uri,
                    name: a.name,
                    artist: a.artist || '',
                    subtitle: `Album · ${a.artist || ''}`,
                    rightText: a.year ? `${a.year} ›` : 'Tracks ›',
                });
            }
            for (const t of tracks) {
                items.push({
                    kind: 'track',
                    uri: t.uri,
                    name: t.name,
                    subtitle: t.album ? `Song · ${t.artist} · ${t.album}` : `Song · ${t.artist || ''}`,
                    rightText: formatDuration(t.durationMs),
                });
            }
            this._renderResultItems(
                items,
                `${albums.length} albums (click for tracks) · ${tracks.length} songs (click for Radio):`
            );
        });
    }

    _showArtistAlbums() {
        const artistArr = this._attachedBtn?.playerProxy?.metadata?.['xesam:artist'];
        const artistName = Array.isArray(artistArr) && artistArr.length > 0 ? artistArr[0] : '';
        const seq = ++this._searchSeq;
        if (this._searchStatusLabel)
            this._searchStatusLabel.text = `Loading albums by ${artistName || 'artist'}…`;
        if (this._searchEntry)
            this._searchEntry.grab_key_focus();

        const args = artistName ? ['artist-albums', artistName] : ['artist-albums'];
        this._runCtl(args, (parsed) => {
            if (!this._enabled || seq !== this._searchSeq)
                return;
            const albums = parsed?.albums || [];
            const resolvedArtist = parsed?.artist || artistName || 'Artist';
            if (albums.length === 0) {
                this._renderResultItems([], `No albums found for ${resolvedArtist}`);
                return;
            }
            const items = albums.map((a) => ({
                kind: 'album',
                uri: a.uri,
                name: a.name,
                artist: a.artist || resolvedArtist,
                subtitle: a.trackCount
                    ? `Album · ${a.trackCount} tracks`
                    : `Album · ${a.artist || resolvedArtist}`,
                rightText: a.year ? `${a.year} ›` : 'Tracks ›',
            }));
            this._renderResultItems(items, `${albums.length} albums by ${resolvedArtist} (click to open tracks):`);
        });
    }

    _showCurrentAlbumTracks() {
        const albumNameHint = this._attachedBtn?.playerProxy?.metadata?.['xesam:album'] || 'current album';
        const artistArr = this._attachedBtn?.playerProxy?.metadata?.['xesam:artist'];
        const artistHint = Array.isArray(artistArr) && artistArr.length > 0 ? artistArr[0] : '';
        const seq = ++this._searchSeq;
        if (this._searchStatusLabel)
            this._searchStatusLabel.text = `Loading tracks from "${albumNameHint}"…`;
        if (this._searchEntry)
            this._searchEntry.grab_key_focus();

        this._runCtl(['current-album-tracks'], (parsed) => {
            if (!this._enabled || seq !== this._searchSeq)
                return;
            const tracks = parsed?.tracks || [];
            const albumUri = parsed?.albumUri || '';
            const albumName = parsed?.albumName || albumNameHint;
            if (tracks.length === 0 || !albumUri) {
                this._renderResultItems([], `No tracks found for ${albumName}`);
                return;
            }
            this._renderAlbumTracksList(albumUri, albumName, artistHint, tracks);
        });
    }

    _openAlbumTracks(albumItem) {
        if (!albumItem || !albumItem.uri)
            return;
        const seq = ++this._searchSeq;
        if (this._searchStatusLabel)
            this._searchStatusLabel.text = `Loading tracks for "${albumItem.name}"…`;
        if (this._searchEntry)
            this._searchEntry.grab_key_focus();

        this._runCtl(['album-tracks', albumItem.uri], (parsed) => {
            if (!this._enabled || seq !== this._searchSeq)
                return;
            const tracks = parsed?.tracks || [];
            const albumName = parsed?.albumName || albumItem.name || 'Album';
            if (tracks.length === 0) {
                this._renderResultItems([], `No tracks found in ${albumName}`);
                return;
            }
            this._renderAlbumTracksList(albumItem.uri, albumName, albumItem.artist || '', tracks);
        });
    }

    _renderAlbumTracksList(albumUri, albumName, artistHint, tracks) {
        const items = [
            {
                kind: 'play-album',
                albumUri,
                uri: albumUri,
                name: `Play Full Album — ${albumName}`,
                subtitle: `${tracks.length} tracks · ${artistHint || tracks[0]?.artist || ''}`,
                rightText: 'All',
            },
        ];
        for (const t of tracks) {
            items.push({
                kind: 'album-track',
                albumUri,
                albumName,
                uri: t.uri,
                uid: t.uid || '',
                index: t.index ?? 0,
                name: `${t.trackNumber}. ${t.name}`,
                rawName: t.name,
                subtitle: `${t.artist || artistHint || ''} · ${albumName}`,
                rightText: formatDuration(t.durationMs),
            });
        }
        this._renderResultItems(items, `${albumName} (${tracks.length} tracks):`);
    }

    _activateResultItem(item) {
        if (!item || !item.uri)
            return;

        // Clicking or pressing Enter on an album drills into its tracks!
        if (item.kind === 'album') {
            this._openAlbumTracks(item);
            return;
        }

        if (this._searchDebounceId) {
            GLib.source_remove(this._searchDebounceId);
            this._searchDebounceId = null;
        }
        this._searchSeq++;
        this._lastItems = [];
        this._resultRows = [];
        this._selectedIndex = 0;
        this._lastQuery = '';
        if (this._resultsBox)
            this._resultsBox.destroy_all_children();
        if (this._resultsScroll)
            this._resultsScroll.hide();
        if (this._searchEntry)
            this._searchEntry.set_text('');

        if (item.kind === 'play-album') {
            if (this._searchStatusLabel)
                this._searchStatusLabel.text = `Playing "${item.name}"…`;
            this._runCtl(['play-album', item.albumUri], () => {
                if (!this._enabled)
                    return;
                if (this._searchStatusLabel)
                    this._searchStatusLabel.text = `Playing ${item.name}`;
            });
            return;
        }

        if (item.kind === 'album-track') {
            const labelName = item.rawName || item.name;
            if (this._searchStatusLabel)
                this._searchStatusLabel.text = `Playing "${labelName}" from ${item.albumName}…`;
            const spec = `${item.albumUri}|${item.uri}|${item.index ?? 0}|${item.uid || ''}`;
            this._runCtl(['play-album', spec], () => {
                if (!this._enabled)
                    return;
                if (this._searchStatusLabel)
                    this._searchStatusLabel.text = `Playing: ${labelName} (${item.albumName})`;
            });
            return;
        }

        // Song from search -> start Song Radio
        if (this._searchStatusLabel)
            this._searchStatusLabel.text = `Starting Song Radio for "${item.name}"…`;
        this._runCtl(['play-radio', item.uri], (res) => {
            if (!this._enabled)
                return;
            if (res && res.ok) {
                const nextPreview = Array.isArray(res.upNext) && res.upNext.length > 0
                    ? ` · Next: ${res.upNext.slice(0, 2).join(', ')}`
                    : '';
                if (this._searchStatusLabel)
                    this._searchStatusLabel.text = `Radio active: ${item.name}${nextPreview}`;
            } else if (this._searchStatusLabel) {
                this._searchStatusLabel.text = `Started "${item.name}"`;
            }
        });
    }

    _drawKnob(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const cx = w / 2;
        const cy = h / 2;
        const outerR = Math.min(w, h) / 2 - 2.0;
        const innerR = outerR - 2.6;

        // 270-degree sweep from 135 deg (7:30) to 405 deg (4:30)
        const startAngle = 0.75 * Math.PI;
        const sweepAngle = 1.5 * Math.PI;
        const endAngle = startAngle + sweepAngle;
        const valAngle = startAngle + Math.max(0, Math.min(1, this._volume)) * sweepAngle;

        cr.save();
        cr.setOperator(0); // CLEAR
        cr.paint();
        cr.restore();

        // Background track arc
        cr.setLineCap(1); // ROUND
        cr.setLineWidth(2.2);
        cr.setSourceRGBA(1, 1, 1, 0.22);
        cr.arc(cx, cy, outerR, startAngle, endAngle);
        cr.stroke();

        // Active value arc (Spotify green)
        if (this._volume > 0.005) {
            if (this._dragging) {
                cr.setSourceRGBA(0.18, 0.95, 0.45, 1.0);
            } else {
                cr.setSourceRGBA(0.12, 0.84, 0.38, 0.95);
            }
            cr.setLineWidth(2.4);
            cr.arc(cx, cy, outerR, startAngle, valAngle);
            cr.stroke();
        }

        // Inner rotary cap body
        cr.setSourceRGBA(0.13, 0.14, 0.16, 0.96);
        cr.arc(cx, cy, innerR, 0, 2 * Math.PI);
        cr.fillPreserve();
        cr.setLineWidth(0.9);
        cr.setSourceRGBA(1, 1, 1, this._dragging ? 0.55 : 0.3);
        cr.stroke();

        // Indicator notch line on the rotor cap
        const r0 = 1.6;
        const r1 = innerR - 0.8;
        cr.setLineCap(1);
        cr.setLineWidth(1.7);
        cr.setSourceRGBA(1, 1, 1, 0.95);
        cr.moveTo(cx + r0 * Math.cos(valAngle), cy + r0 * Math.sin(valAngle));
        cr.lineTo(cx + r1 * Math.cos(valAngle), cy + r1 * Math.sin(valAngle));
        cr.stroke();

        cr.$dispose();
    }

    _startKnobDrag(event) {
        if (this._dragging || !this._knobPill)
            return;
        this._dragging = true;
        const [x] = event.get_coords();
        this._dragStartX = x;
        this._dragStartVol = this._volume;
        try {
            this._dragGrab = global.stage.grab(this._knobPill);
        } catch (_) {
            this._dragGrab = null;
        }
        this._updateKnobStyle();
        this._knobCanvas?.queue_repaint();
    }

    _onKnobDragMotion(event) {
        if (!this._dragging)
            return;
        const [x] = event.get_coords();
        const delta = (x - this._dragStartX) / DRAG_PIXELS_FULL_SWEEP;
        this._setVolumeImmediate(this._dragStartVol + delta, false);
    }

    _endKnobDrag() {
        if (!this._dragging)
            return;
        this._dragging = false;
        if (this._dragGrab) {
            try {
                this._dragGrab.dismiss();
            } catch (_) {}
            this._dragGrab = null;
        }
        this._pushVolumeToSpotify(this._volume);
        this._updateKnobStyle();
        this._knobCanvas?.queue_repaint();
    }

    _updateKnobStyle() {
        if (!this._knobPill)
            return;
        this._knobPill.style = this._dragging
            ? 'margin-left: 8px; padding: 1px 7px 1px 5px; border-radius: 99px; background-color: rgba(30,215,96,0.26); border: 1px solid rgba(30,215,96,0.75); spacing: 4px;'
            : 'margin-left: 8px; padding: 1px 7px 1px 5px; border-radius: 99px; background-color: rgba(255,255,255,0.12); border: 1px solid rgba(255,255,255,0.22); spacing: 4px;';
    }

    _setVolumeImmediate(newVol, flushNow) {
        const clamped = Math.max(0, Math.min(1, newVol));
        this._volume = clamped;
        if (this._knobLabel)
            this._knobLabel.text = `${Math.round(clamped * 100)}%`;
        this._knobCanvas?.queue_repaint();

        const now = GLib.get_monotonic_time() / 1000;
        if (flushNow || now - this._lastVolSendMs >= 65) {
            this._lastVolSendMs = now;
            this._pushVolumeToSpotify(clamped);
        } else if (!this._volFlushTimeoutId) {
            this._volFlushTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 70, () => {
                this._volFlushTimeoutId = null;
                this._lastVolSendMs = GLib.get_monotonic_time() / 1000;
                this._pushVolumeToSpotify(this._volume);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _pushVolumeToSpotify(vol) {
        try {
            if (this._attachedBtn?.playerProxy) {
                this._attachedBtn.playerProxy.volume = vol;
            }
        } catch (_) {}
    }

    _togglePolkReact() {
        if (this._busy)
            return;
        this._busy = true;
        if (this._speakerLabel)
            this._speakerLabel.text = 'Switching…';
        this._runCtl(['toggle'], (parsed) => {
            this._busy = false;
            if (parsed && !parsed.error) {
                this._lastState = parsed;
                this._renderState();
            }
        });
    }

    _refreshStatus() {
        if (this._statusInFlight)
            return;
        this._statusInFlight = true;
        this._runCtl(['status'], (parsed) => {
            this._statusInFlight = false;
            if (parsed && !parsed.error) {
                this._lastState = parsed;
                this._renderState();
            }
        });
    }

    _runCtl(args, onDone) {
        try {
            const proc = Gio.Subprocess.new(
                [CTL_PATH, ...args],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            proc.communicate_utf8_async(null, null, (source, res) => {
                let parsed = null;
                try {
                    const [, stdout] = source.communicate_utf8_finish(res);
                    if (this._enabled && stdout && stdout.trim()) {
                        parsed = JSON.parse(stdout.trim());
                    }
                } catch (_) {
                    // Ignore transient failure when Spotify is closed
                } finally {
                    if (onDone)
                        onDone(parsed);
                }
            });
        } catch (_) {
            if (onDone)
                onDone(null);
        }
    }

    _renderState() {
        const state = this._lastState;
        if (!state)
            return;

        const active = state.active;

        if (!this._dragging && active && typeof active.volume === 'number' && !Number.isNaN(active.volume)) {
            this._volume = Math.max(0, Math.min(1, active.volume));
            if (this._knobLabel)
                this._knobLabel.text = `${Math.round(this._volume * 100)}%`;
            this._knobCanvas?.queue_repaint();
        }

        if (this._speakerIcon && this._speakerLabel && this._speakerPill) {
            if (active) {
                const isLocal = !!active.isLocal;
                this._speakerIcon.icon_name = isLocal
                    ? 'computer-symbolic'
                    : 'audio-speakers-symbolic';
                this._speakerLabel.text = isLocal ? 'PC' : active.name;
                this._speakerPill.style = !isLocal
                    ? 'margin-left: 6px; padding: 2px 8px; border-radius: 99px; background-color: rgba(30,215,96,0.28); border: 1px solid rgba(30,215,96,0.65); spacing: 5px;'
                    : 'margin-left: 6px; padding: 2px 8px; border-radius: 99px; background-color: rgba(255,255,255,0.14); border: 1px solid rgba(255,255,255,0.25); spacing: 5px;';
            } else {
                this._speakerIcon.icon_name = 'audio-speakers-symbolic';
                this._speakerLabel.text = 'Speaker';
            }
        }
    }
}
