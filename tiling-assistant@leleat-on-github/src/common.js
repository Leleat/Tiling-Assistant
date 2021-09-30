"use strict";

/**
 * Helper classes / enums for the settings.xml used in the extension files AND prefs
 */

// "normal" keys
var Settings = class Settings {

	static _settings;

	static ENABLE_TILING_POPUP = "enable-tiling-popup";
	static RAISE_TILE_GROUPS = "enable-raise-tile-group";
	static DYNAMIC_KEYBINDINGS_BEHAVIOUR = "dynamic-keybinding-behaviour";
	static WINDOW_GAP = "window-gap";
	static MAXIMIZE_WITH_GAPS = "maximize-with-gap";
	static RESTORE_SIZE_ON = "restore-window-size-on";
	static ENABLE_HOLD_INVERSE_LANDSCAPE = "enable-hold-maximize-inverse-landscape";
	static ENABLE_HOLD_INVERSE_PORTRAIT = "enable-hold-maximize-inverse-portrait";
	static CURR_WORKSPACE_ONLY = "tiling-popup-current-workspace-only"
	static TILE_EDITING_MODE_COLOR = "tile-editing-mode-color";
	static SECONDARY_PREVIEW_ACTIVATOR = "secondary-tiling-preview-activator";
	static DEFAULT_TO_SECONDARY_PREVIEW = "default-to-secondary-tiling-preview";
	static ENABLE_TILE_ANIMATIONS = "enable-tile-animations";
	static ENABLE_UNTILE_ANIMATIONS = "enable-untile-animations";
	static INVERSE_TOP_MAXIMIZE_TIMER = "toggle-maximize-tophalf-timer";
	static VERTICAL_PREVIEW_AREA = "vertical-preview-area";
	static HORIZONTAL_PREVIEW_AREA = "horizontal-preview-area";

	static initialize() {
		const ExtensionUtils = imports.misc.extensionUtils;
		const Me = ExtensionUtils.getCurrentExtension();
		this._settings = ExtensionUtils.getSettings(Me.metadata["settings-schema"]);
	};

	static destroy() {
		this._settings.run_dispose();
	};

	static getGioObject() {
		return this._settings;
	};

	static getAllKeys() {
		return [
			this.ENABLE_TILING_POPUP
			, this.RAISE_TILE_GROUPS
			, this.DYNAMIC_KEYBINDINGS_BEHAVIOUR
			, this.WINDOW_GAP
			, this.MAXIMIZE_WITH_GAPS
			, this.RESTORE_SIZE_ON
			, this.ENABLE_HOLD_INVERSE_LANDSCAPE
			, this.ENABLE_HOLD_INVERSE_PORTRAIT
			, this.CURR_WORKSPACE_ONLY
			, this.TILE_EDITING_MODE_COLOR
			, this.SECONDARY_PREVIEW_ACTIVATOR
			, this.DEFAULT_TO_SECONDARY_PREVIEW
			, this.ENABLE_TILE_ANIMATIONS
			, this.ENABLE_UNTILE_ANIMATIONS
			, this.INVERSE_TOP_MAXIMIZE_TIMER
			, this.VERTICAL_PREVIEW_AREA
			, this.HORIZONTAL_PREVIEW_AREA
		];
	};

	/**
	 * Getters
	 */

	static getEnum(key) {
		return this._settings.get_enum(key);
	};

	static getString(key) {
		return this._settings.get_string(key);
	};

	static getStrv(key) {
		return this._settings.get_strv(key);
	};

	static getInt(key) {
		return this._settings.get_int(key);
	};

	static getBoolean(key) {
		return this._settings.get_boolean(key);
	};

	/**
	 * Setters
	 */
	
	static setEnum(key, value) {
		this._settings.set_enum(key, value);
	};

	static setString(key, value) {
		this._settings.set_string(key, value);
	};

	static setStrv(key, value) {
		this._settings.set_strv(key, value);
	};

	static setInt(key, value) {
		this._settings.set_int(key, value);
	};

	static setBoolean(key, value) {
		this._settings.set_boolean(key, value);
	};
};

// shortcut keys:
var Shortcuts = class Shortcuts {

	static TOGGLE_POPUP = "toggle-tiling-popup";
	static EDIT_MODE = "tile-edit-mode";
	static AUTO_FILL = "auto-tile";
	static MAXIMIZE = "tile-maximize";
	static TOP = "tile-top-half";
	static BOTTOM = "tile-bottom-half";
	static LEFT = "tile-left-half";
	static RIGHT = "tile-right-half";
	static TOP_LEFT = "tile-topleft-quarter";
	static TOP_RIGHT = "tile-topright-quarter";
	static BOTTOM_LEFT = "tile-bottomleft-quarter";
	static BOTTOM_RIGHT = "tile-bottomright-quarter";
	static DEBUGGING = "debugging-show-tiled-rects";
	static DEBUGGING_FREE_RECTS = "debugging-free-rects";

	// should be in the same order as in the settings page
	static getAllKeys() {
		return [
			this.TOGGLE_POPUP
			, this.EDIT_MODE
			, this.AUTO_FILL
			, this.MAXIMIZE
			, this.TOP
			, this.BOTTOM
			, this.LEFT
			, this.RIGHT
			, this.TOP_LEFT
			, this.TOP_RIGHT
			, this.BOTTOM_LEFT
			, this.BOTTOM_RIGHT
			, this.DEBUGGING
			, this.DEBUGGING_FREE_RECTS
		];
	};
};

// enums:
var RestoreOn = class RestoreWindowSizeBehaviour {

	static ON_GRAB_START = "Grab Start";
	static ON_GRAB_END = "Grab End";
};

var DynamicKeybindings = class DynamicKeybindingBehaviour {

	static DISABLED = "Disabled";
	static FOCUS = "Focus";
	static TILING_STATE = "Tiling State";
	static TILING_STATE_WINDOWS = "Tiling State (Windows)";
};

var AlternatePreviewMod = class SecondaryPreviewActivator {

	static CTRL = "Ctrl";
	static ALT = "Alt";
	static RMB = "RMB";
};
