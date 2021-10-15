'use strict';

const Gtk = imports.gi.Gtk;

/**
 * Library of commonly used functions for the prefs' files
 * (and *not* the extension files)
 */

var Util = class Utility { // eslint-disable-line no-unused-vars
    /**
     * Binds the settings to the GUI.
     * Taken from Overview-Improved by human.experience \
     * https://extensions.gnome.org/extension/2802/overview-improved/
     *
     * @param {Gio.Setting} settings the Gio object.
     * @param {string} settingsKey the shortcut's settings key.
     * @param {Gtk.TreeView} gtkTreeView the shortcut's Gtk.TreeView.
     * @param {Gtk.ListStore} gtkListStore the shortcut's Gtk.ListStore.
     */
    static bindShortcut(settings, settingsKey, gtkTreeView, gtkListStore) {
        const COLUMN_KEY = 0;
        const COLUMN_MODS = 1;

        const iter = gtkListStore.append();
        const renderer = new Gtk.CellRendererAccel({ xalign: 1, editable: true });
        const column = new Gtk.TreeViewColumn();
        column.pack_start(renderer, true);
        column.add_attribute(renderer, 'accel-key', COLUMN_KEY);
        column.add_attribute(renderer, 'accel-mods', COLUMN_MODS);
        gtkTreeView.append_column(column);

        const updateShortcutRow = accel => {
            const [, key, mods] = accel ? Gtk.accelerator_parse(accel) : [true, 0, 0];
            gtkListStore.set(iter, [COLUMN_KEY, COLUMN_MODS], [key, mods]);
        };

        renderer.connect('accel-edited', (ren, path, key, mods) => {
            const accel = Gtk.accelerator_name(key, mods);
            updateShortcutRow(accel);
            settings.set_strv(settingsKey, [accel]);
        });

        renderer.connect('accel-cleared', () => {
            updateShortcutRow(null);
            settings.set_strv(settingsKey, []);
        });

        settings.connect(`changed::${settingsKey}`, () => {
            updateShortcutRow(settings.get_strv(settingsKey)[0]);
        });

        updateShortcutRow(settings.get_strv(settingsKey)[0]);
    }

    /**
     * Loops through the children of a Gtk.Widget.
     *
     * @param {object} that `this` for the `func`.
     * @param {object} container the parent widget of the children.
     * @param {function(object, number)} func the function to execute each
     *      loop with the child and its index as a parameter.
     */
    static forEachChild(that, container, func) {
        for (let i = 0, child = container.get_first_child(); !!child; i++) {
            // Get a ref to the next widget in case the curr widget
            // gets destroyed during the function call.
            const nxtSibling = child.get_next_sibling();
            func.call(that, child, i);
            child = nxtSibling;
        }
    }
};
