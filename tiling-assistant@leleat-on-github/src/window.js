'use strict';

const { Clutter, GObject, Meta } = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const { Rect } = Me.imports.src.util;

/**
 * A class implementing a singleton. It tracks the Window wrapper objects
 * and provides some window manager related utility methods.
 */
var WindowManager = GObject.registerClass({
}, class WindowManager extends Clutter.Actor {
    static #allowConstruction = false;
    static #SINGLETON = null;

    /**
     * Gets the singleton instance.
     * @returns {WindowManager}
     */
    static get() {
        if (!WindowManager.#SINGLETON) {
            WindowManager.#allowConstruction = true;
            WindowManager.#SINGLETON = new WindowManager();
            WindowManager.#allowConstruction = false;

            // The window wrapper class depends on the WindowManager being
            // constructed because we only want to create a window wrapper for a
            // meta window if we haven't created a wrapper for it yet. So we can
            // only start tracking windows after the WindowManager was instanced.
            WindowManager.#SINGLETON.#trackExistingMetaWindows();
        }

        return WindowManager.#SINGLETON;
    }

    /** @type {Map<Meta.Window, Window>} */
    #windows = new Map();

    /** @private */
    constructor() {
        if (!WindowManager.#allowConstruction)
            throw new Error('WindowManager is a Singleton. Use WindowManager.get().');

        super();

        global.display.connectObject('window-created',
            (display, metaWindow) => this.#trackMetaWindow(metaWindow), this);
    }

    destroy() {
        this.#windows.forEach(w => w.destroy());
        this.#windows.clear();

        WindowManager.#SINGLETON = null;

        super.destroy();
    }

    /**
     * @param {Meta.Window} window
     * @returns {Window}
     */
    getWindow(window) {
        return this.#windows.get(window);
    }

    /**
     * Gets the open windows. By default, the resulting array will be limited to
     * the current monitor and the current workspace.
     * @param {Object} params
     * @param {boolean} params.currentMonitor
     * @param {boolean} params.currentWorkspace
     * @returns {Window[]}
     */
    getWindows({ currentMonitor = true, currentWorkspace = true } = {}) {
        const metaWindows = [...this.#windows.values()].map(w => w.wrappedObj);
        const sortedMetaWindows = global.display
            .sort_windows_by_stacking(metaWindows).reverse();
        const sortedWindows = sortedMetaWindows.map(m => this.getWindow(m));

        return sortedWindows.filter(w => {
            if (currentMonitor && w.monitor !== global.display.get_current_monitor())
                return false;

            if (currentWorkspace && w.getWorkspace() !== this.getActiveWorkspace())
                return false;

            return true;
        });
    }

    /** @returns {Window} */
    getFocusedWindow() {
        return this.getWindow(global.display.focus_window);
    }

    /** @returns {Meta.Workspace} */
    getActiveWorkspace() {
        const workspaceManager = global.display.get_workspace_manager();
        return workspaceManager.get_active_workspace();
    }

    /**
     * @param {number} monitor
     * @returns {Rect}
     */
    getWorkArea(monitor) {
        const activeWs = this.getActiveWorkspace();
        const metaRect = activeWs.get_work_area_for_monitor(monitor);
        return new Rect(metaRect);
    }

    /**
     * Creates and tracks Window wrappers for the existing Meta.Windows. This is
     * needed when the screen is unlocked or when gnome shell is restarted (x11).
     */
    #trackExistingMetaWindows() {
        const metaWindows = imports.ui.altTab.getWindows(null);
        metaWindows.forEach(w => this.#trackMetaWindow(w));
    }

    /**
     * Creates a Window wrapper for `metaWindow` and keeps it around as long as
     * `metaWindow` exists.
     * @param {Meta.Window} metaWindow
     */
    #trackMetaWindow(metaWindow) {
        if (this.#windows.has(metaWindow))
            return;

        // ignored types taken from META_WINDOW_IN_NORMAL_TAB_CHAIN_TYPE
        const windowType = metaWindow.get_window_type();
        if ([Meta.WindowType.DOCK, Meta.WindowType.DESKTOP].includes(windowType))
            return;

        const window = new Window(metaWindow);
        this.#windows.set(metaWindow, window);

        metaWindow.connectObject('unmanaging', w => {
            if (!this.#windows.has(w))
                return;

            this.#windows.get(w).destroy();
            this.#windows.delete(w);
        }, this);
    }
});

/**
 * A wrapper class for a Meta.Window. In actuality instances of this class will
 * be used as a handler for a Proxy. @see Window.constructor.
 */
const Window = class Window {
    /**
     * Converts `value` to a Meta.Window if it's an instance of Window.
     * Otherwise just return `value`.
     * @param {*} value
     * @returns {*}
     */
    static #convertValueToMeta(value) {
        if (value.wrappedObj)
            return value.wrappedObj;
        else if (Array.isArray(value))
            return value.map(v => this.#convertValueToMeta(v));
        else
            return value;
    }

    /**
     * Converts `value` to a Window if it's an instance of Meta.Window.
     * Otherwise just return `value`.
     * @param {*} value
     * @returns {*}
     */
    static #convertValueToWrapper(value) {
        if (value instanceof Meta.Window)
            return new Window(value);
        else if (value instanceof Meta.Rectangle)
            return new Rect(value);
        else if (Array.isArray(value))
            return value.map(v => this.#convertValueToWrapper(v));
        else
            return value;
    }

    /**
     * The rect that saves the window's floating rect. It's set
     * when a window is tiled and unset if it's untiled.
     * @type {Rect|null}
     */
    #floatingRect = null;
    /** @type {Tile|null} */
    #tile = null;
    /** @type {Meta.Window} */
    #wrappedObj = null;

    /**
     * Creates a wrapper for a Meta.Window. This actually returns a Proxy
     * using the instance of this class as the handler.
     * @param {Meta.Window} window
     * @returns {Proxy}
     */
    constructor(window) {
        if (window.wrappedObj)
            return window;

        const alreadyTrackedWin = WindowManager.get().getWindow(window);
        if (alreadyTrackedWin)
            return alreadyTrackedWin;

        this.#wrappedObj = window;

        return new Proxy(this.#wrappedObj, this);
    }

    /**
     * Traps the internal [[Get]] method. If the property is from the wrapped
     * object, get the property from it. Otherwise get the property from `this`.
     * @param {Meta.Window} target
     * @param {string} property
     * @returns
     */
    get(target, property) {
        const snakeCaseProperty = property.replace(/[A-Z]/g, v =>
            `_${v.toLowerCase()}`);

        if (snakeCaseProperty in target) {
            if (typeof target[snakeCaseProperty] === 'function') {
                return function (...args) {
                    const metaArgs = args.map(v => Window.#convertValueToMeta(v));
                    const returnVal = target[snakeCaseProperty](...metaArgs);
                    return Window.#convertValueToWrapper(returnVal);
                };
            } else {
                return target[snakeCaseProperty];
            }
        }

        return typeof this[property] === 'function'
            ? this[property].bind(this)
            : this[property];
    }

    /**
     * Traps the internal [[Set]] method and routes everything to `this` class.
     * @param {Meta.Window} target - The wrapped object.
     * @param {string} property
     * @param {*} value
     * @returns
     */
    set(target, property, value) {
        this[property] = value;
        return true;
    }

    destroy() {
        this.#tile = null;
        this.#wrappedObj = null;
        this.#floatingRect = null;
    }

    /** @returns {Meta.WindowActor} */
    get actor() {
        return this.#wrappedObj.get_compositor_private();
    }

    /** @returns {Rect} */
    get floatingRect() {
        return this.#floatingRect;
    }

    /** @param {Rect} */
    set floatingRect(rect) {
        this.#floatingRect = rect;
    }

    /** @returns {boolean} */
    get maximized() {
        return this.#tile && !this.tiled;
    }

    /** @returns {number} */
    get monitor() {
        return this.#wrappedObj.get_monitor();
    }

    /** @returns {Rect} */
    get rect() {
        return new Rect(this.#wrappedObj.get_frame_rect());
    }

    /** @returns {boolean} */
    get tilable() {
        return this.#wrappedObj.get_window_type() === Meta.WindowType.NORMAL &&
            !this.#wrappedObj.is_skip_taskbar() &&
            /* assume that a max/fullscreen window can move/resize after unmaxing */
            (this.#wrappedObj.allows_move() && this.#wrappedObj.allows_resize() ||
            (this.#wrappedObj.get_maximized() || this.#wrappedObj.is_fullscreen()));
    }

    /** @returns {Tile} */
    get tile() {
        return this.#tile;
    }

    /** @param {Tile} */
    set tile(tile) {
        this.#tile = tile;
    }

    /** @returns {boolean} */
    get tiled() {
        const workArea = this.#wrappedObj.get_work_area_current_monitor();
        return this.#tile && !this.#tile.rect.equal(workArea);
    }

    /** @returns {Meta.Window} */
    get wrappedObj() {
        return this.#wrappedObj;
    }
};
