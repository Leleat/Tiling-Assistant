import {
    Clutter,
    Gio,
    GLib,
    Meta,
    Shell,
    St
} from '../dependencies/gi.js';
import {
    AppFavorites,
    Main,
    OsdWindow,
    SwitcherPopup
} from '../dependencies/shell.js';
import * as AltTab from '../dependencies/unexported/altTab.js';

import { FocusHint, Settings } from '../common.js';

export default class FocusHintManager {
    _hint = null;

    constructor(initialWindow) {
        // On a fresh install no color is set for the hint yet. Use the bg color
        // from the tile preview style by using a temporary widget.
        if (Settings.getString('focus-hint-color') === '') {
            const widget = new St.Widget({ style_class: 'tile-preview' });
            global.stage.add_child(widget);

            const color = widget.get_theme_node().get_background_color();
            const { red, green, blue } = color;

            Settings.setString('focus-hint-color', `rgb(${red},${green},${blue})`);

            widget.destroy();
        }

        this._settingsChangedId = Settings.changed(
            'focus-hint',
            () => this._setHint(),
            this
        );
        this._setHint();

        if (this._hint?.shouldIndicate(initialWindow))
            this._hint.indicate(initialWindow);
    }

    destroy() {
        Settings.disconnect(this._settingsChangedId);

        this._hint?.destroy();
        this._hint = null;
    }

    _setHint() {
        this._hint?.destroy();

        switch (Settings.getInt('focus-hint')) {
            case FocusHint.ANIMATED_OUTLINE:
                this._hint = new AnimatedOutlineHint();
                break;
            case FocusHint.ANIMATED_UPSCALE:
                this._hint = new AnimatedUpscaleHint();
                break;
            case FocusHint.STATIC_OUTLINE:
                this._hint = new StaticOutlineHint();
                break;
            default:
                this._hint = null;
        }
    }
};

class Hint {
    _actors = [];

    constructor() {
        this._addIdleWatcher();
        this._overrideSwitchToApplication();
        this._overrideSwitcherPopupFinish();
        this._overrideWorkspaceAnimationSwitch();
        this._indicateOnWindowClose();
    }

    destroy() {
        if (this._workspaceSwitchTimer) {
            GLib.Source.remove(this._workspaceSwitchTimer);
            this._workspaceSwitchTimer = 0;
        }

        this.resetAnimation();

        this._stopIndicatingOnWindowClose();
        this._restoreSwitcherPopupFinish();
        this._restoreSwitchToApplication();
        this._restoreWorkspaceAnimationSwitch();
        this._removeIdleWatcher();
    }

    indicate() {
        throw new Error('`indicate` not implemented by Hint subclass!');
    }

    resetAnimation() {
        this._actors.forEach(actor => actor.destroy());
        this._actors = [];
    }

    _addIdleWatcher() {
        const idleMonitor = global.backend.get_core_idle_monitor();
        const idleTime = 120 * 1000;

        this._activeWatchId && idleMonitor.remove_watch(this._activeWatchId);
        this._activeWatchId = 0;

        this._idleWatchId && idleMonitor.remove_watch(this._idleWatchId);
        this._idleWatchId = idleMonitor.add_idle_watch(idleTime, () => {
            this._activeWatchId = idleMonitor.add_user_active_watch(() => {
                this._activeWatchId = 0;

                const focus = global.display.focus_window;

                if (this.shouldIndicate(focus))
                    this.indicate(focus);
            });
        });
    }

    _allowedWindowType(type) {
        return [
            Meta.WindowType.NORMAL,
            Meta.WindowType.DIALOG,
            Meta.WindowType.MODAL_DIALOG
        ].includes(type);
    }

    _indicateOnWindowClose() {
        global.display.connectObject(
            'window-created',
            (_, metaWindow) => this._onWindowCreated(metaWindow),
            this
        );

        global
            .get_window_actors()
            .forEach(actor => this._onWindowCreated(actor.get_meta_window()));
    }

    _onWindowCreated(window) {
        if (!this._allowedWindowType(window.get_window_type()))
            return;

        window.connectObject(
            'unmanaged',
            () => {
                window.disconnectObject(this);

                const focus = global.display.focus_window;

                if (focus && this.shouldIndicate(focus))
                    this.indicate(focus);
                else
                    this.resetAnimation();
            },
            this
        );
    }

    _overrideSwitcherPopupFinish() {
        this._originalSwitcherPopupFinish =
            SwitcherPopup.SwitcherPopup.prototype._finish;

        const that = this;

        SwitcherPopup.SwitcherPopup.prototype._finish = function (timestamp) {
            that._originalSwitcherPopupFinish.call(this, timestamp);

            const newFocus = global.display.focus_window;

            if (that.shouldIndicate(newFocus)) {
                if (that._workspaceSwitchTimer) {
                    GLib.Source.remove(that._workspaceSwitchTimer);
                    that._workspaceSwitchTimer = 0;
                }

                that.indicate(newFocus);
            } else {
                that.resetAnimation();
            }
        };
    }

    _overrideSwitchToApplication() {
        for (let i = 1; i < 10; i++) {
            const key = `switch-to-application-${i}`;

            if (global.display.remove_keybinding(key)) {
                const handler = (_, __, keybinding) => {
                    if (!Main.sessionMode.hasOverview)
                        return;

                    const [, , , target] = keybinding.get_name().split('-');
                    const apps = AppFavorites.getAppFavorites().getFavorites();
                    const app = apps[target - 1];

                    if (app) {
                        const [newFocus] = app.get_windows();

                        Main.overview.hide();
                        app.activate();

                        if (this.shouldIndicate(newFocus)) {
                            if (this._workspaceSwitchTimer) {
                                GLib.Source.remove(this._workspaceSwitchTimer);
                                this._workspaceSwitchTimer = 0;
                            }

                            this.indicate(newFocus);
                        } else {
                            this.resetAnimation();
                        }
                    }
                };

                global.display.add_keybinding(
                    key,
                    new Gio.Settings({ schema_id: 'org.gnome.shell.keybindings' }),
                    Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                    handler
                );
            }
        }
    }

    _overrideWorkspaceAnimationSwitch() {
        this._originalWorkspaceAnimationSwitch =
            Main.wm._workspaceAnimation.animateSwitch;

        const that = this;

        Main.wm._workspaceAnimation.animateSwitch = function (
                from,
                to,
                direction,
                onComplete
        ) {
            that._originalWorkspaceAnimationSwitch.call(
                this,
                from,
                to,
                direction,
                onComplete
            );

            // This is set if the focused window moved to the new workspace
            // along with the workspace switch animation. E. g. when using
            // Shift + Super + Alt + Arrow_Keys.
            if (this.movingWindow)
                return;

            // There are 2 different 'focus behaviors' during a workspace
            // animation. 1: When the workspace switch is initiated by an app or
            // by a window activation/focus (e. g. App Switcher). In this case
            // global.display.focus_window gives the correct window for the
            // focus hint. 2: When just switching workspaces (e. g. Super + Alt
            // + Arrow Key), here the focus switches *after* the animation. So
            // delay this code and let it be interrupted by the switcher popup
            // or the switch-to-application focus hint.
            that._workspaceSwitchTimer = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                0,
                () => {
                    that._workspaceSwitchTimer = 0;

                    const newWorkspace =
                        global.workspace_manager.get_workspace_by_index(to);
                    const [newFocus] = AltTab.getWindows(newWorkspace);

                    if (that.shouldIndicate(newFocus))
                        that.indicate(newFocus);
                    else
                        that.resetAnimation();
                }
            );
        };
    }

    shouldIndicate(window) {
        if (!window || !window.get_compositor_private())
            return false;

        if (!this._allowedWindowType(window.get_window_type()))
            return false;

        if (
            window.is_fullscreen() ||
            window.get_maximized() === Meta.MaximizeFlags.BOTH
        )
            return false;

        return true;
    }

    _removeIdleWatcher() {
        const idleMonitor = global.backend.get_core_idle_monitor();

        this._activeWatchId && idleMonitor.remove_watch(this._activeWatchId);
        this._activeWatchId = 0;

        this._idleWatchId && idleMonitor.remove_watch(this._idleWatchId);
        this._idleWatchId = 0;
    }

    _restoreSwitcherPopupFinish() {
        SwitcherPopup.SwitcherPopup.prototype._finish =
            this._originalSwitcherPopupFinish;

        this._originalSwitcherPopupFinish = null;
    }

    _restoreSwitchToApplication() {
        for (let i = 1; i < 10; i++) {
            const key = `switch-to-application-${i}`;

            if (global.display.remove_keybinding(key)) {
                Main.wm.addKeybinding(
                    key,
                    new Gio.Settings({ schema_id: 'org.gnome.shell.keybindings' }),
                    Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                    Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                    Main.wm._switchToApplication.bind(Main.wm)
                );
            }
        }
    }

    _restoreWorkspaceAnimationSwitch() {
        Main.wm._workspaceAnimation.animateSwitch =
            this._originalWorkspaceAnimationSwitch;

        this._originalWorkspaceAnimationSwitch = null;
    }

    _stopIndicatingOnWindowClose() {
        global.display.disconnectObject(this);

        global.get_window_actors().forEach(actor => {
            actor.get_meta_window().disconnectObject(this);
        });
    }
}

class AnimatedOutlineHint extends Hint {
    _color = '';
    _outlineSize = 0;
    _outlineBorderRadius = 0;

    constructor() {
        super();

        this._color = Settings.getString('focus-hint-color');
        this._colorChangeId = Settings.changed('focus-hint-color', () => {
            this._color = Settings.getString('focus-hint-color');
        });

        this._outlineSize = Settings.getInt('focus-hint-outline-size');
        this._outlineSizeChangeId = Settings.changed('focus-hint-outline-size', () => {
            this._outlineSize = Settings.getInt('focus-hint-outline-size');
        });

        this._outlineBorderRadius = Settings.getInt('focus-hint-outline-border-radius');
        this._outlineBorderRadiusChangeId = Settings.changed('focus-hint-outline-border-radius', () => {
            this._outlineBorderRadius = Settings.getInt('focus-hint-outline-border-radius');
        });
    }

    destroy() {
        Settings.disconnect(this._colorChangeId);
        Settings.disconnect(this._outlineSizeChangeId);
        Settings.disconnect(this._outlineBorderRadiusChangeId);

        super.destroy();
    }

    indicate(window, workspaceSwitchAnimationDuration = 250) {
        this.resetAnimation();

        if (!this.shouldIndicate(window))
            return;

        const windowActor = window.get_compositor_private();
        const workspaceAnimationWindowClone =
            findWindowCloneForWorkspaceAnimation(
                windowActor,
                !!Main.wm._workspaceAnimation._switchData
            );
        const [monitorContainer, workspaceContainer] = createContainers(
            window,
            workspaceAnimationWindowClone,
            workspaceSwitchAnimationDuration
        );

        this._actors.push(monitorContainer);

        const customClone = createWindowClone(
            windowActor,
            monitorContainer
        );
        const outline = this._createOutline(window, monitorContainer);
        const {
            x: windowFrameX,
            y: windowFrameY,
            width: windowFrameWidth,
            height: windowFrameHeight
        } = window.get_frame_rect();

        workspaceContainer.add_child(outline);
        workspaceContainer.add_child(customClone);

        workspaceAnimationWindowClone?.hide();

        outline.ease({
            x: windowFrameX - monitorContainer.x - this._outlineSize,
            y: windowFrameY - monitorContainer.y - this._outlineSize,
            width: windowFrameWidth + 2 * this._outlineSize,
            height: windowFrameHeight + 2 * this._outlineSize,
            delay: workspaceAnimationWindowClone
                ? (175 / 250) * workspaceSwitchAnimationDuration
                : 0,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
            onComplete: () => {
                outline.ease({
                    x: windowFrameX - monitorContainer.x,
                    y: windowFrameY - monitorContainer.y,
                    width: windowFrameWidth,
                    height: windowFrameHeight,
                    duration: 100,
                    mode: Clutter.AnimationMode.EASE_IN,
                    onComplete: () => this.resetAnimation()
                });
            }
        });
    }

    _createOutline(window, monitorContainer) {
        const { x, y, width, height } = window.get_frame_rect();
        const outline = new St.Widget({
            style: this._getCssStyle(),
            x: x - monitorContainer.x,
            y: y - monitorContainer.y,
            width,
            height
        });

        return outline;
    }

    _getCssStyle() {
        return `
            background-color: ${this._color};
            border-radius: ${this._outlineBorderRadius}px;
        `;
    }
}

class AnimatedUpscaleHint extends Hint {
    _scaleAmount = 10;

    indicate(window, workspaceSwitchAnimationDuration = 250) {
        this.resetAnimation();

        if (!this.shouldIndicate(window))
            return;

        const windowActor = window.get_compositor_private();
        const workspaceAnimationWindowClone =
            findWindowCloneForWorkspaceAnimation(
                windowActor,
                !!Main.wm._workspaceAnimation._switchData
            );
        const [monitorContainer, workspaceContainer] = createContainers(
            window,
            workspaceAnimationWindowClone,
            workspaceSwitchAnimationDuration
        );

        this._actors.push(monitorContainer);

        const customClone = createWindowClone(
            windowActor,
            monitorContainer
        );
        const { x, y, width, height } = customClone;

        workspaceContainer.add_child(customClone);

        workspaceAnimationWindowClone?.hide();
        windowActor.set_opacity(0); // Hide to prevent double shadows.

        customClone.ease({
            x: x - this._scaleAmount,
            y: y - this._scaleAmount,
            width: width + 2 * this._scaleAmount,
            height: height + 2 * this._scaleAmount,
            delay: workspaceAnimationWindowClone
                ? (175 / 250) * workspaceSwitchAnimationDuration
                : 0,
            duration: 100,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                customClone.ease({
                    x,
                    y,
                    width,
                    height,
                    duration: 150,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => this.resetAnimation()
                });
            }
        });
    }

    resetAnimation() {
        global.get_window_actors().forEach(a => a.set_opacity(255));
        super.resetAnimation();
    }
}

class StaticOutlineHint extends AnimatedOutlineHint {
    _outline = null;
    _window = null;

    constructor() {
        super();

        this._outline = new St.Widget({ style: this._getCssStyle() });
        global.window_group.add_child(this._outline);

        // Originally, only `notify::focus-window` was used but that had issues
        // with popups on Wayland. `restacked` by itself seems to be kinda
        // spotty on Wayland for the first window that is opened on a workspace.
        global.display.connectObject(
            'restacked',
            () => this._updateOutline(),
            'notify::focus-window',
            () => this._updateOutline(),
            this
        );

        this._updateOutline();

        Settings.getGioObject().connectObject(
            'changed::focus-hint-color',
            () => this._updateOutline(),
            'changed::focus-hint-outline-size',
            () => this._updateOutline(),
            'changed::focus-hint-outline-border-radius',
            () => this._updateOutline(),
            this
        );
    }

    destroy() {
        Settings.getGioObject().disconnectObject(this);

        this._cancelGeometryUpdate();

        this._outline.destroy();
        this._outline = null;

        this._window?.disconnectObject(this);
        this._window = null;

        global.display.disconnectObject(this);

        GLib.Source.remove(this._resetTimer);

        super.destroy();
    }

    /**
     * This is really only used for the indication when changing workspaces...
     *
     * @param {Window} window -
     * @param {number} workspaceSwitchAnimationDuration -
     */
    indicate(window, workspaceSwitchAnimationDuration = 250) {
        this.resetAnimation();

        if (!this.shouldIndicate(window))
            return;

        const animatingWorkspaceSwitch =
            !!Main.wm._workspaceAnimation._switchData;

        // Only need to use an animation to indicate the focus when switching
        // workspaces. In the other cases, there is the static `this._outline`.
        if (!animatingWorkspaceSwitch)
            return;

        const windowActor = window.get_compositor_private();
        const workspaceAnimationWindowClone =
            findWindowCloneForWorkspaceAnimation(
                windowActor,
                animatingWorkspaceSwitch
            );
        const [monitorContainer, workspaceContainer] = createContainers(
            window,
            workspaceAnimationWindowClone,
            workspaceSwitchAnimationDuration
        );

        this._actors.push(monitorContainer);

        const customClone = createWindowClone(
            windowActor,
            monitorContainer
        );
        const outline = this._createOutline(window, monitorContainer);

        workspaceContainer.add_child(outline);
        workspaceContainer.add_child(customClone);

        workspaceAnimationWindowClone?.hide();

        this._resetTimer = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            workspaceSwitchAnimationDuration,
            () => {
                this.resetAnimation();
                this._resetTimer = 0;
            }
        );
    }

    _cancelGeometryUpdate() {
        if (this._laterID) {
            global.compositor.get_laters().remove(this._laterID);
            this._laterID = 0;
        }
    }

    _createOutline(window, monitorContainer) {
        const { x, y, width, height } = window.get_frame_rect();
        const outline = new St.Widget({
            style: this._getCssStyle(),
            x: x - monitorContainer.x - this._outlineSize,
            y: y - monitorContainer.y - this._outlineSize,
            width: width + 2 * this._outlineSize,
            height: height + 2 * this._outlineSize
        });

        return outline;
    }

    _queueGeometryUpdate() {
        const windowActor = this._window.get_compositor_private();

        if (!windowActor)
            return;

        this._laterID = global.compositor
            .get_laters()
            .add(Meta.LaterType.BEFORE_REDRAW, () => {
                this._updateGeometry();
                this._outline.set_style(this._getCssStyle());
                this._outline.show();

                global.window_group.set_child_below_sibling(
                    this._outline,
                    windowActor
                );

                this._laterID = 0;
                return GLib.SOURCE_REMOVE;
            });
    }

    _updateOutline() {
        this._cancelGeometryUpdate();

        this._window?.disconnectObject(this);

        const window = global.display.focus_window;

        if (!window || !this._allowedWindowType(window.get_window_type())) {
            this._outline.hide();
            return;
        }

        this._window = window;
        this._window.connectObject(
            'position-changed',
            () => this._updateGeometry(),
            'size-changed',
            () => this._updateGeometry(),
            this
        );

        if (
            this._window.is_fullscreen() ||
            this._window.get_maximized() === Meta.MaximizeFlags.BOTH
        )
            this._outline.hide();
        else
            this._queueGeometryUpdate();
    }

    _updateGeometry() {
        const { x, y, width, height } = this._window.get_frame_rect();

        this._outline.set({
            x: x - this._outlineSize,
            y: y - this._outlineSize,
            width: width + this._outlineSize * 2,
            height: height + this._outlineSize * 2
        });
    }
}

/**
 * Gets the absolute position of a Clutter.AcotActor.
 * `Clutter.Actor.get_transformed_position` doesn't work as I expected it
 *
 * @param {Clutter.Actor} actor
 *
 * @returns {{x: number, y: number}}
 */
function getAbsPos(actor) {
    const pos = { x: actor.x, y: actor.y };
    let parent = actor.get_parent();

    while (parent) {
        pos.x += parent.x;
        pos.y += parent.y;

        parent = parent.get_parent();
    }

    return pos;
}

/**
 * Creates containers to put clones of the monitor/workspace into to create a
 * workspaceSwitch with the focus hint
 *
 * @param {Meta.Window} window
 * @param {Clutter.Clone} workspaceAnimationWindowClone
 * @param {number} workspaceSwitchAnimationDuration
 *
 * @returns {[Clutter.Actor, Clutter.Actor]} a monitor and a workspace containers
 *      for Clutter.Clones that are laid over the actual actors
 */
function createContainers(
    window,
    workspaceAnimationWindowClone,
    workspaceSwitchAnimationDuration
) {
    const monitorNr = window.get_monitor();
    const monitorRect = global.display.get_monitor_geometry(monitorNr);
    let startingPos;

    if (workspaceAnimationWindowClone) {
        const actorAbsPos = getAbsPos(window.get_compositor_private(), monitorNr);
        const cloneAbsPos = getAbsPos(workspaceAnimationWindowClone, monitorNr);

        startingPos = {
            x: monitorRect.x + cloneAbsPos.x - actorAbsPos.x,
            y: monitorRect.y + cloneAbsPos.y - actorAbsPos.y
        };
    } else {
        startingPos = { x: 0, y: 0 };
    }

    const monitorContainer = new Clutter.Actor({
        clip_to_allocation: true,
        x: monitorRect.x,
        y: monitorRect.y,
        width: monitorRect.width,
        height: monitorRect.height
    });

    // Allow tiled window to be animate above the panel. Also, When changing
    // workspaces we want to put everything above the animating clones.
    if (workspaceAnimationWindowClone) {
        const osdWindow = Main.uiGroup
            .get_children()
            .find(child => child instanceof OsdWindow.OsdWindow);

        if (osdWindow)
            Main.uiGroup.insert_child_below(monitorContainer, osdWindow);
        else
            Main.uiGroup.add_child(monitorContainer);
    } else {
        global.window_group.add_child(monitorContainer);
    }

    const workspaceContainer = new Clutter.Actor({
        x: startingPos.x,
        y: startingPos.y,
        width: monitorContainer.width,
        height: monitorContainer.height
    });

    monitorContainer.add_child(workspaceContainer);

    workspaceContainer.ease({
        x: 0,
        y: 0,
        duration: workspaceSwitchAnimationDuration,
        mode: Clutter.AnimationMode.EASE_OUT_CUBIC
    });

    return [monitorContainer, workspaceContainer];
}

/**
 * Creates a clone of a window actor for the custom workspaceSwitch animation
 * with the focus hint
 *
 * @param {Meta.WindowActor} windowActor
 * @param {Clutter.Actor} container
 *
 * @returns {Clutter.Clone}
 */
function createWindowClone(windowActor, container) {
    const monitor = windowActor.get_meta_window().get_monitor();
    const { x, y } = getAbsPos(windowActor, monitor);

    const windowClone = new Clutter.Clone({
        source: windowActor,
        x: x - container.x,
        y: y - container.y,
        width: windowActor.width,
        height: windowActor.height
    });

    return windowClone;
}

/**
 * Finds the window clone of a window during the native workspaceSwitch animation
 *
 * @param {Meta.WindowActor} windowActor
 * @param {boolean} animatingWorkspaceSwitch
 *
 * @returns {Clutter.Clone|null} the clone. It may be `null` if the focus is on
 *      the secondary monitor with 'WS only on primary display'
 */
function findWindowCloneForWorkspaceAnimation(
    windowActor,
    animatingWorkspaceSwitch
) {
    if (!animatingWorkspaceSwitch)
        return null;

    const switchData = Main.wm._workspaceAnimation._switchData;
    let clone = null;

    switchData.monitors.find(monitorGroup => {
        return monitorGroup._workspaceGroups.find(workspaceGroup => {
            return workspaceGroup._windowRecords.find(record => {
                const foundClone = record.windowActor === windowActor;

                if (foundClone)
                    ({ clone } = record);

                return foundClone;
            });
        });
    });

    return clone;
}
