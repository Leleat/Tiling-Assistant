import { Extension } from '../dependencies/shell.js';

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
    /** @type {Gio.Settings} */
    _gioObject = Extension.lookupByURL(import.meta.url).getSettings();

    destroy() {
        this._gioObject = null;
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
