"use strict";

const {Gdk, Gio, Gtk, GObject} = imports.gi;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const {Settings, Shortcuts} = Me.imports.src.common;

function init() {
};

function buildPrefsWidget() {
	return new PrefsWidget();
};

const PrefsWidget = GObject.registerClass(class TilingAssistantPrefs extends Gtk.ScrolledWindow {

	_init(params) {
		super._init(params);

		// use a new settings object instead of the "global" src.common.Settings class
		// , so I don't have to keep track of the signal connections, which would need
		// cleanup after the prefs window was closed
		this._settings = ExtensionUtils.getSettings(Me.metadata["settings-schema"]);
		this.connect("destroy", () => this._settings.run_dispose());

		this._builder = new Gtk.Builder();
		this._builder.add_from_file(Me.path + "/prefs.ui");
		const mainPrefs = this._builder.get_object("main_prefs");
		this.set_child(mainPrefs);

		this.set_min_content_width(700);
		this.set_min_content_height(650);

		this._bindWidgets(Settings.getAllKeys());
		this._bindKeybindings(Shortcuts.getAllKeys());
	};

	// widgets in prefs.ui need to have same ID as the keys in the gschema.xml file
	_bindWidgets(keys) {
		const spinButtons = [
			Settings.WINDOW_GAP
			, Settings.INVERSE_TOP_MAXIMIZE_TIMER
			, Settings.VERTICAL_PREVIEW_AREA
			, Settings.HORIZONTAL_PREVIEW_AREA
		];
		const switches = [
			Settings.ENABLE_TILING_POPUP
			, Settings.ENABLE_TILE_ANIMATIONS
			, Settings.ENABLE_UNTILE_ANIMATIONS
			, Settings.RAISE_TILE_GROUPS
			, Settings.ENABLE_HOLD_INVERSE_LANDSCAPE
			, Settings.ENABLE_HOLD_INVERSE_PORTRAIT
			, Settings.MAXIMIZE_WITH_GAPS
			, Settings.CURR_WORKSPACE_ONLY
			, Settings.DEFAULT_TO_SECONDARY_PREVIEW
		];
		const comboBoxes = [
			Settings.RESTORE_SIZE_ON
			, Settings.DYNAMIC_KEYBINDINGS_BEHAVIOUR
			, Settings.SECONDARY_PREVIEW_ACTIVATOR
		];
		const colorButtons = [
			Settings.TILE_EDITING_MODE_COLOR
		];

		const getBindProperty = function(key) {
			if (spinButtons.includes(key))
				return "value";
			else if (switches.includes(key))
				return "active";
			else
				return null;
		}

		// int & bool settings
		keys.forEach(key => {
			const widget = this._builder.get_object(key);
			const bindProperty = getBindProperty(key);
			if (widget && bindProperty)
				this._settings.bind(key, widget, bindProperty, Gio.SettingsBindFlags.DEFAULT);
		});

		// enum settings
		comboBoxes.forEach(key => {
			const widget = this._builder.get_object(key);
			widget.set_active(this._settings.get_enum(key));
			widget.connect("changed", () => this._settings.set_enum(key, widget.get_active()));
		});

		// color settings
		colorButtons.forEach(key => {
			const widget = this._builder.get_object(key);
			const color = new Gdk.RGBA();
			color.parse(this._settings.get_string(key));
			widget.set_rgba(color);
			widget.connect("color-set", w => this._settings.set_string(key, w.get_rgba().to_string()));
		});
	};

	_bindKeybindings(shortcuts) {
		// taken from Overview-Improved by human.experience
		// https://extensions.gnome.org/extension/2802/overview-improved/
		const bindShortcut = shortcutKey => {
			const COLUMN_KEY = 0;
			const COLUMN_MODS = 1;

			const view = this._builder.get_object(shortcutKey + "-treeview");
			const store =this._builder.get_object(shortcutKey + "-liststore");
			const iter = store.append();
			const renderer = new Gtk.CellRendererAccel({xalign: 1, editable: true});
			const column = new Gtk.TreeViewColumn();
			column.pack_start(renderer, true);
			column.add_attribute(renderer, "accel-key", COLUMN_KEY);
			column.add_attribute(renderer, "accel-mods", COLUMN_MODS);
			view.append_column(column);

			const updateShortcutRow = accel => {
				const [, key, mods] = accel ? Gtk.accelerator_parse(accel) : [true, 0, 0];
				store.set(iter, [COLUMN_KEY, COLUMN_MODS], [key, mods]);
			};

			renderer.connect("accel-edited", (renderer, path, key, mods, hwCode) => {
				const accel = Gtk.accelerator_name(key, mods);
				updateShortcutRow(accel);
				this._settings.set_strv(shortcutKey, [accel]);
			});

			renderer.connect("accel-cleared", () => {
				updateShortcutRow(null);
				this._settings.set_strv(shortcutKey, []);
			});

			this._settings.connect("changed::" + shortcutKey, () => {
				updateShortcutRow(this._settings.get_strv(shortcutKey)[0]);
			});

			updateShortcutRow(this._settings.get_strv(shortcutKey)[0]);
		};

		shortcuts.forEach((sc, idx) => {
			// bind gui and gsettings
			bindShortcut(sc);

			// bind clear-shortcut-buttons
			const clearButton = this._builder.get_object(`clear-button${idx + 1}`);
			clearButton.set_sensitive(this._settings.get_strv(sc)[0]);

			clearButton.connect("clicked", () => this._settings.set_strv(sc, []));
			this._settings.connect(`changed::${sc}`, () =>
					clearButton.set_sensitive(this._settings.get_strv(sc)[0]));
		});
	};
});
