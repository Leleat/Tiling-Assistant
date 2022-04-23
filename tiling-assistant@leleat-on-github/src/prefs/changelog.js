'use strict';

const { Adw, Gio, Gtk, GObject } = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

var Changelog = GObject.registerClass({
    GTypeName: 'ChangelogDialog',
    Template: Gio.File.new_for_path(`${Me.path}/src/ui/changelog.ui`).get_uri(),
    InternalChildren: [
        'changelogReturnButton',
        'addedBox',
        'addedListBox',
        'removedBox',
        'removedListBox',
        'changedBox',
        'changedListBox',
        'fixedBox',
        'fixedListBox'
    ]
}, class ChangelogDialog extends Gtk.WindowHandle {
    _init(changes, allowAdvExpSettings) {
        super._init();

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
                const row = new Adw.ActionRow({
                    can_focus: false,
                    activatable: false
                });

                if (change.isExperimental && !allowAdvExpSettings)
                    return;

                row.set_title(change.title);
                change.subtitle && row.set_subtitle(change.subtitle);

                listBox.append(row);
            });

            box.show();
        });
    }
});
