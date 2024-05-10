import { Gio, GLib, Meta, Shell } from '../dependencies/gi.js';
import { Extension, Main } from '../dependencies/shell.js';

/** @type {Settings} */
let SINGLETON = null;

function enable() {
    SINGLETON = new Settings();
}

function disable() {
    SINGLETON.destroy();
    SINGLETON = null;
}

/**
 * A utility class that exposes gsettings via getter and setter methods for
 * easier 'typing'. Additionally, the class allows to `watch` for gsettings
 * changes, to `registerShortcut`, and to `override` GNOME's native gsettings.
 * When the extension gets disabled, this class removes the watchers, shortcuts,
 * and overrides.
 */
class Settings {
    /**
     * @type {boolean} determines if the settings overrides have been properly
     * reverted via the extensions `disable` the last time the extension was
     * enabled. There are circumstances, when an extension's `disable` method
     * isn't called e. g. when the system shuts down or when gnome-shell crashes.
     */
    _didntRevertPreviously;
    /** @type {Gio.Settings} */
    _gioObject = Extension.lookupByURL(import.meta.url).getSettings();
    /** @type {string[]} */
    _registeredShortcuts = [];
    /**
     * @type {Map<string, Map<string, GLib.Variant>>} saves the native settings
     * that have been overridden in the extensions `enable` call. The key is the
     * schema_id of the overridden Gio.Settings. The value is a Map of the
     * overridden key and the settings old value.
     */
    _runtimeOverriddes = new Map();
    /** @type {number[]} */
    _watchIds = [];
    /** @type {WeakMap<object, number[]>} */
    _watchTrackers = new WeakMap();

    constructor() {
        this._didntRevertPreviously =
            this._gioObject.get_user_value('overridden-settings') !== null;
    }

    destroy() {
        this._registeredShortcuts.forEach(shortcut => Main.wm.removeKeybinding(shortcut));
        this._registeredShortcuts = [];

        this._clearOverriddenSettings();

        this._watchIds.forEach(id => this._gioObject.disconnect(id));
        this._watchIds = [];

        this._gioObject = null;
    }

    /**
     * Overrides GNOME's native settings and restores them on `disable()`.
     *
     * @param {Gio.Settings} settings
     * @param {string} key
     * @param {GLib.Variant} newValue
     */
    override(settings, key, newValue) {
        const schemaId = settings.schema_id;
        const userValue = settings.get_user_value(key);
        const oldSettingsMap = this._runtimeOverriddes.get(schemaId);

        if (oldSettingsMap)
            oldSettingsMap.set(key, userValue);
        else
            this._runtimeOverriddes.set(schemaId, new Map([[key, userValue]]));

        this._updateBackupOverrides(schemaId, key, userValue);
        settings.set_value(key, newValue);
    }

    /**
     * @param {object} param
     * @param {string} param.key
     * @param {Function} param.handler
     * @param {Meta.KeyBindingFlags} [param.flags]
     * @param {Shell.ActionMode} [param.modes]
     */
    registerShortcut({
        key,
        handler,
        flags = Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
        modes = Shell.ActionMode.NORMAL
    }) {
        if (Main.wm.addKeybinding(
            key,
            this._gioObject,
            flags,
            modes,
            handler
        ))
            this._registeredShortcuts.push(key);
    }

    /**
     * @param {string} key
     */
    unregisterShortcut(key) {
        const idx = this._registeredShortcuts.indexOf(key);

        if (idx !== -1) {
            Main.wm.removeKeybinding(key);
            this._registeredShortcuts.splice(idx, 1);
        }
    }

    /**
     * @param {string} key
     * @param {Function} fn
     * @param {object} param
     * @param {object} [param.tracker]
     * @param {boolean} [param.immediate]
     *
     * @returns {number}
     */
    watch(key, fn, { tracker = null, immediate = false } = {}) {
        const id = this._gioObject.connect(`changed::${key}`, () =>
            fn(this, key)
        );

        if (immediate)
            fn(this, key);

        this._watchIds.push(id);

        if (tracker) {
            const trackedIds = this._watchTrackers.get(tracker) ?? [];

            trackedIds.push(id);
            this._watchTrackers.set(tracker, trackedIds);
        }

        return id;
    }

    /**
     * @param {number|object} idOrTracker - if a number, disconnect only that
     *      signal. If it's an object, disconnect all signals associated with
     *      that object.
     */
    unwatch(idOrTracker) {
        if (typeof idOrTracker === 'number') {
            const id = idOrTracker;

            if (!this._watchIds.includes(id))
                return;

            this._gioObject.disconnect(id);
            this._watchIds = this._watchIds.filter(i => i !== id);
        } else {
            const tracker = idOrTracker;
            const trackedIds = this._watchTrackers.get(tracker);

            if (!trackedIds)
                return;

            // TODO: It's possible that we track ids in the WeakMap that have
            // been disconnected via `unwatch(id)`. Since we can't iterate over
            // the WeakMap, we can't remove the ids from the tracked arrays.
            // It's not a big deal, since disconnecting an already disconnected
            // signal only logs a warning... not ideal, but better than having
            // a strong reference to an object that may have been destroyed or
            // where the Settings singleton keeps the tracker obj from being
            // gc'd cause you forgot to call `unwatch` on it.
            trackedIds.forEach(id => this._gioObject.disconnect(id));

            this._watchTrackers.delete(tracker);
            this._watchIds = this._watchIds.filter(
                id => !trackedIds.includes(id)
            );
        }
    }

    _clearOverriddenSettings() {
        if (this._didntRevertPreviously) {
            const previouslySavedSettings = this._gioObject
                .get_value('overridden-settings')
                .unpack();

            Object.entries(previouslySavedSettings).forEach(([path, value]) => {
                const splits = path.split('.');
                const key = splits.at(-1);
                const schemaId = splits.slice(0, -1).join('.');
                const gobject = new Gio.Settings({ schema_id: schemaId });
                const variant = value.get_variant();

                if (
                    variant.equal(
                        GLib.Variant.new_maybe(new GLib.VariantType('b'), null)
                    )
                )
                    gobject.reset(key);
                else
                    gobject.set_value(key, variant);
            });
        } else {
            this._runtimeOverriddes.forEach((overrides, schemaId) => {
                const gobject = new Gio.Settings({ schema_id: schemaId });

                overrides.forEach((value, key) => {
                    if (value)
                        gobject.set_value(key, value);
                    else
                        gobject.reset(key);
                });
            });
        }

        this._gioObject.reset('overridden-settings');
        this._runtimeOverriddes.clear();
    }

    _updateBackupOverrides(schemaId, key, newValue) {
        if (this._didntRevertPreviously)
            return;

        const savedSettings = this._gioObject
            .get_value('overridden-settings')
            .deepUnpack();
        const prefKey = `${schemaId}.${key}`;

        savedSettings[prefKey] =
            newValue ?? GLib.Variant.new_maybe(new GLib.VariantType('b'), null);

        this._gioObject.set_value(
            'overridden-settings',
            new GLib.Variant('a{sv}', savedSettings)
        );
    }

    /***************************************************************************
     * Getters *****************************************************************
     **************************************************************************/

    /** @returns {Gio.Settings} */
    getGioObject() {
        return this._gioObject;
    }

    /** @returns {number} */
    getActiveWindowHint() {
        return this._gioObject.get_int('active-window-hint');
    }

    /** @returns {number} */
    getActiveWindowHintBorderSize() {
        return this._gioObject.get_int('active-window-hint-border-size');
    }

    /** @returns {string} */
    getActiveWindowHintColor() {
        return this._gioObject.get_string('active-window-hint-color');
    }

    /** @returns {number} */
    getActiveWindowHintInnerBorderSize() {
        return this._gioObject.get_int('active-window-hint-inner-border-size');
    }

    /** @returns {boolean} */
    getAdaptEdgeTilingToFavoriteLayout() {
        return this._gioObject.get_boolean('adapt-edge-tiling-to-favorite-layout');
    }

    /** @returns {number} */
    getAdaptiveTilingMod() {
        return this._gioObject.get_int('move-adaptive-tiling-mod');
    }

    /** @returns {number} */
    getDefaultMoveMode() {
        return this._gioObject.get_int('default-move-mode');
    }

    /** @returns {boolean} */
    getDisableTileGroups() {
        return this._gioObject.get_boolean('disable-tile-groups');
    }

    /** @returns {number} */
    getDynamicKeybindings() {
        return this._gioObject.get_int('dynamic-keybinding-behavior');
    }

    /** @returns {boolean} */
    getEnableAdvExpSettings() {
        return this._gioObject.get_boolean('enable-advanced-experimental-features');
    }

    /** @returns {boolean} */
    getEnableHoldInverseLandscape() {
        return this._gioObject.get_boolean('enable-hold-maximize-inverse-landscape');
    }

    /** @returns {boolean} */
    getEnableHoldInversePortrait() {
        return this._gioObject.get_boolean('enable-hold-maximize-inverse-portrait');
    }

    /** @returns {boolean} */
    getEnableRaiseTileGroups() {
        return this._gioObject.get_boolean('enable-raise-tile-group');
    }

    /** @returns {boolean} */
    getEnableTileAnimations() {
        return this._gioObject.get_boolean('enable-tile-animations');
    }

    /** @returns {boolean} */
    getEnableTilingPopup() {
        return this._gioObject.get_boolean('enable-tiling-popup');
    }

    /** @returns {boolean} */
    getEnableUntileAnimations() {
        return this._gioObject.get_boolean('enable-untile-animations');
    }

    /** @returns {number} */
    getFavoriteLayoutMod() {
        return this._gioObject.get_int('move-favorite-layout-mod');
    }

    /** @returns {string[]} */
    getFavoriteLayouts() {
        return this._gioObject.get_strv('favorite-layouts');
    }

    /** @returns {number} */
    getHorizontalPreviewArea() {
        return this._gioObject.get_int('horizontal-preview-area');
    }

    /** @returns {number} */
    getIgnoreTaMod() {
        return this._gioObject.get_int('ignore-ta-mod');
    }

    /** @returns {number} */
    getLastVersionInstalled() {
        return this._gioObject.get_int('last-version-installed');
    }

    /** @returns {boolean} */
    getLowPerformanceMoveMode() {
        return this._gioObject.get_boolean('low-performance-move-mode');
    }

    /** @returns {boolean} */
    getMaximizeWithGaps() {
        return this._gioObject.get_boolean('maximize-with-gap');
    }

    /** @returns {boolean} */
    getMonitorSwitchGracePeriod() {
        return this._gioObject.get_boolean('monitor-switch-grace-period');
    }

    /** @returns {number} */
    getScreenTopGap() {
        return this._gioObject.get_int('screen-top-gap');
    }

    /** @returns {number} */
    getScreenLeftGap() {
        return this._gioObject.get_int('screen-left-gap');
    }

    /** @returns {number} */
    getScreenRightGap() {
        return this._gioObject.get_int('screen-right-gap');
    }

    /** @returns {number} */
    getScreenBottomGap() {
        return this._gioObject.get_int('screen-bottom-gap');
    }

    /** @returns {boolean} */
    getShowLayoutIndicator() {
        return this._gioObject.get_boolean('show-layout-panel-indicator');
    }

    /** @returns {number} */
    getSingleScreenGap() {
        return this._gioObject.get_int('single-screen-gap');
    }

    /** @returns {boolean} */
    getTilegroupsInAppSwitcher() {
        return this._gioObject.get_boolean('tilegroups-in-app-switcher');
    }

    /** @returns {boolean} */
    getTilingPopupAllWorkspaces() {
        return this._gioObject.get_boolean('tiling-popup-all-workspace');
    }

    /** @returns {number} */
    getToggleMaximizeTophalfTimer() {
        return this._gioObject.get_int('toggle-maximize-tophalf-timer');
    }

    /** @returns {number} */
    getVerticalPreviewArea() {
        return this._gioObject.get_int('vertical-preview-area');
    }

    /** @returns {number} */
    getWindowGap() {
        return this._gioObject.get_int('window-gap');
    }

    /***************************************************************************
     * Setters *****************************************************************
     **************************************************************************/

    /** @param {string} value */
    setActiveWindowHintColor(value) {
        this._gioObject.set_string('active-window-hint-color', value);
    }

    /** @param {boolean} value */
    setEnableTilingPopup(value) {
        this._gioObject.set_boolean('enable-tiling-popup', value);
    }

    /** @param {string[]} value */
    setFavoriteLayouts(value) {
        this._gioObject.set_strv('favorite-layouts', value);
    }

    /** @param {number} value */
    setLastVersionInstalled(value) {
        this._gioObject.set_int('last-version-installed', value);
    }
}

export { enable, disable, SINGLETON as Settings };
