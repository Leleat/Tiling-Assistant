"use strict";

const {Gdk, Gio, GLib, Gtk, GObject} = imports.gi;
const ByteArray = imports.byteArray;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const shellVersion = parseFloat(imports.misc.config.PACKAGE_VERSION);

const Gettext = imports.gettext;
const Domain = Gettext.domain(Me.metadata.uuid);
const _ = Domain.gettext;

const TILING = { // copy/paste from extension.js
	DEBUGGING: "debugging-show-tiled-rects",
	DEBUGGING_FREE_RECTS: "debugging-free-rects",
	TOGGLE_POPUP: "toggle-tiling-popup",
	AUTO: "auto-tile",
	MAXIMIZE: "tile-maximize",
	EDIT_MODE: "tile-edit-mode",
	RIGHT: "tile-right-half",
	LEFT: "tile-left-half",
	TOP: "tile-top-half",
	BOTTOM: "tile-bottom-half",
	TOP_LEFT: "tile-topleft-quarter",
	TOP_RIGHT: "tile-topright-quarter",
	BOTTOM_LEFT: "tile-bottomleft-quarter",
	BOTTOM_RIGHT: "tile-bottomright-quarter"
};

function init() {
	ExtensionUtils.initTranslations(Me.metadata.uuid);
};

function buildPrefsWidget() {
	return new MyPrefsWidget();
};

const MyPrefsWidget = new GObject.Class({
	Name : "TilingAssistantPrefsWidget",
	GTypeName : "TilingAssistantPrefsWidget",
	Extends : Gtk.ScrolledWindow,

	_init: function(params) {
		const gschema = Gio.SettingsSchemaSource.new_from_directory(
			Me.dir.get_child("schemas").get_path()
			, Gio.SettingsSchemaSource.get_default()
			, false
		);

		const settingsSchema = gschema.lookup(Me.metadata["settings-schema"], true);
		this._settings = new Gio.Settings({settings_schema: settingsSchema});

		this.parent(params);

		this._builder = new Gtk.Builder();
		this._builder.add_from_file(Me.path + `/prefs${shellVersion < 40 ? "" : "40"}.ui`);
		const mainPrefs = this._builder.get_object("main_prefs");
		_addChildTo(this, mainPrefs);

		this.set_min_content_width(700);
		this.set_min_content_height(650);

		this._bindWidgetsToSettings(settingsSchema.list_keys());
		this._bindKeybindings();

		this.connect("destroy", () => this._settings.run_dispose());

		shellVersion < 40 && this.show_all();

		// clear keybindings buttons:
		// hardcode settingKeys and their order... I tried to use get_parent().get_child(x).get_name().split("-treeView")[0].
		// it worked on GTK3 but on GTK4 it just returned the class name (GtkTreeView) and not the name/id for some reason
		const keysToClear = [
			TILING.TOGGLE_POPUP, TILING.EDIT_MODE, TILING.AUTO, TILING.MAXIMIZE
			, TILING.TOP, TILING.BOTTOM, TILING.LEFT, TILING.RIGHT
			, TILING.TOP_LEFT, TILING.TOP_RIGHT, TILING.BOTTOM_LEFT, TILING.BOTTOM_RIGHT
		];
		for (let idx = 1; idx <= 12; idx++) {
			const clearButton = this._builder.get_object(`clear-button${idx}`);
			shellVersion < 40 ? clearButton.set_relief(Gtk.ReliefStyle.NONE) : clearButton.set_has_frame(false);
			const settingKey = keysToClear[idx - 1];

			clearButton.set_sensitive(this._settings.get_strv(settingKey)[0]);

			clearButton.connect("clicked", btn => {
				this._settings.set_strv(settingKey, []);
				btn.set_sensitive(false);
			});

			this._settings.connect("changed::" + settingKey, () => {
				this._settings.get_strv(settingKey)[0] && clearButton.set_sensitive(true);
			});
		};

		// hide certain widgets since some features are not supported on older versions
		if (shellVersion < 3.36) {
			const hiddenWidgetsPre336 = ["TilingPopupGtkListBoxRow", "ToggleTilingPopupGtkBox", "TileEditingModeGtkBox"
					, "TilingPopupCurrentWorkspaceGtkListBoxRow", "TileEditingModeFocusColorGtkListBoxRow"];
			hiddenWidgetsPre336.forEach(w => this._builder.get_object(w).set_visible(false));
		}
	},

	// widgets in prefs.ui need to have same ID as the keys in the gschema.xml file
	_bindWidgetsToSettings: function(settingsKeys) {
		const ints = ["window-gap", "toggle-maximize-tophalf-timer", "vertical-preview-area", "horizontal-preview-area"];
		const bools = ["enable-tiling-popup", "enable-tile-animations", "enable-untile-animations"
				, "enable-raise-tile-group", "enable-hold-maximize-inverse-landscape", "enable-hold-maximize-inverse-portrait"
				, "maximize-with-gap", "tiling-popup-current-workspace-only", "default-to-secondary-tiling-preview"];
		const enums = ["restore-window-size-on", "dynamic-keybinding-behaviour", "secondary-tiling-preview-activator"];
		const colors = ["tile-editing-mode-color"];

		const getBindProperty = function(key) {
			if (ints.includes(key))
				return "value"; // Gtk.Spinbox.value
			else if (bools.includes(key))
				return "active"; //  Gtk.Switch.active
			else
				return null;
		}

		// int & bool settings
		settingsKeys.forEach(key => {
			const bindProperty = getBindProperty(key);
			const widget = this._builder.get_object(key);
			if (widget && bindProperty)
				this._settings.bind(key, widget, bindProperty, Gio.SettingsBindFlags.DEFAULT);
		});

		// enum settings
		enums.forEach(key => {
			const widget = this._builder.get_object(key);
			widget.set_active(this._settings.get_enum(key));
			widget.connect("changed", src => this._settings.set_enum(key, widget.get_active()));
		});

		// color buttons settings
		colors.forEach(key => {
			const widget = this._builder.get_object(key);
			const color = new Gdk.RGBA();
			color.parse(this._settings.get_string(key));
			widget.set_rgba(color);
			widget.connect("color-set", w => this._settings.set_string(key, w.get_rgba().to_string()));
		});
	},

	_bindKeybindings: function() {
		const shortcuts = Object.values(TILING);
		shortcuts.forEach(sc => this._makeShortcutEdit(sc));
	},

	// taken from Overview-Improved by human.experience
	// https://extensions.gnome.org/extension/2802/overview-improved/
	_makeShortcutEdit: function(settingKey, treeView, listStore) {
		const COLUMN_KEY = 0;
		const COLUMN_MODS = 1;

		const view = treeView || this._builder.get_object(settingKey + "-treeview");
		const store = listStore || this._builder.get_object(settingKey + "-liststore");
		const iter = store.append();
		const renderer = new Gtk.CellRendererAccel({xalign: 1, editable: true});
		const column = new Gtk.TreeViewColumn();
		column.pack_start(renderer, true);
		column.add_attribute(renderer, "accel-key", COLUMN_KEY);
		column.add_attribute(renderer, "accel-mods", COLUMN_MODS);
		view.append_column(column);

		const updateShortcutRow = (accel) => {
			// compatibility GNOME 40: GTK4's func returns 3 values / GTK3's only 2
			const array = accel ? Gtk.accelerator_parse(accel) : [0, 0];
			const [key, mods] = [array[array.length - 2], array[array.length - 1]];
			store.set(iter, [COLUMN_KEY, COLUMN_MODS], [key, mods]);
		};

		renderer.connect("accel-edited", (renderer, path, key, mods, hwCode) => {
			const accel = Gtk.accelerator_name(key, mods);
			updateShortcutRow(accel);
			this._settings.set_strv(settingKey, [accel]);
		});

		renderer.connect("accel-cleared", () => {
			updateShortcutRow(null);
			this._settings.set_strv(settingKey, []);
		});

		this._settings.connect("changed::" + settingKey, () => {
			updateShortcutRow(this._settings.get_strv(settingKey)[0]);
		});

		updateShortcutRow(this._settings.get_strv(settingKey)[0]);
	}
});

/* --- GTK 4 compatibility --- */

function _addChildTo(parent, child) {
	if (parent instanceof Gtk.Box || parent instanceof Gtk.ListBox)
		shellVersion < 40 ? parent.add(child) : parent.append(child);

	else if (parent instanceof Gtk.ListBoxRow || parent instanceof Gtk.ScrolledWindow || parent instanceof Gtk.Frame || parent instanceof Gtk.Overlay)
		shellVersion < 40 ? parent.add(child) : parent.set_child(child);
};
