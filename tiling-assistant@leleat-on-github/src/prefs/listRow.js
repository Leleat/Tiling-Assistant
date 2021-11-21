'use strict';

const { Gdk, Gio, Gtk, GObject } = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const { ShortcutListener } = Me.imports.src.prefs.shortcutListener;

var ListRow = GObject.registerClass({
    GTypeName: 'TilingAssistantListRow',
    Template: Gio.File.new_for_path(`${Me.path}/src/ui/listRow.ui`).get_uri(),
    InternalChildren: ['box', 'subtitleLabel', 'titleLabel'],
    Properties: {
        // Gtk.Widget at the beginning of the row
        prefix: GObject.ParamSpec.object(
            'prefix',
            'prefix',
            'Gtk Widget',
            GObject.ParamFlags.READWRITE,
            Gtk.Widget.$gtype
        ),
        // Gtk.Widget at the end of the row
        suffix: GObject.ParamSpec.object(
            'suffix',
            'suffix',
            'Gtk Widget',
            GObject.ParamFlags.READWRITE,
            Gtk.Widget.$gtype
        ),
        // (Optional) string as 'prefix' or 'suffix': determines which widget
        // will be activated when activating the GtkListBox
        activatableWidget: GObject.ParamSpec.string(
            'activatableWidget',
            'activatableWidget',
            'The prefix or suffix widget',
            GObject.ParamFlags.READWRITE,
            null
        ),
        // Title of the row
        title: GObject.ParamSpec.string(
            'title',
            'Title',
            'Title of the row',
            GObject.ParamFlags.READWRITE,
            null
        ),
        // (Optional) subtitle of the row for more info
        subtitle: GObject.ParamSpec.string(
            'subtitle',
            'Subtitle',
            'Subtitle of the row',
            GObject.ParamFlags.READWRITE,
            null
        )
    }
}, class ListRow extends Gtk.ListBoxRow {
    _init(params = {}) {
        super._init(params);

        this.connect('realize', () => {
            this.prefix && this._box.prepend(this.prefix);
            this.suffix && this._box.append(this.suffix);
        });
    }

    activate() {
        let widget;

        if (this.activatableWidget === 'prefix')
            widget = this.prefix;
        else if (this.activatableWidget === 'suffix')
            widget = this.suffix;
        else if (this.prefix && this.suffix)
            widget = this.suffix;
        else
            widget = this.prefix || this.suffix;

        if (widget instanceof Gtk.Switch) {
            widget?.activate();
        } else if (widget instanceof Gtk.CheckButton) {
            widget?.activate();
        } else if (widget instanceof Gtk.SpinButton) {
            // Just grab focus since the action to take is ambiguous.
            widget?.grab_focus();
        } else if (widget instanceof ShortcutListener) {
            widget?.activate();
        } else if (widget instanceof Gtk.ComboBox) {
            widget?.popup_shown ? widget?.popdown() : widget?.popup();
        }
    }

    getContentBox() {
        return this._box;
    }

    _onSubtitleChanged() {
        this._subtitleLabel.set_visible(this.subtitle);
    }
});
