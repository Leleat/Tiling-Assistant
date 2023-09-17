/**
 * Helper classes / enums for the settings.xml used in the extension files
 * *and* prefs files
 */

/**
 * A Singleton providing access to the settings.
 */
export class Settings {
    static _settings;
    static ENABLE_TILING_POPUP = 'enable-tiling-popup';
    static POPUP_ALL_WORKSPACES = 'tiling-popup-all-workspace';
    static RAISE_TILE_GROUPS = 'enable-raise-tile-group';
    static TILEGROUPS_IN_APP_SWITCHER = 'tilegroups-in-app-switcher';
    static WINDOW_GAP = 'window-gap';
    static SINGLE_SCREEN_GAP = 'single-screen-gap';
    static SCREEN_TOP_GAP = 'screen-top-gap';
    static SCREEN_LEFT_GAP = 'screen-left-gap';
    static SCREEN_RIGHT_GAP = 'screen-right-gap';
    static SCREEN_BOTTOM_GAP = 'screen-bottom-gap';
    static MAXIMIZE_WITH_GAPS = 'maximize-with-gap';
    static DYNAMIC_KEYBINDINGS = 'dynamic-keybinding-behavior';
    static ACTIVE_WINDOW_HINT = 'active-window-hint';
    static ACTIVE_WINDOW_HINT_COLOR = 'active-window-hint-color';
    static ACTIVE_WINDOW_HINT_BORDER_SIZE = 'active-window-hint-border-size';
    static ACTIVE_WINDOW_HINT_INNER_BORDER_SIZE = 'active-window-hint-inner-border-size';
    static SHOW_LAYOUT_INDICATOR = 'show-layout-panel-indicator';
    static ENABLE_ADV_EXP_SETTINGS = 'enable-advanced-experimental-features';
    static DISABLE_TILE_GROUPS = 'disable-tile-groups';
    static ENABLE_TILE_ANIMATIONS = 'enable-tile-animations';
    static ENABLE_UNTILE_ANIMATIONS = 'enable-untile-animations';
    static FAVORITE_LAYOUTS = 'favorite-layouts';
    static DEFAULT_MOVE_MODE = 'default-move-mode';
    static LOW_PERFORMANCE_MOVE_MODE = 'low-performance-move-mode';
    static MONITOR_SWITCH_GRACE_PERIOD = 'monitor-switch-grace-period';
    static ADAPT_EDGE_TILING_TO_FAVORITE_LAYOUT = 'adapt-edge-tiling-to-favorite-layout';
    static ADAPTIVE_TILING_MOD = 'move-adaptive-tiling-mod';
    static FAVORITE_LAYOUT_MOD = 'move-favorite-layout-mod';
    static IGNORE_TA_MOD = 'ignore-ta-mod';
    static VERTICAL_PREVIEW_AREA = 'vertical-preview-area';
    static HORIZONTAL_PREVIEW_AREA = 'horizontal-preview-area';
    static INVERSE_TOP_MAXIMIZE_TIMER = 'toggle-maximize-tophalf-timer';
    static ENABLE_HOLD_INVERSE_LANDSCAPE = 'enable-hold-maximize-inverse-landscape';
    static ENABLE_HOLD_INVERSE_PORTRAIT = 'enable-hold-maximize-inverse-portrait';
    static RESTORE_SIZE_ON = 'restore-window-size-on';

    static initialize(gioSettings) {
        this._settings = gioSettings;
    }

    static destroy() {
        this._settings = null;
    }

    /**
     * @returns {Gio.Settings} the Gio.Settings object.
     */
    static getGioObject() {
        return this._settings;
    }

    /**
     * Listens for the change of a setting.
     *
     * @param {string} key a settings key.
     * @param {*} func function to call when the setting changed.
     */
    static changed(key, func) {
        return this._settings.connect(`changed::${key}`, func);
    }

    static disconnect(id) {
        this._settings.disconnect(id);
    }

    /**
     * @returns {string[]} the settings keys except the ones for shortcuts.
     */
    static getAllKeys() {
        return [
            this.ENABLE_TILING_POPUP,
            this.POPUP_ALL_WORKSPACES,
            this.RAISE_TILE_GROUPS,
            this.TILEGROUPS_IN_APP_SWITCHER,
            this.WINDOW_GAP,
            this.SINGLE_SCREEN_GAP,
            this.SCREEN_TOP_GAP,
            this.SCREEN_LEFT_GAP,
            this.SCREEN_RIGHT_GAP,
            this.SCREEN_BOTTOM_GAP,
            this.MAXIMIZE_WITH_GAPS,
            this.DYNAMIC_KEYBINDINGS,
            this.ACTIVE_WINDOW_HINT,
            this.ACTIVE_WINDOW_HINT_COLOR,
            this.ACTIVE_WINDOW_HINT_BORDER_SIZE,
            this.ACTIVE_WINDOW_HINT_INNER_BORDER_SIZE,
            this.SHOW_LAYOUT_INDICATOR,
            this.ENABLE_ADV_EXP_SETTINGS,
            this.DISABLE_TILE_GROUPS,
            this.ENABLE_TILE_ANIMATIONS,
            this.ENABLE_UNTILE_ANIMATIONS,
            this.FAVORITE_LAYOUTS,
            this.DEFAULT_MOVE_MODE,
            this.LOW_PERFORMANCE_MOVE_MODE,
            this.MONITOR_SWITCH_GRACE_PERIOD,
            this.ADAPT_EDGE_TILING_TO_FAVORITE_LAYOUT,
            this.ADAPTIVE_TILING_MOD,
            this.FAVORITE_LAYOUT_MOD,
            this.IGNORE_TA_MOD,
            this.VERTICAL_PREVIEW_AREA,
            this.HORIZONTAL_PREVIEW_AREA,
            this.INVERSE_TOP_MAXIMIZE_TIMER,
            this.ENABLE_HOLD_INVERSE_LANDSCAPE,
            this.ENABLE_HOLD_INVERSE_PORTRAIT,
            this.RESTORE_SIZE_ON
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

    static getValue(key) {
        return this._settings.get_value(key);
    }

    static getUserValue(key) {
        return this._settings.get_user_value(key);
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

    static setValue(key, value) {
        return this._settings.set_value(key, value);
    }

    static reset(key) {
        this._settings.reset(key);
    }
}

/**
 * A Singleton providing access to the shortcut keys except the
 * ones related to the Layouts.
 */
export class Shortcuts {
    static TOGGLE_POPUP = 'toggle-tiling-popup';
    static EDIT_MODE = 'tile-edit-mode';
    static AUTO_FILL = 'auto-tile';
    static ALWAYS_ON_TOP = 'toggle-always-on-top';
    static MAXIMIZE = 'tile-maximize';
    static MAXIMIZE_V = 'tile-maximize-vertically';
    static MAXIMIZE_H = 'tile-maximize-horizontally';
    static RESTORE_WINDOW = 'restore-window';
    static CENTER_WINDOW = 'center-window';
    static TOP = 'tile-top-half';
    static BOTTOM = 'tile-bottom-half';
    static LEFT = 'tile-left-half';
    static RIGHT = 'tile-right-half';
    static TOP_LEFT = 'tile-topleft-quarter';
    static TOP_RIGHT = 'tile-topright-quarter';
    static BOTTOM_LEFT = 'tile-bottomleft-quarter';
    static BOTTOM_RIGHT = 'tile-bottomright-quarter';
    static TOP_IGNORE_TA = 'tile-top-half-ignore-ta';
    static BOTTOM_IGNORE_TA = 'tile-bottom-half-ignore-ta';
    static LEFT_IGNORE_TA = 'tile-left-half-ignore-ta';
    static RIGHT_IGNORE_TA = 'tile-right-half-ignore-ta';
    static TOP_LEFT_IGNORE_TA = 'tile-topleft-quarter-ignore-ta';
    static TOP_RIGHT_IGNORE_TA = 'tile-topright-quarter-ignore-ta';
    static BOTTOM_LEFT_IGNORE_TA = 'tile-bottomleft-quarter-ignore-ta';
    static BOTTOM_RIGHT_IGNORE_TA = 'tile-bottomright-quarter-ignore-ta';
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
            this.ALWAYS_ON_TOP,
            this.MAXIMIZE,
            this.MAXIMIZE_V,
            this.MAXIMIZE_H,
            this.RESTORE_WINDOW,
            this.CENTER_WINDOW,
            this.TOP,
            this.BOTTOM,
            this.LEFT,
            this.RIGHT,
            this.TOP_LEFT,
            this.TOP_RIGHT,
            this.BOTTOM_LEFT,
            this.BOTTOM_RIGHT,
            this.TOP_IGNORE_TA,
            this.BOTTOM_IGNORE_TA,
            this.LEFT_IGNORE_TA,
            this.RIGHT_IGNORE_TA,
            this.TOP_LEFT_IGNORE_TA,
            this.TOP_RIGHT_IGNORE_TA,
            this.BOTTOM_LEFT_IGNORE_TA,
            this.BOTTOM_RIGHT_IGNORE_TA,
            this.DEBUGGING,
            this.DEBUGGING_FREE_RECTS
        ];
    }
}

// Enums:
export class RestoreOn {
    static ON_GRAB_START = 0; // Grab Start
    static ON_GRAB_END = 1; // 'Grab End'
}

export class DynamicKeybindings {
    // Order comes from prefs
    static DISABLED = 0;
    static FOCUS = 1;
    static TILING_STATE = 2;
    static TILING_STATE_WINDOWS = 3;
    static FAVORITE_LAYOUT = 4;
}

export class MoveModes {
    // Order comes from prefs
    static EDGE_TILING = 0;
    static ADAPTIVE_TILING = 1;
    static FAVORITE_LAYOUT = 2;
    static IGNORE_TA = 3;
}

export class Orientation {
    static H = 1;
    static V = 2;
}

export class Direction {
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
}

// Classes for the layouts:
// See src/prefs/layoutsPrefs.js for details on layouts.
export class Layout {
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
     * @returns {[boolean, string]} whether the layout has valid rects and
     *      a potential error message.
     */
    validate() {
        const rects = this.getItems().map(i => i.rect);
        if (!rects.length)
            return [false, 'No valid rectangles defined.', -1];

        const getOverlapArea = (r1, r2) => {
            return Math.max(0, Math.min(r1.x + r1.width, r2.x + r2.width) - Math.max(r1.x, r2.x)) *
                    Math.max(0, Math.min(r1.y + r1.height, r2.y + r2.height) - Math.max(r1.y, r2.y));
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
}

var LayoutItem = class LayoutItem {
    constructor() {
        this.rect = {};
        this.appId = null;
        this.loopType = null;
    }
};
