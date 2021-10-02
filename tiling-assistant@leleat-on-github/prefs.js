"use strict";

const {Gdk, Gio, Gtk, GObject} = imports.gi;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const LayoutPrefs = Me.imports.src.prefs.popupLayoutsPrefs.Prefs;
const {Settings, Shortcuts} = Me.imports.src.common;
const Util = Me.imports.src.prefs.utility.Util;

function init() {
	ExtensionUtils.initTranslations(Me.metadata.uuid);
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
		this._builder.add_from_file(Me.path + "/src/ui/prefs.ui");
		this.set_child(this._builder.get_object("main-prefs"));

		this.set_min_content_width(700);
		this.set_min_content_height(650);

		this._bindWidgets(Settings.getAllKeys());
		this._bindKeybindings(Shortcuts.getAllKeys());

		this._updateAdvancedSettingsVisibility();

		// LayoutPrefs manages everything related (including the
		// keyboard shortcuts) to popupLayouts on the prefs side
		this._layoutsPrefs = new LayoutPrefs(this._builder, this._settings);
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
			widget.connect("color-set", () =>
					this._settings.set_string(key, widget.get_rgba().to_string()));
		});
	};

	_bindKeybindings(shortcuts) {
		shortcuts.forEach((key, idx) => {
			// bind gui and gsettings
			const treeView = this._builder.get_object(key + "-treeview");
			const listStore = this._builder.get_object(key + "-liststore");
			Util.bindShortcut(this._settings, key, treeView, listStore);

			// bind clear-shortcut-buttons
			const clearButton = this._builder.get_object(`clear-button${idx + 1}`);
			clearButton.set_sensitive(this._settings.get_strv(key)[0]);

			clearButton.connect("clicked", () => this._settings.set_strv(key, []));
			this._settings.connect(`changed::${key}`, () =>
					clearButton.set_sensitive(this._settings.get_strv(key)[0]));
		});
	};

	_updateAdvancedSettingsVisibility() {
		const advancedWidgetIds = [
			// popupLayouts settings tab
			"popup-layouts", "popup-layouts-tab-label"
		];
		const advancedKey = Settings.ENABLE_ADV_EXP_SETTINGS;

		const updateVisibility = () => {
			const show = this._settings.get_boolean(advancedKey);
			advancedWidgetIds.forEach(id => {
				// TODO: for some reason, if the adv/exp setting is disabled and
				// the prefs window is opened, changing the setting doesn't immediately
				// update the visibilities. Only when changing the tab or toggling
				// the adv/exp setting again, does the visbility update...
				this._builder.get_object(id).set_visible(show);
			});
		};

		// bind gui switch to gsetting
		const advExpSwitch = this._builder.get_object(advancedKey);
		this._settings.bind(advancedKey, advExpSwitch, "active", Gio.SettingsBindFlags.DEFAULT);

		// update widget visibilities
		this._settings.connect(`changed::${advancedKey}`, updateVisibility.bind(this));

		updateVisibility();
	};
});
