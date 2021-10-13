'use strict';

/**
 * Helper classes / enums for the settings.xml used in the extension files
 * *and* prefs files
 */

/**
 * A Singleton providing access to the settings.
 */
var Settings = class Settings { // eslint-disable-line no-unused-vars

    static _settings;

    static ENABLE_TILING_POPUP = 'enable-tiling-popup';
    static RAISE_TILE_GROUPS = 'enable-raise-tile-group';
    static DYNAMIC_KEYBINDINGS_BEHAVIOUR = 'dynamic-keybinding-behaviour';
    static WINDOW_GAP = 'window-gap';
    static MAXIMIZE_WITH_GAPS = 'maximize-with-gap';
    static RESTORE_SIZE_ON = 'restore-window-size-on';
    static ENABLE_HOLD_INVERSE_LANDSCAPE = 'enable-hold-maximize-inverse-landscape';
    static ENABLE_HOLD_INVERSE_PORTRAIT = 'enable-hold-maximize-inverse-portrait';
    static ENABLE_ADV_EXP_SETTINGS = 'enable-advanced-experimental-features';
    static CURR_WORKSPACE_ONLY = 'tiling-popup-current-workspace-only';
    static TILE_EDITING_MODE_COLOR = 'tile-editing-mode-color';
    static SECONDARY_PREVIEW_ACTIVATOR = 'secondary-tiling-preview-activator';
    static DEFAULT_TO_SECONDARY_PREVIEW = 'default-to-secondary-tiling-preview';
    static ENABLE_TILE_ANIMATIONS = 'enable-tile-animations';
    static ENABLE_UNTILE_ANIMATIONS = 'enable-untile-animations';
    static INVERSE_TOP_MAXIMIZE_TIMER = 'toggle-maximize-tophalf-timer';
    static VERTICAL_PREVIEW_AREA = 'vertical-preview-area';
    static HORIZONTAL_PREVIEW_AREA = 'horizontal-preview-area';

    static initialize() {
        const ExtensionUtils = imports.misc.extensionUtils;
        const Me = ExtensionUtils.getCurrentExtension();
        this._settings = ExtensionUtils.getSettings(Me.metadata['settings-schema']);
    }

    static destroy() {
        this._settings.run_dispose();
    }

    /**
     * @returns {Gio.Settings} the Gio.Settings object.
     */
    static getGioObject() {
        return this._settings;
    }

    /**
     * @returns {string[]} the settings keys except the ones for shortcuts and
     *      Popup Layouts.
     */
    static getAllKeys() {
        return [
            this.ENABLE_TILING_POPUP,
            this.RAISE_TILE_GROUPS,
            this.DYNAMIC_KEYBINDINGS_BEHAVIOUR,
            this.WINDOW_GAP,
            this.MAXIMIZE_WITH_GAPS,
            this.RESTORE_SIZE_ON,
            this.ENABLE_HOLD_INVERSE_LANDSCAPE,
            this.ENABLE_HOLD_INVERSE_PORTRAIT,
            this.CURR_WORKSPACE_ONLY,
            this.TILE_EDITING_MODE_COLOR,
            this.SECONDARY_PREVIEW_ACTIVATOR,
            this.DEFAULT_TO_SECONDARY_PREVIEW,
            this.ENABLE_TILE_ANIMATIONS,
            this.ENABLE_UNTILE_ANIMATIONS,
            this.INVERSE_TOP_MAXIMIZE_TIMER,
            this.VERTICAL_PREVIEW_AREA,
            this.HORIZONTAL_PREVIEW_AREA
        ];
    }

    /**
     * Getters
     */

    static getEnum(key) {
        return this._settings.get_enum(key);
    }

    static getString(key) {
        return this._settings.get_string(key);
    }

    static getStrv(key) {
        return this._settings.get_strv(key);
    }

    static getInt(key) {
        return this._settings.get_int(key);
    }

    static getBoolean(key) {
        return this._settings.get_boolean(key);
    }

    /**
     * Setters
     */

    static setEnum(key, value) {
        this._settings.set_enum(key, value);
    }

    static setString(key, value) {
        this._settings.set_string(key, value);
    }

    static setStrv(key, value) {
        this._settings.set_strv(key, value);
    }

    static setInt(key, value) {
        this._settings.set_int(key, value);
    }

    static setBoolean(key, value) {
        this._settings.set_boolean(key, value);
    }
};

/**
 * A Singleton providing access to the shortcut keys except the
 * ones related to Popup Layouts.
 */
var Shortcuts = class Shortcuts { // eslint-disable-line no-unused-vars

    static TOGGLE_POPUP = 'toggle-tiling-popup';
    static EDIT_MODE = 'tile-edit-mode';
    static AUTO_FILL = 'auto-tile';
    static MAXIMIZE = 'tile-maximize';
    static TOP = 'tile-top-half';
    static BOTTOM = 'tile-bottom-half';
    static LEFT = 'tile-left-half';
    static RIGHT = 'tile-right-half';
    static TOP_LEFT = 'tile-topleft-quarter';
    static TOP_RIGHT = 'tile-topright-quarter';
    static BOTTOM_LEFT = 'tile-bottomleft-quarter';
    static BOTTOM_RIGHT = 'tile-bottomright-quarter';
    static DEBUGGING = 'debugging-show-tiled-rects';
    static DEBUGGING_FREE_RECTS = 'debugging-free-rects';

    /**
     * @returns {string[]} the settings keys for the shortcuts in the same
     *      order as they appear in the preference window.
     */
    static getAllKeys() {
        return [
            this.TOGGLE_POPUP,
            this.EDIT_MODE,
            this.AUTO_FILL,
            this.MAXIMIZE,
            this.TOP,
            this.BOTTOM,
            this.LEFT,
            this.RIGHT,
            this.TOP_LEFT,
            this.TOP_RIGHT,
            this.BOTTOM_LEFT,
            this.BOTTOM_RIGHT,
            this.DEBUGGING,
            this.DEBUGGING_FREE_RECTS
        ];
    }
};

// Enums:
var RestoreOn = class RestoreWindowSizeBehaviour { // eslint-disable-line no-unused-vars

    static ON_GRAB_START = 'Grab Start';
    static ON_GRAB_END = 'Grab End';
};

var DynamicKeybindings = class DynamicKeybindingBehaviour { // eslint-disable-line no-unused-vars

    static DISABLED = 'Disabled';
    static FOCUS = 'Focus';
    static TILING_STATE = 'Tiling State';
    static TILING_STATE_WINDOWS = 'Tiling State (Windows)';
};

var AlternatePreviewMod = class SecondaryPreviewActivator { // eslint-disable-line no-unused-vars

    static CTRL = 'Ctrl';
    static ALT = 'Alt';
    static RMB = 'RMB';
};

var Orientation = class Orientation { // eslint-disable-line no-unused-vars

    static H = 1;
    static V = 2;
};

var Direction = class Direction { // eslint-disable-line no-unused-vars

    static N = 1;
    static E = 2;
    static S = 4;
    static W = 8;

    static opposite(dir) {
        let opposite = 0;
        if (dir & this.N)
            opposite |= this.S;
        if (dir & this.S)
            opposite |= this.N;
        if (dir & this.W)
            opposite |= this.E;
        if (dir & this.E)
            opposite |= this.W;

        return opposite;
    }
};

// Classes for popup layouts:
// See src/prefs/layoutsPrefs.js for details on layouts.
var Layout = class Layout { // eslint-disable-line no-unused-vars

    /**
     * @param {object} layout is the parsed object from the layouts file.
     */
    constructor(layout = null) {
        this._name = layout?._name ?? '';
        this._items = layout?._items ?? [];
    }

    /**
     * @returns {string}
     */
    getName() {
        return this._name;
    }

    /**
     * @param {string} name
     */
    setName(name) {
        this._name = name;
    }

    /**
     * @param {number} index
     * @returns {LayoutItem}
     */
    getItem(index) {
        return this._items[index];
    }

    /**
     * @param {LayoutItem|null} item
     * @returns {LayoutItem} the added item.
     */
    addItem(item = null) {
        item = item ?? new LayoutItem();
        this._items.push(item);
        return item;
    }

    /**
     * @param {number} index
     * @returns {LayoutItem|null} the removed item.
     */
    removeItem(index) {
        return this._items.splice(index, 1)[0];
    }

    /**
     * @param {boolean} filterOutEmptyRects
     * @returns {LayoutItem[]}
     */
    getItems(filterOutEmptyRects = true) {
        return filterOutEmptyRects
            ? this._items.filter(i => Object.keys(i.rect).length === 4)
            : this._items;
    }

    /**
     * @param {LayoutItem[]} items
     */
    setItems(items) {
        this._items = items;
    }

    /**
     * @param {boolean} filterOutEmptyRects
     * @returns {number}
     */
    getItemCount(filterOutEmptyRects = false) {
        return filterOutEmptyRects
            ? this.getItems().length
            : this._items.length;
    }

    /**
     * @returns {[boolean, string]} wether the layout has valid rects and
     *      a potential error message.
     */
    validate() {
        const rects = this.getItems().map(i => i.rect);
        if (!rects.length)
            return [false, 'No valid rectangles defined.', -1];

        const getOverlapArea = function(r1, r2) {
            return Math.max(0, Math.min(r1.x + r1.width, r2.x + r2.width) - Math.max(r1.x, r2.x))
                    * Math.max(0, Math.min(r1.y + r1.height, r2.y + r2.height) - Math.max(r1.y, r2.y));
        };

        for (let i = 0; i < rects.length; i++) {
            const rect = rects[i];

            if (rect.width <= 0 || rect.width > 1)
                return [false, `Rectangle ${i} has an invalid width.`, i];

            if (rect.height <= 0 || rect.height > 1)
                return [false, `Rectangle ${i} has an invalid height.`, i];

            if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > 1 || rect.y + rect.height > 1)
                return [false, `Rectangle ${i} extends beyond the screen.`, i];

            for (let j = i + 1; j < rects.length; j++) {
                if (getOverlapArea(rect, rects[j]) !== 0)
                    return [false, `Rectangles ${i} and ${j} overlap.`, j];
            }
        }

        return [true, '', -1];
    }
};

var LayoutItem = class LayoutItem {

    constructor() {
        this.rect = {};
        this.appId = null;
        this.loopType = null;
    }
};
