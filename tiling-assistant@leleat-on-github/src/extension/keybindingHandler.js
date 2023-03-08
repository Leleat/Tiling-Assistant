'use strict';

const { Clutter, Meta, Shell, St } = imports.gi;
const Main = imports.ui.main;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const { Direction, DynamicKeybindings, Settings, Shortcuts } = Me.imports.src.common;
const { Rect, Util } = Me.imports.src.extension.utility;
const Twm = Me.imports.src.extension.tilingWindowManager.TilingWindowManager;

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
            if (Twm.isMaximized(window)) {
                Twm.untile(window);
            } else {
                const topTileGroup = Twm.getTopTileGroup({ skipTopWindow: !window.isTiled });
                const tRects = topTileGroup.map(w => w.tiledRect);
                const tileRect = Twm.getBestFreeRect(tRects, { currRect: window.tiledRect });
                Twm.toggleTiling(window, tileRect);
            }

        // Tile Editing Mode
        } else if (shortcutName === Shortcuts.EDIT_MODE) {
            const TileEditingMode = Me.imports.src.extension.tileEditingMode;
            const tileEditor = new TileEditingMode.TileEditor();
            tileEditor.open();

        // Toggle always-on-top
        } else if (shortcutName === Shortcuts.ALWAYS_ON_TOP) {
            window.is_above() ? window.unmake_above() : window.make_above();

        // Toggle maximization vertically
        } else if (shortcutName === Shortcuts.MAXIMIZE_V) {
            const workArea = new Rect(window.get_work_area_current_monitor());
            const currRect = window.tiledRect ?? window.get_frame_rect();

            // Is tiled or maximized with this extension
            if (window.untiledRect && currRect.height === workArea.height) {
                // Is maximized
                if (currRect.width === workArea.width) {
                    const tileRect = new Rect(workArea.x, window.untiledRect.y, workArea.width, window.untiledRect.height);
                    Twm.tile(window, tileRect);
                // Is tiled
                } else {
                    Twm.untile(window);
                }

            // Maximize vertically even if the height may already be equal to the workArea
            // e. g. via double-click titlebar, maximize-window-button or whatever
            } else {
                const tileRect = new Rect(currRect.x, workArea.y, currRect.width, workArea.height);
                Twm.tile(window, tileRect);
            }

        // Toggle maximization horizontally
        } else if (shortcutName === Shortcuts.MAXIMIZE_H) {
            const workArea = new Rect(window.get_work_area_current_monitor());
            const currRect = window.tiledRect ?? window.get_frame_rect();

            // Is tiled or maximized with this extension
            if (window.untiledRect && currRect.width === workArea.width) {
                // Is maximized
                if (currRect.height === workArea.height) {
                    const tileRect = new Rect(window.untiledRect.x, workArea.y, window.untiledRect.width, workArea.height);
                    Twm.tile(window, tileRect);
                // Is tiled
                } else {
                    Twm.untile(window);
                }

            // Maximize horizontally even if the width may already be equal to the workArea
            // e. g. via double-click titlebar, maximize-window-button or whatever
            } else {
                const tileRect = new Rect(workArea.x, currRect.y, workArea.width, currRect.height);
                Twm.tile(window, tileRect);
            }

        // Restore window size
        } else if (shortcutName === Shortcuts.RESTORE_WINDOW) {
            if (window.untiledRect) // Tiled & maximized with gaps
                Twm.untile(window, { clampToWorkspace: true });
            else if (window.get_maximized())
                window.unmaximize(window.get_maximized());

        // Center window
        } else if (shortcutName === Shortcuts.CENTER_WINDOW) {
            const workArea = new Rect(window.get_work_area_current_monitor());
            if (window.isTiled) {
                const currRect = window.tiledRect;
                const tileRect = new Rect(
                    workArea.center.x - Math.floor(currRect.width / 2),
                    workArea.center.y - Math.floor(currRect.height / 2),
                    currRect.width,
                    currRect.height
                );

                if (tileRect.equal(currRect))
                    return;

                Twm.tile(window, tileRect, { openTilingPopup: false });
            } else if (!Twm.isMaximized(window)) {
                if (!window.allows_move())
                    return;

                const currRect = window.get_frame_rect();
                const x = workArea.center.x - Math.floor(currRect.width / 2);
                const y = workArea.center.y - Math.floor(currRect.height / 2);

                if (x === currRect.x && y === currRect.y)
                    return;

                const wActor = window.get_compositor_private();
                wActor && Main.wm._prepareAnimationInfo(
                    global.window_manager,
                    wActor,
                    currRect,
                    Meta.SizeChange.UNMAXIMIZE
                );
                window.move_frame(false, x, y);
            }
        // Tile a window but ignore T-A features
        } else if ([Shortcuts.TOP_IGNORE_TA, Shortcuts.BOTTOM_IGNORE_TA,
            Shortcuts.LEFT_IGNORE_TA, Shortcuts.RIGHT_IGNORE_TA,
            Shortcuts.TOP_LEFT_IGNORE_TA, Shortcuts.TOP_RIGHT_IGNORE_TA,
            Shortcuts.BOTTOM_LEFT_IGNORE_TA,
            Shortcuts.BOTTOM_RIGHT_IGNORE_TA].includes(shortcutName)
        ) {
            const workArea = new Rect(window.get_work_area_current_monitor());
            const rect = Twm.getDefaultTileFor(shortcutName, workArea);
            Twm.toggleTiling(window, rect, { ignoreTA: true });
        // Tile a window
        } else {
            const dynamicBehavior = Settings.DYNAMIC_KEYBINDINGS;
            const dynamicSetting = Settings.getInt(dynamicBehavior);
            const windowsStyle = DynamicKeybindings.TILING_STATE_WINDOWS;
            const isWindowsStyle = dynamicSetting === windowsStyle;
            const workArea = new Rect(window.get_work_area_current_monitor());
            const rect = Twm.getTileFor(shortcutName, workArea, window.get_monitor());

            switch (dynamicSetting) {
                case DynamicKeybindings.FOCUS:
                    this._dynamicFocus(window, shortcutName);
                    break;
                case DynamicKeybindings.TILING_STATE:
                case DynamicKeybindings.TILING_STATE_WINDOWS:
                    this._dynamicTilingState(window, shortcutName, isWindowsStyle);
                    break;
                case DynamicKeybindings.FAVORITE_LAYOUT:
                    this._dynamicFavoriteLayout(window, shortcutName);
                    break;
                default:
                    Twm.toggleTiling(window, rect);
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
        const topTileGroup = Twm.getTopTileGroup({ skipTopWindow: true });
        const workArea = new Rect(window.get_work_area_current_monitor());

        // Toggle tile state of the window, if it isn't tiled
        // or if it is the only window which is.
        if (!window.isTiled || topTileGroup.length === 1) {
            const rect = Twm.getTileFor(shortcutName, workArea, window.get_monitor());
            Twm.toggleTiling(window, rect);
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

        const nearestWindow = Twm.getNearestWindow(
            window,
            topTileGroup,
            direction,
            false
        );

        if (!nearestWindow) {
            const rect = Twm.getTileFor(shortcutName, workArea, window.get_monitor());
            Twm.toggleTiling(window, rect);
            return;
        }

        // Activate() caused problems with an extensions' prefs window, if the
        // extensions-app wasn't open.
        nearestWindow.focus(global.get_current_time());

        // Animation for visibility with a tmp 'tile preview'
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
        const workArea = new Rect(window.get_work_area_current_monitor());

        if (Twm.isMaximized(window)) {
            switch (shortcutName) {
                case Shortcuts.MAXIMIZE:
                case Shortcuts.TOP: {
                    const rect = Twm.getTileFor(Shortcuts.TOP, workArea, window.get_monitor());
                    Twm.tile(window, rect, { skipAnim: true });
                    break;
                } case Shortcuts.BOTTOM: {
                    Twm.untile(window);
                    break;
                } default: {
                    const rect = Twm.getTileFor(shortcutName, workArea, window.get_monitor());
                    Twm.toggleTiling(window, rect);
                }
            }

            return;
        } else if (!window.isTiled) {
            switch (shortcutName) {
                case Shortcuts.BOTTOM: {
                    if (isWindowsStyle) {
                        window.minimize();
                        break;
                    }
                // falls through
                } default: {
                    const rect = Twm.getTileFor(shortcutName, workArea, window.get_monitor());
                    Twm.toggleTiling(window, rect);
                }
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
                    rect = Twm.getTileFor(Shortcuts.TOP_LEFT, workArea, window.get_monitor());
                    Twm.toggleTiling(window, rect);
                    return;
                case Shortcuts.BOTTOM:
                    rect = Twm.getTileFor(Shortcuts.BOTTOM_LEFT, workArea, window.get_monitor());
                    Twm.toggleTiling(window, rect);
                    return;
                case Shortcuts.RIGHT:
                    Twm.untile(window);
                    return;
            }
        } else if (isRightHalf) {
            switch (shortcutName) {
                case Shortcuts.TOP:
                case Shortcuts.MAXIMIZE:
                    rect = Twm.getTileFor(Shortcuts.TOP_RIGHT, workArea, window.get_monitor());
                    Twm.toggleTiling(window, rect);
                    return;
                case Shortcuts.BOTTOM:
                    rect = Twm.getTileFor(Shortcuts.BOTTOM_RIGHT, workArea, window.get_monitor());
                    Twm.toggleTiling(window, rect);
                    return;
                case Shortcuts.LEFT:
                    Twm.untile(window);
                    return;
            }
        } else if (isTopHalf) {
            switch (shortcutName) {
                case Shortcuts.TOP:
                    rect = Twm.getTileFor(Shortcuts.MAXIMIZE, workArea, window.get_monitor());
                    Twm.toggleTiling(window, rect);
                    return;
                case Shortcuts.LEFT:
                    rect = Twm.getTileFor(Shortcuts.TOP_LEFT, workArea, window.get_monitor());
                    Twm.toggleTiling(window, rect);
                    return;
                case Shortcuts.RIGHT:
                    rect = Twm.getTileFor(Shortcuts.TOP_RIGHT, workArea, window.get_monitor());
                    Twm.toggleTiling(window, rect);
                    return;
                case Shortcuts.BOTTOM:
                    Twm.untile(window);
                    return;
            }
        } else if (isBottomHalf) {
            switch (shortcutName) {
                case Shortcuts.LEFT:
                    rect = Twm.getTileFor(Shortcuts.BOTTOM_LEFT, workArea, window.get_monitor());
                    Twm.toggleTiling(window, rect);
                    return;
                case Shortcuts.RIGHT:
                    rect = Twm.getTileFor(Shortcuts.BOTTOM_RIGHT, workArea, window.get_monitor());
                    Twm.toggleTiling(window, rect);
                    return;
                case Shortcuts.TOP:
                case Shortcuts.MAXIMIZE:
                    Twm.untile(window);
                    return;
                case Shortcuts.BOTTOM:
                    rect = Twm.getTileFor(Shortcuts.BOTTOM, workArea, window.get_monitor());
                    isWindowsStyle ? window.minimize() : Twm.toggleTiling(window, rect);
                    return;
            }
        } else if (isTopLeftQuarter) {
            switch (shortcutName) {
                case Shortcuts.RIGHT:
                    rect = Twm.getTileFor(Shortcuts.TOP, workArea, window.get_monitor());
                    Twm.toggleTiling(window, rect);
                    return;
                case Shortcuts.BOTTOM:
                    rect = Twm.getTileFor(Shortcuts.LEFT, workArea, window.get_monitor());
                    Twm.toggleTiling(window, rect);
                    return;
            }
        } else if (isTopRightQuarter) {
            switch (shortcutName) {
                case Shortcuts.LEFT:
                    rect = Twm.getTileFor(Shortcuts.TOP, workArea, window.get_monitor());
                    Twm.toggleTiling(window, rect);
                    return;
                case Shortcuts.BOTTOM:
                    rect = Twm.getTileFor(Shortcuts.RIGHT, workArea, window.get_monitor());
                    Twm.toggleTiling(window, rect);
                    return;
            }
        } else if (isBottomLeftQuarter) {
            switch (shortcutName) {
                case Shortcuts.TOP:
                case Shortcuts.MAXIMIZE:
                    rect = Twm.getTileFor(Shortcuts.LEFT, workArea, window.get_monitor());
                    Twm.toggleTiling(window, rect);
                    return;
                case Shortcuts.RIGHT:
                    rect = Twm.getTileFor(Shortcuts.BOTTOM, workArea, window.get_monitor());
                    Twm.toggleTiling(window, rect);
                    return;
                case Shortcuts.BOTTOM:
                    rect = Twm.getTileFor(Shortcuts.BOTTOM, workArea, window.get_monitor());
                    isWindowsStyle ? window.minimize() : Twm.toggleTiling(window, rect);
                    return;
            }
        } else if (isBottomRightQuarter) {
            switch (shortcutName) {
                case Shortcuts.TOP:
                case Shortcuts.MAXIMIZE:
                    rect = Twm.getTileFor(Shortcuts.RIGHT, workArea, window.get_monitor());
                    Twm.toggleTiling(window, rect);
                    return;
                case Shortcuts.LEFT:
                    rect = Twm.getTileFor(Shortcuts.BOTTOM, workArea, window.get_monitor());
                    Twm.toggleTiling(window, rect);
                    return;
                case Shortcuts.BOTTOM:
                    rect = Twm.getTileFor(Shortcuts.BOTTOM, workArea, window.get_monitor());
                    isWindowsStyle ? window.minimize() : Twm.toggleTiling(window, rect);
                    return;
            }
        }

        Twm.toggleTiling(window, Twm.getTileFor(shortcutName, workArea, window.get_monitor()));
    }

    _dynamicFavoriteLayout(window, shortcutName) {
        const workArea = new Rect(window.get_work_area_current_monitor());
        const toggleTiling = () => {
            const rect = Twm.getTileFor(shortcutName, workArea, window.get_monitor());
            Twm.toggleTiling(window, rect);
        };

        if (!window.isTiled) {
            toggleTiling();
            return;
        }

        const favoriteLayout = Util.getFavoriteLayout(window.get_monitor());
        if (favoriteLayout.length <= 1) {
            toggleTiling();
            return;
        }

        let direction;
        switch (shortcutName) {
            case Shortcuts.TOP:
            case Shortcuts.MAXIMIZE:
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

        if (direction) {
            const neighbor = window.tiledRect.getNeighbor(direction, favoriteLayout);
            Twm.tile(window, neighbor, { openTilingPopup: false });
        } else {
            toggleTiling();
        }
    }
};
