'use strict';

const { Meta } = imports.gi;

const { main: Main } = imports.ui;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

/** A singleton class that sets everything up. */
var AssistantManager = class AssistantManager {
    static #allowConstruction = false;
    static #SINGLETON = null;

    /**
     * Gets the singleton instance.
     * @returns {AssistantManager}
     */
    static get() {
        if (!AssistantManager.#SINGLETON) {
            AssistantManager.#allowConstruction = true;
            AssistantManager.#SINGLETON = new AssistantManager();
            AssistantManager.#allowConstruction = false;
        }

        return AssistantManager.#SINGLETON;
    }

    /** @type {GrabHandler} */
    #grabHandler = null;
    /** @type {ShortcutHandler} */
    #shortcutHandler = null;
    /** @type {TileGroupManager[]} */
    #tileGroupManagers = [];
    /** @type {function} */
    #panelDragFunc = null;

    /** @private */
    constructor() {
        if (!AssistantManager.#allowConstruction)
            throw new Error('AssistantManager is a Singleton. Use AssistantManager.get().');

        this.#overridePanelDrag();
        this.#setupTileGroupManagers();

        this.#grabHandler = new Me.imports.src.grabHandler.GrabHandler();
        this.#shortcutHandler = new Me.imports.src.shortcutHandler.ShortcutHandler();
    }

    destroy() {
        this.#restorePanelDrag();
        this.#destroyTileGroupManagers();

        this.#grabHandler.destroy();
        this.#grabHandler = null;
        this.#shortcutHandler.destroy();
        this.#shortcutHandler = null;

        AssistantManager.#SINGLETON = null;
    }

    /**
     * Gets the tile group manager for the current monitor i. e. the monitor,
     * which contains the pointer.
     * @returns {TileGroupManager}
     */
    getCurrentTileGroupManager() {
        const monitor = global.display.get_current_monitor();
        return this.#tileGroupManagers[monitor];
    }

    /**
     * Overrides GNOME Shell's function so that windows tiled or maximized with
     * the extension will be untiled/unmaximized when dragging from the top panel.
     */
    #overridePanelDrag() {
        const { WindowManager } = Me.imports.src.window;

        this.#panelDragFunc = Main.panel._getDraggableWindowForPosition;
        Main.panel._getDraggableWindowForPosition = function (stageX) {
            const workspaceManager = global.workspace_manager;
            const metas = workspaceManager.get_active_workspace().list_windows();
            const stackSortedMetas = global.display.sort_windows_by_stacking(metas).reverse();
            return stackSortedMetas.find(meta => {
                const rect = meta.get_frame_rect();
                const workArea = meta.get_work_area_current_monitor();
                const wrapped = WindowManager.get().getWindow(meta);
                return meta.is_on_primary_monitor() &&
                        meta.showing_on_its_workspace() &&
                        meta.get_window_type() !== Meta.WindowType.DESKTOP &&
                        wrapped.tile?.rect.y === workArea.y &&
                        stageX > rect.x && stageX < rect.x + rect.width;
            });
        };
    }

    /** Restores GNOME Shell's original behavior when dragging from the panel. */
    #restorePanelDrag() {
        Main.panel._getDraggableWindowForPosition = this.#panelDragFunc;
        this.#panelDragFunc = null;
    }

    /** Instances the tile group managers for each monitor. */
    #setupTileGroupManagers() {
        const { TileGroupManager } = Me.imports.src.tile;

        Main.layoutManager.monitors.forEach(m => {
            const tileGroupManager = new TileGroupManager({ monitor: m.index });
            this.#tileGroupManagers.push(tileGroupManager);
        });
    }

    /** Destroys and cleans the tile group managers up. */
    #destroyTileGroupManagers() {
        this.#tileGroupManagers.forEach(m => m.destroy());
        this.#tileGroupManagers = [];
    }
};
