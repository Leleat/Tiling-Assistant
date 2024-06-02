import { Gio, GLib } from '../dependencies/prefs/gi.js';

import { LayoutRow } from './layoutRow.js';

/**
 * This class takes care of everything related to layouts (at least on the
 * preference side). It's only being instanced by prefs.js. After that, it
 * loads / saves layouts from / to the disk and loads the gui for managing
 * layouts. The gui is created by instancing a bunch of Gtk.ListBoxRows from
 * layoutGui.js for each layout and putting them into a Gtk.ListBox from the
 * prefs.ui file.
 *
 * A popup layout has a name (String) and an array of LayoutItems (JS Objects).
 * A LayoutItem has a rect (JS Objects), an optional (String) appId and optional
 * loopType (String). Only the rect is a mandatory. The name lets the user
 * search for a layout with the 'Search popup layout' keybinding. The rectangle's
 * properties range from 0 to 1 (-> relative scale to the monitor). After a layout
 * is activated by the user, the 'Tiling Popup' will appear at every LayoutItem's
 * rect and ask the user which of the open windows they want to tile to that rect.
 * If a loopType is set, the Tiling Popup will keep spawning at that spot and
 * all tiled windows will evenly share that rect until the user cancels the tiling
 * popup. Only then will we jump to the next LayoutItem. Possible loopTypes:
 * horizontal ('h') or vertical (any other non-empty string). This allows the
 * user to create 'Master and Stack' type of layouts. If an appId is defined,
 * instead of the Tiling Popup appearing, a new instance of the app will be
 * opened and tiled to that rect (or at least I tried to do that).
 *
 * By default, the settings for layouts are hidden behind the 'Advanced /
 * Experimental' switch because I used a lot of hacks / assumptions... and
 * I am not even using the layouts myself. However, I don't want to remove
 * an existing feature... thus it's hidden
 */

export default class {
    constructor(settings, builder, path) {
        // Keep a reference to the settings for the shortcuts
        this._settings = settings;

        // The Gtk.ListBox, which LayoutRows are added to
        this._layoutsListBox = builder.get_object('layouts_listbox');

        // Unique button to save changes made to all layouts to the disk. For
        // simplicity, reload from file after saving to get rid of invalid input.
        this._saveLayoutsButton = builder.get_object('save_layouts_button');
        this._saveLayoutsButton.connect('clicked', () => {
            this._saveLayouts();
            this._loadLayouts();
        });

        // Unique button to load layouts from the disk
        // (discarding all tmp changes) without any user prompt
        this._reloadLayoutsButton = builder.get_object('reload_layouts_button');
        this._reloadLayoutsButton.connect('clicked', () => {
            this._loadLayouts();
        });

        // Unique button to add a new *tmp* LayoutRow
        this._addLayoutButton = builder.get_object('add_layout_button');
        this._addLayoutButton.connect('clicked', () => {
            const row = this._createLayoutRow(LayoutRow.getInstanceCount());
            row.toggleReveal();
        });

        // Bind the general layouts keyboard shortcuts.
        ['search-popup-layout'].forEach(key => {
            const shortcut = builder.get_object(key.replaceAll('-', '_'));
            shortcut.initialize(key, this._settings);
        });

        // Finally, load the existing settings.
        this._loadLayouts(path);
    }

    _loadLayouts(path) {
        this._applySaveButtonStyle('');

        this._forEachLayoutRow(row => row.destroy());
        LayoutRow.resetInstanceCount();

        // Try to load layouts file.
        const saveFile = this._makeFile();
        const [success, contents] = saveFile.load_contents(null);
        if (!success)
            return;

        let layouts = [];

        // Custom layouts are already defined in the file.
        if (contents.length) {
            layouts = JSON.parse(new TextDecoder().decode(contents));
            // Ensure at least 1 empty row otherwise the listbox won't have
            // a height but a weird looking shadow only.
            layouts.length
                ? layouts.forEach((layout, idx) => this._createLayoutRow(idx, layout))
                : this._createLayoutRow(0);

        // Otherwise import the examples... but only do it once!
        // Use a setting as a flag.
        } else {
            const importExamples = 'import-layout-examples';
            if (!this._settings.get_boolean(importExamples))
                return;

            this._settings.set_boolean(importExamples, false);
            const exampleFile = this._makeFile(`${path}/src`, 'layouts_example.json');
            const [succ, c] = exampleFile.load_contents(null);
            if (!succ)
                return;

            layouts = c.length ? JSON.parse(new TextDecoder().decode(c)) : [];
            layouts.forEach((layout, idx) => this._createLayoutRow(idx, layout));
            this._saveLayouts();
        }
    }

    _saveLayouts() {
        this._applySaveButtonStyle('');

        const layouts = [];
        this._forEachLayoutRow(layoutRow => {
            const lay = layoutRow.getLayout();
            if (lay) {
                layouts.push(lay);

                // Check, if all layoutRows were valid so far. Use getIdx()
                // instead of forEach's idx because a layoutRow may have been
                // deleted by the user.
                if (layoutRow.getIdx() === layouts.length - 1)
                    return;

                // Invalid or empty layouts are ignored. For example, the user
                // defined a valid layout with a keybinding on row idx 3 but left
                // the row at idx 2 empty. When saving, the layout at idx 2 gets
                // removed and layout at idx 3 takes its place (i. e. becomes
                // idx 2). We need to update the keybindings to reflect that.
                const keys = this._settings.get_strv(`activate-layout${layoutRow.getIdx()}`);
                this._settings.set_strv(`activate-layout${layouts.length - 1}`, keys);
                this._settings.set_strv(`activate-layout${layoutRow.getIdx()}`, []);
            } else {
                // Remove keyboard shortcuts, if they aren't assigned to a
                // valid layout, because they won't be visible to the user
                // since invalid layouts get removed
                this._settings.set_strv(`activate-layout${layoutRow.getIdx()}`, []);
            }
        });

        const saveFile = this._makeFile();
        saveFile.replace_contents(
            JSON.stringify(layouts),
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null
        );
    }

    /**
     * @param {string} [parentPath=''] path to the parent directory.
     * @param {string} [fileName=''] name of the layouts file.
     * @returns {object} the Gio.File.
     */
    _makeFile(parentPath = '', fileName = '') {
        // Create directory structure, if it doesn't exist.
        const userConfigDir = GLib.get_user_config_dir();
        const dirLocation = parentPath ||
                GLib.build_filenamev([userConfigDir, '/tiling-assistant']);
        const parentDir = Gio.File.new_for_path(dirLocation);

        try {
            parentDir.make_directory_with_parents(null);
        } catch (e) {
            if (e.code !== Gio.IOErrorEnum.EXISTS) {
                throw e;
            }
        }

        // Create file, if it doesn't exist.
        const fName = fileName || 'layouts.json';
        const filePath = GLib.build_filenamev([dirLocation, '/', fName]);
        const file = Gio.File.new_for_path(filePath);

        try {
            file.create(Gio.FileCreateFlags.NONE, null);
        } catch (e) {
            if (e.code !== Gio.IOErrorEnum.EXISTS) {
                throw e;
            }
        }

        return file;
    }

    /**
     * @param {string} [actionName=''] possible styles: 'suggested-action'
     *      or 'destructive-action'
     */
    _applySaveButtonStyle(actionName = '') {
        // The suggested-action is used to indicate that the user made
        // changes; the destructive-action, if saving will drop changes
        // (e. g. when changes were invalid)
        const actions = ['suggested-action', 'destructive-action'];
        const context = this._saveLayoutsButton.get_style_context();
        actions.forEach(a => a === actionName
            ? context.add_class(a)
            : context.remove_class(a));
    }

    /**
     * @param {number} index the index of the new layouts row.
     * @param {Layout} layout the parsed JS Object from the layouts file.
     */
    _createLayoutRow(index, layout = null) {
        // Layouts are limited to 20 since there are only
        // that many keybindings in the schemas.xml file
        if (index >= 20)
            return;

        const layoutRow = new LayoutRow(layout, this._settings);
        layoutRow.connect('changed', (row, ok) => {
            // Un / Highlight the save button, if the user made in / valid changes.
            this._applySaveButtonStyle(ok ? 'suggested-action' : 'destructive-action');
        });
        this._layoutsListBox.append(layoutRow);
        return layoutRow;
    }

    _forEachLayoutRow(callback) {
        for (let i = 0, child = this._layoutsListBox.get_first_child(); !!child; i++) {
            // Get a ref to the next widget in case the curr widget
            // gets destroyed during the function call.
            const nxtSibling = child.get_next_sibling();
            callback.call(this, child, i);
            child = nxtSibling;
        }
    }
}
