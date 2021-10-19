'use strict';

const { Clutter, Meta, Shell, St } = imports.gi;
const Main = imports.ui.main;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const { Direction, DynamicKeybindings, Settings, Shortcuts } = Me.imports.src.common;
const Rect = Me.imports.src.extension.geometry.Rect;
const Util = Me.imports.src.extension.utility.Util;

const Gettext = imports.gettext;
const Domain = Gettext.domain(Me.metadata.uuid);
const _ = Domain.gettext;

/**
 * Class to handle the keyboard shortcuts (on the extension side) except the
 * ones related to the Layouts. For those, see layoutsManager.js.
 */

var Handler = class TilingKeybindingHandler {
    constructor() {
        const allowInOverview = [Shortcuts.TOGGLE_POPUP];
        this._keyBindings = Shortcuts.getAllKeys();
        this._keyBindings.forEach(key => {
            Main.wm.addKeybinding(
                key,
                Settings.getGioObject(),
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL | (allowInOverview.includes(key) && Shell.ActionMode.OVERVIEW),
                this._onCustomKeybindingPressed.bind(this, key)
            );
        });
    }

    destroy() {
        this._keyBindings.forEach(key => Main.wm.removeKeybinding(key));
        this._debuggingIndicators?.forEach(i => i.destroy());
    }

    /**
     * @param {string} shortcutName
     */
    _onCustomKeybindingPressed(shortcutName) {
        // Debugging
        const debugging = [Shortcuts.DEBUGGING, Shortcuts.DEBUGGING_FREE_RECTS];
        if (debugging.includes(shortcutName)) {
            if (this._debuggingIndicators) {
                this._debuggingIndicators.forEach(i => i.destroy());
                this._debuggingIndicators = null;
            } else {
                const createIndicators = shortcutName === Shortcuts.DEBUGGING
                    ? Util.___debugShowTiledRects
                    : Util.___debugShowFreeScreenRects;
                this._debuggingIndicators = createIndicators.call(Util);
            }
            return;

        // Toggle the Tiling Popup
        } else if (shortcutName === Shortcuts.TOGGLE_POPUP) {
            const toggleTo = !Settings.getBoolean(Settings.ENABLE_TILING_POPUP);
            Settings.setBoolean(Settings.ENABLE_TILING_POPUP, toggleTo);
            Main.notify('Tiling Assistant', toggleTo
                ? _('Tiling popup enabled')
                : _('Tiling popup was disabled'));
            return;
        }

        const window = global.display.focus_window;
        if (!window)
            return;

        // Auto-tile: tile to empty space. If there's none: untile,
        // if it's already tiled else maximize
        if (shortcutName === Shortcuts.AUTO_FILL) {
            if (Util.isMaximized(window)) {
                Util.untile(window);
            } else {
                const topTileGroup = Util.getTopTileGroup(!window.isTiled);
                const tRects = topTileGroup.map(w => w.tiledRect);
                const tileRect = Util.getBestFreeRect(tRects, window.tiledRect);
                Util.toggleTiling(window, tileRect);
            }

        // Tile Editing Mode
        } else if (shortcutName === Shortcuts.EDIT_MODE) {
            const TileEditingMode = Me.imports.src.extension.tileEditingMode;
            const tileEditor = new TileEditingMode.TileEditor();
            tileEditor.open();

        // Tile a window
        } else {
            const dynamicBehaviour = Settings.DYNAMIC_KEYBINDINGS;
            const dynamicSetting = Settings.getString(dynamicBehaviour);
            const windowsStyle = DynamicKeybindings.TILING_STATE_WINDOWS;
            const isWindowsStyle = dynamicSetting === windowsStyle;
            const workArea = new Rect(window.get_work_area_current_monitor());
            const rect = Util.getTileFor(shortcutName, workArea);

            switch (dynamicSetting) {
                case DynamicKeybindings.FOCUS:
                    this._dynamicFocus(window, shortcutName);
                    break;
                case DynamicKeybindings.TILING_STATE:
                case DynamicKeybindings.TILING_STATE_WINDOWS:
                    this._dynamicTilingState(window, shortcutName, isWindowsStyle);
                    break;
                default:
                    Util.toggleTiling(window, rect);
            }
        }
    }

    /**
     * Tiles or moves the focus depending on the `windows` tiling state.
     *
     * @param {Meta.Window} window a Meta.Window as the starting position.
     * @param {string} shortcutName indicates the direction we tile or move
     *      the focus to.
     */
    _dynamicFocus(window, shortcutName) {
        const topTileGroup = Util.getTopTileGroup(false);
        const workArea = new Rect(window.get_work_area_current_monitor());

        // Toggle tile state of the window, if it isn't tiled
        // or if it is the only window which is.
        if (!window.isTiled || topTileGroup.length === 1) {
            const rect = Util.getTileFor(shortcutName, workArea);
            Util.toggleTiling(window, rect);
            return;
        }

        let direction;
        switch (shortcutName) {
            case Shortcuts.MAXIMIZE:
            case Shortcuts.TOP:
                direction = Direction.N;
                break;
            case Shortcuts.BOTTOM:
                direction = Direction.S;
                break;
            case Shortcuts.LEFT:
                direction = Direction.W;
                break;
            case Shortcuts.RIGHT:
                direction = Direction.E;
        }

        const nearestWindow = Util.getNearestWindow(
            window,
            topTileGroup,
            direction,
            false
        );

        if (!nearestWindow) {
            const rect = Util.getTileFor(shortcutName, workArea);
            Util.toggleTiling(window, rect);
            return;
        }

        nearestWindow.activate(global.get_current_time());

        // Animation for visibilty with a tmp 'tile preview'
        const fromRect = window.get_frame_rect();
        const focusIndicator = new St.Widget({
            style_class: 'tile-preview',
            opacity: 0,
            x: fromRect.x,
            y: fromRect.y,
            width: fromRect.width,
            height: fromRect.height
        });
        Main.uiGroup.add_child(focusIndicator);
        const toRect = nearestWindow.get_frame_rect();
        focusIndicator.ease({
            opacity: 255,
            x: toRect.x,
            y: toRect.y,
            width: toRect.width,
            height: toRect.height,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_QUART,
            onComplete: () => {
                focusIndicator.ease({
                    opacity: 0,
                    duration: 200,
                    mode: Clutter.AnimationMode.EASE_IN_OUT_CIRC,
                    delay: 100,
                    onComplete: () => focusIndicator.destroy()
                });
            }
        });
    }

    /**
     * Changes the tiling state of the `window` based on its current tiling
     * state and the activated shortcut.
     *
     * @param {Meta.Window} window a Meta.Window.
     * @param {string} shortcutName the shortcut.
     * @param {boolean} isWindowsStyle minimize when the `window` isn't tiled or
     *      if it's tiled to the bottom and the 'tile to bottom' shortcut is
     *      activated.
     */
    _dynamicTilingState(window, shortcutName, isWindowsStyle) {
        const untileFromMax = shortcutName === Shortcuts.TOP ||
            shortcutName === Shortcuts.MAXIMIZE ||
            shortcutName === Shortcuts.BOTTOM;

        if (Util.isMaximized(window) && untileFromMax) {
            Util.untile(window);
            return;
        }

        const workArea = new Rect(window.get_work_area_current_monitor());

        if (!window.isTiled) {
            if (isWindowsStyle && shortcutName === Shortcuts.BOTTOM) {
                window.minimize();
            } else {
                const rect = Util.getTileFor(shortcutName, workArea);
                Util.toggleTiling(window, rect);
            }

            return;
        }

        const wRect = window.tiledRect;
        const isLeftHalf =
            wRect.x === workArea.x &&
            wRect.y === workArea.y &&
            wRect.width !== workArea.width &&
            wRect.height === workArea.height;
        const isRightHalf =
            wRect.x !== workArea.x &&
            wRect.y === workArea.y &&
            wRect.x2 === workArea.x2 &&
            wRect.height === workArea.height;
        const isTopHalf =
            wRect.x === workArea.x &&
            wRect.y === workArea.y &&
            wRect.width === workArea.width &&
            wRect.height !== workArea.height;
        const isBottomHalf =
            wRect.x === workArea.x &&
            wRect.y !== workArea.y &&
            wRect.width === workArea.width &&
            wRect.y2 === workArea.y2;
        const isTopLeftQuarter =
            wRect.x === workArea.x &&
            wRect.y === workArea.y &&
            wRect.width !== workArea.width &&
            wRect.height !== workArea.height;
        const isTopRightQuarter =
            wRect.x !== workArea.x &&
            wRect.y === workArea.y &&
            wRect.x2 === workArea.x2 &&
            wRect.height !== workArea.height;
        const isBottomLeftQuarter =
            wRect.x === workArea.x &&
            wRect.y !== workArea.y &&
            wRect.width !== workArea.width &&
            wRect.y2 === workArea.y2;
        const isBottomRightQuarter =
            wRect.x !== workArea.x &&
            wRect.y !== workArea.y &&
            wRect.x2 === workArea.x2 &&
            wRect.y2 === workArea.y2;

        let rect;
        if (isLeftHalf) {
            switch (shortcutName) {
                case Shortcuts.TOP:
                case Shortcuts.MAXIMIZE:
                    rect = Util.getTileFor(Shortcuts.TOP_LEFT, workArea);
                    Util.toggleTiling(window, rect);
                    return;
                case Shortcuts.BOTTOM:
                    rect = Util.getTileFor(Shortcuts.BOTTOM_LEFT, workArea);
                    Util.toggleTiling(window, rect);
                    return;
                case Shortcuts.RIGHT:
                    Util.untile(window);
                    return;
            }
        } else if (isRightHalf) {
            switch (shortcutName) {
                case Shortcuts.TOP:
                case Shortcuts.MAXIMIZE:
                    rect = Util.getTileFor(Shortcuts.TOP_RIGHT, workArea);
                    Util.toggleTiling(window, rect);
                    return;
                case Shortcuts.BOTTOM:
                    rect = Util.getTileFor(Shortcuts.BOTTOM_RIGHT, workArea);
                    Util.toggleTiling(window, rect);
                    return;
                case Shortcuts.LEFT:
                    Util.untile(window);
                    return;
            }
        } else if (isTopHalf) {
            switch (shortcutName) {
                case Shortcuts.LEFT:
                    rect = Util.getTileFor(Shortcuts.TOP_LEFT, workArea);
                    Util.toggleTiling(window, rect);
                    return;
                case Shortcuts.RIGHT:
                    rect = Util.getTileFor(Shortcuts.TOP_RIGHT, workArea);
                    Util.toggleTiling(window, rect);
                    return;
                case Shortcuts.BOTTOM:
                    Util.untile(window);
                    return;
            }
        } else if (isBottomHalf) {
            switch (shortcutName) {
                case Shortcuts.LEFT:
                    rect = Util.getTileFor(Shortcuts.BOTTOM_LEFT, workArea);
                    Util.toggleTiling(window, rect);
                    return;
                case Shortcuts.RIGHT:
                    rect = Util.getTileFor(Shortcuts.BOTTOM_RIGHT, workArea);
                    Util.toggleTiling(window, rect);
                    return;
                case Shortcuts.TOP:
                case Shortcuts.MAXIMIZE:
                    Util.untile(window);
                    return;
                case Shortcuts.BOTTOM:
                    rect = Util.getTileFor(Shortcuts.BOTTOM, workArea);
                    isWindowsStyle ? window.minimize() : Util.toggleTiling(window, rect);
                    return;
            }
        } else if (isTopLeftQuarter) {
            switch (shortcutName) {
                case Shortcuts.RIGHT:
                    rect = Util.getTileFor(Shortcuts.TOP, workArea);
                    Util.toggleTiling(window, rect);
                    return;
                case Shortcuts.BOTTOM:
                    rect = Util.getTileFor(Shortcuts.LEFT, workArea);
                    Util.toggleTiling(window, rect);
                    return;
            }
        } else if (isTopRightQuarter) {
            switch (shortcutName) {
                case Shortcuts.LEFT:
                    rect = Util.getTileFor(Shortcuts.TOP, workArea);
                    Util.toggleTiling(window, rect);
                    return;
                case Shortcuts.BOTTOM:
                    rect = Util.getTileFor(Shortcuts.RIGHT, workArea);
                    Util.toggleTiling(window, rect);
                    return;
            }
        } else if (isBottomLeftQuarter) {
            switch (shortcutName) {
                case Shortcuts.TOP:
                case Shortcuts.MAXIMIZE:
                    rect = Util.getTileFor(Shortcuts.LEFT, workArea);
                    Util.toggleTiling(window, rect);
                    return;
                case Shortcuts.RIGHT:
                    rect = Util.getTileFor(Shortcuts.BOTTOM, workArea);
                    Util.toggleTiling(window, rect);
                    return;
                case Shortcuts.BOTTOM:
                    rect = Util.getTileFor(Shortcuts.BOTTOM, workArea);
                    isWindowsStyle ? window.minimize() : Util.toggleTiling(window, rect);
                    return;
            }
        } else if (isBottomRightQuarter) {
            switch (shortcutName) {
                case Shortcuts.TOP:
                case Shortcuts.MAXIMIZE:
                    rect = Util.getTileFor(Shortcuts.RIGHT, workArea);
                    Util.toggleTiling(window, rect);
                    return;
                case Shortcuts.LEFT:
                    rect = Util.getTileFor(Shortcuts.BOTTOM, workArea);
                    Util.toggleTiling(window, rect);
                    return;
                case Shortcuts.BOTTOM:
                    rect = Util.getTileFor(Shortcuts.BOTTOM, workArea);
                    isWindowsStyle ? window.minimize() : Util.toggleTiling(window, rect);
                    return;
            }
        }

        Util.toggleTiling(window, Util.getTileFor(shortcutName, workArea));
    }
};
