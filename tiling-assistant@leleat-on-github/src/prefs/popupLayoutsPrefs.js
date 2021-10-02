"use strict";

const {Gio, GLib} = imports.gi;
const ByteArray = imports.byteArray;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const LayoutRow = Me.imports.src.prefs.popupLayoutsGui.GuiRow;
const Shortcuts = Me.imports.src.common.Shortcuts;
const Util = Me.imports.src.prefs.utility.Util;

/**
 * This class takes care of everything related to popup layouts (at
 * least on the preference side). It's only being instanced by prefs.js.
 * After that, it loads / saves layouts from / to the disk and loads the
 * gui for managing layouts. The gui is created by instancing a bunch of
 * Gtk.ListBoxRows from layoutGui.js for each layout and putting them into
 * a Gtk.ListBox from the prefs.ui file.
 *
 * A popup layout has a name (String) and an array of LayoutItems (JS Objects).
 * A LayoutItem has a rect (JS Objects), an optional (String) appId and optional
 * loopType (String). Only the rect is a mandatory. The name lets the user
 * search for a layout with the 'Search popup layout' keybinding. The rectangle's
 * properties range from 0 to 1 (-> relative scale to the monitor). After a layout
 * is activated by the user, the 'tiling popup' will appear at every LayoutItem's
 * rect and ask the user which of the open windows they want to tile to that rect.
 * If a loopType is set, the tiling popup will keep spawning at that spot and
 * all tiled windows will evenly share that rect until the user cancels the tiling
 * popup. Only then will we jump to the next LayoutItem. Possible loopTypes:
 * horizontal ("h") or vertical (any other non-empty string). This allows the
 * user to create 'Master and Stack' type of layouts. If an appId is defined,
 * instead of the tiling popup appearing, a new instance of the app will be
 * opened and tiled to that rect (or at least I tried to do that).
 *
 * By default, the settings for popup layouts are hidden behind the 'Advanced
 * / Experimental' switch because I used a lot of hacks / assumptions... and
 * I am not even using the layouts myself. However, I don't want to remove
 * an existing feature... thus it's hidden
 */

var Prefs = class PopupLayoutsPrefs {

	constructor(builder, settings) {
		// Keep a reference to the settings for the shortcuts
		// and the builder to get the objects from the ui file
		this._builder = builder;
		this._settings = settings;

		// The Gtk.ListBox, which LayoutRows are added to
		this._layoutsListBox = this._builder.get_object("layouts-listbox");

		// Unique button to save changes made to all layouts to the disk.
		// For simplicity, reload from file after saving to get rid of invalid input.
		this._saveLayoutsButton = this._builder.get_object("save-layouts-button");
		this._saveLayoutsButton.connect("clicked", () => {
			this._saveLayouts();
			this._loadLayouts();
		});

		// Unique button to load layouts from the disk
		// (discarding all tmp changes) without any user prompt
		this._reloadLayoutsButton = this._builder.get_object("reload-layouts-button");
		this._reloadLayoutsButton.connect("clicked", () => {
			this._loadLayouts();
		});

		// Unique button to add a new *tmp* layoutRow
		this._addLayoutButton = this._builder.get_object("add-layout-button");
		this._addLayoutButton.connect("clicked", () => {
			this._createLayoutRow(LayoutRow.getInstanceCount());
		});

		// Bind keyboard shortcut(s).
		// Account for the existing "normal" keyboard shortcuts for the clear-button(s).
		// The shortcuts for the layouts are bound when the layoutRows are created.
		["search-popup-layout"].forEach((key, idx) => {
			// bind gui and gsettings
			const treeView = this._builder.get_object(key + "-treeview");
			const listStore = this._builder.get_object(key + "-liststore");
			Util.bindShortcut(this._settings, key, treeView, listStore);

			// bind clear-shortcut-buttons
			const existingIdx = Shortcuts.getAllKeys().length;
			const clearButton = this._builder.get_object(`clear-button${existingIdx + idx + 1}`);
			clearButton.set_sensitive(this._settings.get_strv(key)[0]);

			clearButton.connect("clicked", () => this._settings.set_strv(key, []));
			this._settings.connect(`changed::${key}`, () =>
					clearButton.set_sensitive(this._settings.get_strv(key)[0]));
		});

		// Finally, load the existing settings.
		this._loadLayouts();
	};

	// Load from file
	_loadLayouts() {
		this._applySaveButtonAction("");

		// Destroy old gui
		Util.forEachChild(this, this._layoutsListBox, layoutRow => layoutRow.destroy());
		LayoutRow.resetInstanceCount();

		const saveFile = this._getSaveFile();
		const [success, contents] = saveFile.load_contents(null);

		if (!success)
			return;

		// Create layoutRows
		const layouts = contents.length ? JSON.parse(ByteArray.toString(contents)) : [];
		layouts.forEach((layout, idx) => this._createLayoutRow(idx, layout));
	};

	// Save to file
	_saveLayouts() {
		this._applySaveButtonAction("");

		// Only save valid layouts
		const layouts = [];
		Util.forEachChild(this, this._layoutsListBox, layoutRow => {
			const l = layoutRow.getLayout();
			l && layouts.push(l);
		});

		const saveFile = this._getSaveFile();
		saveFile.replace_contents(
			JSON.stringify(layouts)
			, null
			, false
			, Gio.FileCreateFlags.REPLACE_DESTINATION
			, null
		);
	};

	_getSaveFile() {
		// create directory structure, if it doesn't exist
		const saveDirLocation = [GLib.get_user_config_dir(), "/tiling-assistant"];
		const parentDir = Gio.File.new_for_path(GLib.build_filenamev(saveDirLocation));
		try { parentDir.make_directory_with_parents(null) } catch (e) { }

		// create save file, if it doesn't exist
		const saveFilePath = GLib.build_filenamev([...saveDirLocation, "/layouts.json"]);
		const saveFile = Gio.File.new_for_path(saveFilePath);
		try { saveFile.create(Gio.FileCreateFlags.NONE, null) } catch (e) { }

		return saveFile;
	};

	// The suggested-action is used to indicate that the user made changes;
	// the destructive-action, if the changes are invalid and saving will lose the changes
	_applySaveButtonAction(actionName) {
		const actions = ["suggested-action", "destructive-action"];
		const context = this._saveLayoutsButton.get_style_context();
		actions.forEach(a => a === actionName
				? context.add_class(a)
				: context.remove_class(a));
	};

	_createLayoutRow(index, layout = null) {
		// layouts are limited to 20 since there are only
		// that many keybindings in the schemas.xml file
		if (index >= 20)
			return;

		const layoutRow = new LayoutRow(layout);
		layoutRow.connect("changed", (row, ok) => {
			// Un/Highlight the save button, if the user made in/valid changes.
			this._applySaveButtonAction(ok ? "suggested-action" : "destructive-action");
		});
		this._layoutsListBox.append(layoutRow);

		const treeView = layoutRow.getTreeView();
		const listStore = layoutRow.getListStore();
		// TODO: the user can create a bunch of empty rows and set the keybinding for
		// a later row. After saving, the empty rows will get removed and the keybinding
		// is still set for the later layout but that's not immediately visible to the user
		Util.bindShortcut(this._settings, `activate-layout${index}`, treeView, listStore);
	};
};
