import { Gio, Gtk, GObject } from '../dependencies/prefs/gi.js';
import { _ } from '../dependencies/prefs.js';

/**
 * Multiple LayoutRowEntries make up a LayoutRow.js. See that file for more info.
 */

export const LayoutRowEntry = GObject.registerClass({
    GTypeName: 'TilingLayoutRowEntry',
    Template: import.meta.url.replace(/prefs\/(.*)\.js$/, 'ui/$1.ui'),
    InternalChildren: [
        'rectEntry',
        'rectLabel',
        'rectAppButton'
    ],
    Signals: { 'changed': { param_types: [GObject.TYPE_BOOLEAN] } }
}, class TilingLayoutRowEntry extends Gtk.Box {
    _init(idx, item) {
        super._init({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8
        });

        this._item = item;

        this._rectLabel.set_label(`<span size="x-small">Rect ${idx}</span>`);
        const loop = item.loopType ? `--${item.loopType}` : '';
        const rect = item.rect;
        const text = Object.keys(rect).length !== 0
            ? `${rect.x}--${rect.y}--${rect.width}--${rect.height}${loop}`
            : '';
        this._rectEntry.get_buffer().set_text(text, -1);

        // Show a placeholder on the first entry, if it's empty
        if (!text) {
            if (idx === 0) {
                // Translators: This is a placeholder text of an entry in the prefs when defining a tiling layout.
                const placeholder = _("'User Guide' for help...");
                this._rectEntry.set_placeholder_text(placeholder);
            } else {
                this._rectEntry.set_placeholder_text('x--y--width--height[--h|v]');
            }
        }

        const appInfo = item.appId && Gio.DesktopAppInfo.new(item.appId);
        const iconName = appInfo?.get_icon().to_string() ?? 'list-add-symbolic';
        this._rectAppButton.set_icon_name(iconName);
    }

    /**
     * @param {Gtk.Button} appButton src of the event.
     */
    _onAppButtonClicked() {
        // Reset app button, if it already has an app attached
        if (this._item.appId) {
            this._rectAppButton.set_icon_name('list-add-symbolic');
            this._item.appId = null;
            this.emit('changed', true);

        // Attach app to the button
        } else {
            const chooserDialog = new Gtk.AppChooserDialog({ modal: true });
            chooserDialog.get_widget().set({ show_all: true, show_other: true });
            chooserDialog.connect('response', (dlg, id) => {
                if (id === Gtk.ResponseType.OK) {
                    const appInfo = chooserDialog.get_widget().get_app_info();
                    const iconName = appInfo.get_icon().to_string();
                    this._rectAppButton.set_icon_name(iconName);
                    this._item.appId = appInfo.get_id();
                    this.emit('changed', true);
                }

                chooserDialog.destroy();
            });

            chooserDialog.show();
        }
    }

    /**
     * @param {Gtk.Entry} entry src of the event.
     */
    _onRectEntryChanged(entry) {
        const text = entry.get_buffer().get_text();
        const [ok] = this._validateFormat(text);
        if (ok) {
            const values = text.split('--');
            this._item.rect = {
                x: parseFloat(values[0].trim()),
                y: parseFloat(values[1].trim()),
                width: parseFloat(values[2].trim()),
                height: parseFloat(values[3].trim())
            };
            this._item.loopType = values[4] || null;
        } else {
            this._item.rect = {};
            this._item.loopType = null;
        }

        this.emit('changed', ok);
    }

    /**
     * Validates whether `text` follows the format \
     * 'Float--Float--Float--Float[--String]'
     *
     * @param {string} text
     * @returns {[boolean, string]} whether the `text` is valid and a
     *      potential error message.
     */
    _validateFormat(text) {
        const values = text.split('--');
        // 4 -> x, y, width, height; 5 -> additionally, a loopType
        if (values.length < 4 || values.length > 5)
            return [false, 'Wrong format: invalid count.'];

        const notJustNrs = ['x', 'y', 'width', 'height'].some((p, idx) => {
            return Number.isNaN(parseFloat(values[idx].trim()));
        });

        return notJustNrs
            ? [false, 'Wrong format: only numbers are allowed.']
            : [true, ''];
    }
});
