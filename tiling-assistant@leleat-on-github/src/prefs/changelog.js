'use strict';

const { Gio, Gtk, GObject, Pango } = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

var Changelog = GObject.registerClass({
    GTypeName: 'TilingChangelog',
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
}, class TilingChangelog extends Gtk.Dialog {
    _init(params, changes) {
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
                const row = new Gtk.ListBoxRow({
                    can_focus: false,
                    activatable: false
                });
                row.set_child(new Gtk.Label({
                    label: change,
                    halign: Gtk.Align.START,
                    margin_start: 18,
                    margin_end: 18,
                    margin_top: 18,
                    margin_bottom: 18,
                    wrap: true,
                    wrap_mode: Pango.WrapMode.WORD_CHAR,
                    xalign: 0
                }));
                listBox.append(row);
            });
            box.show();
        });
    }
});
