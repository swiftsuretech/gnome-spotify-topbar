import GLib from 'gi://GLib';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

export default class SpotifySearchExtension extends Extension {
    enable() {
        this._active = true;
        this._impl = null;
        let targetFile = 'ui.js';
        try {
            const ptr = this.dir.get_child('ui-file.txt');
            if (ptr.query_exists(null)) {
                const [, bytes] = ptr.load_contents(null);
                const name = new TextDecoder().decode(bytes).trim();
                if (name)
                    targetFile = name;
            }
        } catch (_) {}

        const uiUri = this.dir.get_child(targetFile).get_uri();
        import(uiUri)
            .then((mod) => {
                if (!this._active)
                    return;
                this._impl = new mod.SpotifySpeakerController();
                this._impl.enable();
            })
            .catch((e) => console.error('spotify-search load error:', e));
    }

    disable() {
        this._active = false;
        if (this._impl) {
            try {
                this._impl.disable();
            } catch (e) {
                console.error('spotify-search disable error:', e);
            }
            this._impl = null;
        }
    }
}
