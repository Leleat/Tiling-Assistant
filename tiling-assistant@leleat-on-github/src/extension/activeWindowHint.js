import { Clutter, GObject, Meta, St } from '../dependencies/gi.js';
import { Main } from '../dependencies/shell.js';

import { Settings } from '../common.js';
import { TilingWindowManager as Twm } from './tilingWindowManager.js';

export default class ActiveWindowHintHandler {
    constructor() {
        // On a fresh install no color is set for the hint yet. Use the bg color
        // from the tile preview style by using a temporary widget.
        if (Settings.getString(Settings.ACTIVE_WINDOW_HINT_COLOR) === '') {
            const widget = new St.Widget({ style_class: 'tile-preview' });
            global.stage.add_child(widget);

            const color = widget.get_theme_node().get_background_color();
            const { red, green, blue } = color;

            Settings.setString(Settings.ACTIVE_WINDOW_HINT_COLOR, `rgb(${red},${green},${blue})`);

            widget.destroy();
        }

        this._hint = null;
        this._settingsId = 0;

        this._setupHint();

        this._settingsId = Settings.changed(Settings.ACTIVE_WINDOW_HINT,
            () => this._setupHint());
    }

    destroy() {
        Settings.disconnect(this._settingsId);
        this._hint?.destroy();
        this._hint = null;
    }

    _setupHint() {
        switch (Settings.getInt(Settings.ACTIVE_WINDOW_HINT)) {
            case 0: // Disabled
                this._hint?.destroy();
                this._hint = null;
                break;
            case 1: // Minimal
                this._hint?.destroy();
                this._hint = new MinimalHint();
                break;
            case 2: // Always
                this._hint?.destroy();
                this._hint = new AlwaysHint();
        }
    }
}

const Hint = GObject.registerClass(
class ActiveWindowHint extends St.Widget {
    _init() {
        super._init();

        this._color = Settings.getString(Settings.ACTIVE_WINDOW_HINT_COLOR);
        this._borderSize = Settings.getInt(Settings.ACTIVE_WINDOW_HINT_BORDER_SIZE);
        this._innerBorderSize = Settings.getInt(Settings.ACTIVE_WINDOW_HINT_INNER_BORDER_SIZE); // 'Inner border' to cover rounded corners
        this._settingsIds = [];

        this._settingsIds.push(Settings.changed(Settings.ACTIVE_WINDOW_HINT_COLOR, () => {
            this._color = Settings.getString(Settings.ACTIVE_WINDOW_HINT_COLOR);
        }));
        this._settingsIds.push(Settings.changed(Settings.ACTIVE_WINDOW_HINT_BORDER_SIZE, () => {
            this._borderSize = Settings.getInt(Settings.ACTIVE_WINDOW_HINT_BORDER_SIZE);
        }));
        this._settingsIds.push(Settings.changed(Settings.ACTIVE_WINDOW_HINT_INNER_BORDER_SIZE, () => {
            this._innerBorderSize = Settings.getInt(Settings.ACTIVE_WINDOW_HINT_INNER_BORDER_SIZE);
        }));

        global.window_group.add_child(this);
    }

    destroy() {
        this._settingsIds.forEach(id => Settings.disconnect(id));
        super.destroy();
    }
});

const MinimalHint = GObject.registerClass(
class MinimalActiveWindowHint extends Hint {
    _init() {
        super._init();

        this._windowClone = null;

        this._updateStyle();

        this._settingsIds.push(Settings.changed(Settings.ACTIVE_WINDOW_HINT_COLOR, () => {
            this._updateStyle();
        }));

        global.workspace_manager.connectObject('workspace-switched',
            () => this._onWsSwitched(), this);
    }

    destroy() {
        this._reset();
        super.destroy();
    }

    _reset() {
        if (this._laterId) {
            global.compositor.get_laters().remove(this._laterId);
            delete this._laterId;
        }
        this._windowClone?.destroy();
        this._windowClone = null;
        this.hide();
    }

    _updateStyle() {
        this.set_style(`background-color: ${this._color};`);
    }

    _onWsSwitched() {
        // Reset in case multiple workspaces are switched at once.
        this._reset();

        // If we are in the overview, it's likely the user actively chose
        // a window to focus. So the hint is unnecessary.
        if (Main.overview.visible)
            return;

        const window = global.display.focus_window;
        if (!window)
            return;

        // Maximized or fullscreen windows don't require a hint since they
        // cover the entire screen.
        if (window.is_fullscreen() || Twm.isMaximized(window))
            return;

        // Now figure out if the focused window is easily identifiable by
        // checking (in stacking order) if all other windows are being
        // overlapped by higher windows. If a window is not overlapped, the
        // focused window is ambiguous.
        const windows = Twm.getWindows();
        const overlapping = windows.splice(windows.indexOf(window), 1);

        const notOverlappedWindowExists = windows.some(w => {
            if (!overlapping.some(o => o.get_frame_rect().overlap(w.get_frame_rect())))
                return true;

            overlapping.push(w);
            return false;
        });

        if (notOverlappedWindowExists)
            this._giveHint(window);
    }

    _giveHint(window) {
        this._scaleClone(window);
        this._rippleFade(window);
    }

    _scaleClone(window) {
        const actor = window.get_compositor_private();
        if (!actor)
            return;

        const { x, y, width, height } = actor;
        const scaleAmount = 15;
        this._windowClone = new Clutter.Clone({
            source: actor,
            x: x - scaleAmount,
            y: y - scaleAmount,
            width: width + 2 * scaleAmount,
            height: height + 2 * scaleAmount
        });
        global.window_group.insert_child_above(this._windowClone, actor);

        this._windowClone.ease({
            x, y, width, height,
            delay: 250,
            duration: 250,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                // May already have been destroyed by a reset
                this._windowClone?.destroy();
                this._windowClone = null;
            }
        });
    }

    _rippleFade(window) {
        const actor = window.get_compositor_private();
        if (!actor)
            return;

        if (!this._laterId) {
            this._laterId = global.compositor.get_laters().add(
                Meta.LaterType.BEFORE_REDRAW,
                () => {
                    global.window_group.set_child_below_sibling(this, actor);
                    delete this._laterId;
                    return false;
                }
            );
        }

        const { x, y, width, height } = window.get_frame_rect();
        this.set({ x, y, width, height });

        this.set_opacity(255);
        this.show();

        const rippleSize = 30;
        this.ease({
            x: x - rippleSize,
            y: y - rippleSize,
            width: width + 2 * rippleSize,
            height: height + 2 * rippleSize,
            opacity: 0,
            delay: 250,
            duration: 350,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this.hide()
        });
    }
});

// TODO a solid bg color looks better than a border when launching an app since
// the border will appear before the window is fully visible. However there was
// an issue with global.window_group.set_child_below_sibling not putting the hint
// below the window for some reason. laters-add solved it but I don't know
// why. So as to not potentially cover the entire window's content use the border
// style until I figure out if laters-add is the proper solution...
const AlwaysHint = GObject.registerClass(
class AlwaysActiveWindowHint extends Hint {
    _init() {
        super._init();

        this._window = null;
        this._signalIds = [];

        this._updateGeometry();
        this._updateStyle();

        global.display.connectObject('notify::focus-window',
            () => this._updateGeometry(), this);

        this._settingsIds.push(Settings.changed(Settings.ACTIVE_WINDOW_HINT_COLOR, () => {
            this._updateStyle();
            this._updateGeometry();
        }));
        this._settingsIds.push(Settings.changed(Settings.ACTIVE_WINDOW_HINT_BORDER_SIZE, () => {
            this._updateStyle();
            this._updateGeometry();
        }));
        this._settingsIds.push(Settings.changed(Settings.ACTIVE_WINDOW_HINT_INNER_BORDER_SIZE, () => {
            this._updateStyle();
            this._updateGeometry();
        }));
    }

    destroy() {
        this._reset();
        super.destroy();
    }

    vfunc_hide() {
        this._cancelShowLater();
        super.vfunc_hide();
    }

    _reset() {
        this._cancelShowLater();
        this._signalIds.forEach(id => this._window.disconnect(id));
        this._signalIds = [];
        this._window = null;
    }

    _cancelShowLater() {
        if (!this._showLater)
            return;


        global.compositor.get_laters().remove(this._showLater);
        delete this._showLater;
    }

    _updateGeometry() {
        this._reset();

        const window = global.display.focus_window;
        const allowTypes = [Meta.WindowType.NORMAL, Meta.WindowType.DIALOG, Meta.WindowType.MODAL_DIALOG];
        if (!window || !allowTypes.includes(window.get_window_type())) {
            this.hide();
            return;
        }

        this._window = window;
        this._signalIds.push(window.connect('position-changed', () => this._updateGeometry()));
        this._signalIds.push(window.connect('size-changed', () => this._updateGeometry()));

        // Don't show hint on maximzed/fullscreen windows
        if (window.is_fullscreen() || Twm.isMaximized(window)) {
            this.hide();
            return;
        }

        const { x, y, width, height } = window.get_frame_rect();
        this.set({ x, y, width, height });

        const actor = window.get_compositor_private();

        if (!actor || this._showLater)
            return;

        this._showLater = global.compositor.get_laters().add(
            Meta.LaterType.IDLE,
            () => {
                global.window_group.set_child_below_sibling(this, actor);
                this.show();
                delete this._showLater;
                return false;
            }
        );
    }

    _updateStyle() {
        this.set_style(`
            border: ${this._innerBorderSize}px solid ${this._color};
            outline: ${this._borderSize}px solid ${this._color};
        `);
    }
});
