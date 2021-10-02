"use strict";

const {Gtk} = imports.gi;

/**
 * Library of commonly used functions for the prefs' files
 * (and *not* the extension files)
 */

 var Util = class Utility {

    // taken from Overview-Improved by human.experience
	// https://extensions.gnome.org/extension/2802/overview-improved/
	static bindShortcut(settings, settingsKey, gtkTreeView, gtkListStore) {
		const COLUMN_KEY = 0;
		const COLUMN_MODS = 1;

		const iter = gtkListStore.append();
		const renderer = new Gtk.CellRendererAccel({ xalign: 1, editable: true });
		const column = new Gtk.TreeViewColumn();
		column.pack_start(renderer, true);
		column.add_attribute(renderer, "accel-key", COLUMN_KEY);
		column.add_attribute(renderer, "accel-mods", COLUMN_MODS);
		gtkTreeView.append_column(column);

		const updateShortcutRow = accel => {
			const [, key, mods] = accel ? Gtk.accelerator_parse(accel) : [true, 0, 0];
			gtkListStore.set(iter, [COLUMN_KEY, COLUMN_MODS], [key, mods]);
		};

		renderer.connect("accel-edited", (renderer, path, key, mods, hwCode) => {
			const accel = Gtk.accelerator_name(key, mods);
			updateShortcutRow(accel);
			settings.set_strv(settingsKey, [accel]);
		});

		renderer.connect("accel-cleared", () => {
			updateShortcutRow(null);
			settings.set_strv(settingsKey, []);
		});

		settings.connect("changed::" + settingsKey, () => {
			updateShortcutRow(settings.get_strv(settingsKey)[0]);
		});

		updateShortcutRow(settings.get_strv(settingsKey)[0]);
	};

    static getChildCount(container) {
		let childCount = 0;
        let child = container.get_first_child();
		for (; !!child; child = child.get_next_sibling())
			childCount++;

		return childCount;
	};

	static getChildIndexFor(container, child) {
        let c = container.get_first_child();
		for (let i = 0; !!c; i++) {
			if (c === child)
				return i;

            c = c.get_next_sibling();
		}

        return -1;
	};

	static getChildAt(container, idx) {
		let c = container.get_first_child()
		for (let i = 0; !!c; i++) {
			if (i === idx)
				return c;

			c = c.get_next_sibling()
		}

		return null;
	};

	static forEachChild(that, container, func) {
		for (let child = container.get_first_child(); !!child; ) {
			// get a ref to the next widget in case the curr widget
			// gets destroyed during the function call
			const nxtSibling = child.get_next_sibling();
			func.call(that, child);
			child = nxtSibling;
		}
	};
};
