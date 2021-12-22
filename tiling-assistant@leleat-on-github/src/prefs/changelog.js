'use strict';

const { Gio, Gtk, GObject, Pango } = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const { ListRow } = Me.imports.src.prefs.listRow;

var Changelog = GObject.registerClass({
    GTypeName: 'ChangelogDialog',
    Template: Gio.File.new_for_path(`${Me.path}/src/ui/changelog.ui`).get_uri(),
    InternalChildren: [
        'addedBox',
        'addedListBox',
        'removedBox',
        'removedListBox',
        'changedBox',
        'changedListBox',
        'fixedBox',
        'fixedListBox'
    ]
}, class ChangelogDialog extends Gtk.Dialog {
    _init(params = {}, changes, allowAdvExpSettings) {
        super._init(params);

        Object.entries(changes).forEach(([type, changeItems]) => {
            if (!changeItems.length)
                return;

            let box, listBox;

            switch (type) {
                case 'added':
                    box = this._addedBox;
                    listBox = this._addedListBox;
                    break;
                case 'removed':
                    box = this._removedBox;
                    listBox = this._removedListBox;
                    break;
                case 'changed':
                    box = this._changedBox;
                    listBox = this._changedListBox;
                    break;
                case 'fixed':
                    box = this._fixedBox;
                    listBox = this._fixedListBox;
            }

            changeItems.forEach(change => {
                const row = new ListRow({
                    can_focus: false,
                    activatable: false
                });
                row.getContentBox().set_margin_start(18);
                row.getContentBox().set_margin_end(18);
                row.getContentBox().set_margin_top(18);
                row.getContentBox().set_margin_bottom(18);

                if (change.isExperimental && !allowAdvExpSettings)
                    return;

                row.title = change.title;
                row.subtitle = change.subtitle;

                listBox.append(row);
            });

            box.show();
        });
    }
});
