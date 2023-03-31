/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

'use strict';

const { Gio, GLib, Meta } = imports.gi;
const ByteArray = imports.byteArray;
const Main = imports.ui.main;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const { Rect, Util } = Me.imports.src.extension.utility;

/**
 * 2 entry points:
 * 1. keyboard shortcuts:
 *  => keybindingHandler.js
 * 2. Grabbing a window:
 *  => moveHandler.js (when moving a window)
 *  => resizeHandler.js (when resizing a window)
 */

class SettingsOverrider {
    constructor() {
        this._backend = Gio.SettingsBackend.get_default();
        this._overriddenValues = new Map();

        this._originalSettingsRead = Util.overrideVFunc(
            this._backend.constructor.prototype, 'read',
            (key, expectedType, defaultValue) => {
                const overridden = this._overriddenValues.get(key);
                if (overridden !== undefined) {
                    if (overridden?.is_of_type(expectedType) !== false)
                        return overridden;

                    logError(new Error(),
                        'Overriden value is of an invalid type: ' +
                        `${expectedType} vs ${overridden?.get_type()}`);
                }

                return this._originalSettingsRead.call(this._backend,
                    key, expectedType, defaultValue);
            });
    }

    _getSettingPath(schema, key) {
        return `/${schema.replaceAll('.', '/')}/${key}`;
    }

    add(schema, key, value) {
        const path = this._getSettingPath(schema, key);
        this._overriddenValues.set(path, value);
        this._backend.changed(path, this);
    }

    remove(schema, key) {
        const path = this._getSettingPath(schema, key);
        this._overriddenValues.delete(path);
        this._backend.changed(path, this);

        if (!this._overriddenValues.size)
            this._clear();
    }

    _clear() {
        if (this._originalSettingsRead) {
            Util.overrideVFunc(this._backend.constructor.prototype,
                'read', this._originalSettingsRead);
            this._originalSettingsRead = null;
        }

        this._overriddenValues?.forEach((_value, key) =>
            this._backend.changed(key, this));
        this._overriddenValues = null;
    }

    destroy() {
        this._clear();
    }
}

function init() {
    ExtensionUtils.initTranslations(Me.metadata.uuid);
}

function enable() {
    this._settings = Me.imports.src.common.Settings;
    this._settings.initialize();
    this._settingsOverrider = new SettingsOverrider();

    this._twm = Me.imports.src.extension.tilingWindowManager.TilingWindowManager;
    this._twm.initialize();

    const MoveHandler = Me.imports.src.extension.moveHandler;
    this._moveHandler = new MoveHandler.Handler();
    const ResizeHandler = Me.imports.src.extension.resizeHandler;
    this._resizeHandler = new ResizeHandler.Handler();
    const KeybindingHandler = Me.imports.src.extension.keybindingHandler;
    this._keybindingHandler = new KeybindingHandler.Handler();
    const LayoutsManager = Me.imports.src.extension.layoutsManager;
    this._layoutsManager = new LayoutsManager.LayoutManager();
    const activeWindowHint = Me.imports.src.extension.activeWindowHint;
    this._activeWindowHintHandler = new activeWindowHint.Handler();

    const AltTabOverride = Me.imports.src.extension.altTab.Override;
    this._altTabOverride = new AltTabOverride();

    // Disable native tiling.
    this._settingsOverrider.add('org.gnome.mutter', 'edge-tiling',
        new GLib.Variant('b', false));

    // Disable native keybindings for Super+Up/Down/Left/Right
    const gnomeMutterKeybindings = ExtensionUtils.getSettings(
        'org.gnome.mutter.keybindings');
    const gnomeDesktopKeybindings = ExtensionUtils.getSettings(
        'org.gnome.desktop.wm.keybindings');
    const sc = Me.imports.src.common.Shortcuts;
    const emptyStrvVariant = new GLib.Variant('as', []);

    if (gnomeDesktopKeybindings.get_strv('maximize').includes('<Super>Up') &&
            this._settings.getStrv(sc.MAXIMIZE).includes('<Super>Up')) {
        this._settingsOverrider.add(gnomeDesktopKeybindings.schemaId,
            'maximize', emptyStrvVariant);
    }
    if (gnomeDesktopKeybindings.get_strv('unmaximize').includes('<Super>Down') &&
            this._settings.getStrv(sc.RESTORE_WINDOW).includes('<Super>Down')) {
        this._settingsOverrider.add(gnomeDesktopKeybindings.schemaId,
            'unmaximize', emptyStrvVariant);
    }
    if (gnomeMutterKeybindings.get_strv('toggle-tiled-left').includes('<Super>Left') &&
            this._settings.getStrv(sc.LEFT).includes('<Super>Left')) {
        this._settingsOverrider.add(gnomeMutterKeybindings.schemaId,
            'toggle-tiled-left', emptyStrvVariant);
    }
    if (gnomeMutterKeybindings.get_strv('toggle-tiled-right').includes('<Super>Right') &&
            this._settings.getStrv(sc.RIGHT).includes('<Super>Right')) {
        this._settingsOverrider.add(gnomeMutterKeybindings.schemaId,
            'toggle-tiled-right', emptyStrvVariant);
    }

    // Include tiled windows when dragging from the top panel.
    this._getDraggableWindowForPosition = Main.panel._getDraggableWindowForPosition;
    Main.panel._getDraggableWindowForPosition = function (stageX) {
        const workspaceManager = global.workspace_manager;
        const windows = workspaceManager.get_active_workspace().list_windows();
        const allWindowsByStacking = global.display.sort_windows_by_stacking(windows).reverse();

        return allWindowsByStacking.find(w => {
            const rect = w.get_frame_rect();
            const workArea = w.get_work_area_current_monitor();
            return w.is_on_primary_monitor() &&
                    w.showing_on_its_workspace() &&
                    w.get_window_type() !== Meta.WindowType.DESKTOP &&
                    (w.maximized_vertically || w.tiledRect?.y === workArea.y) &&
                    stageX > rect.x && stageX < rect.x + rect.width;
        });
    };

    // Restore tiled window properties after session was unlocked.
    _loadAfterSessionLock();

    // Setting used for detection of a fresh install and do compatibility
    // changes if necessary...
    this._settings.setInt('last-version-installed', Me.metadata.version);
}

function disable() {
    // Save tiled window properties, if the session was locked to restore
    // them after the session is unlocked again.
    _saveBeforeSessionLock();

    this._settingsOverrider.destroy();
    this._settingsOverrider = null;
    this._moveHandler.destroy();
    this._moveHandler = null;
    this._resizeHandler.destroy();
    this._resizeHandler = null;
    this._keybindingHandler.destroy();
    this._keybindingHandler = null;
    this._layoutsManager.destroy();
    this._layoutsManager = null;
    this._activeWindowHintHandler.destroy();
    this._activeWindowHintHandler = null;

    this._altTabOverride.destroy();
    this._altTabOverride = null;

    this._twm.destroy();
    this._twm = null;

    this._settings.destroy();
    this._settings = null;

    // Restore old functions.
    Main.panel._getDraggableWindowForPosition = this._getDraggableWindowForPosition;
    this._getDraggableWindowForPosition = null;

    // Delete custom tiling properties.
    const openWindows = global.display.get_tab_list(Meta.TabList.NORMAL, null);
    openWindows.forEach(w => {
        delete w.isTiled;
        delete w.tiledRect;
        delete w.untiledRect;
    });
}

/**
 * Extensions are disabled when the screen is locked. So save the custom tiling
 * properties of windows before locking the screen.
 */
function _saveBeforeSessionLock() {
    if (!Main.sessionMode.isLocked)
        return;

    this._wasLocked = true;

    const rectToJsObj = rect => rect && {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
    };

    // can't just check for isTiled because maximized windows may
    // have an untiledRect as well in case window gaps are used
    const openWindows = this._twm.getWindows(false);
    const savedWindows = openWindows.filter(w => w.untiledRect).map(w => {
        return {
            windowId: w.get_stable_sequence(),
            isTiled: w.isTiled,
            tiledRect: rectToJsObj(w.tiledRect),
            untiledRect: rectToJsObj(w.untiledRect)
        };
    });

    const saveObj = {
        'windows': savedWindows,
        'tileGroups': Array.from(this._twm.getTileGroups())
    };

    const userPath = GLib.get_user_config_dir();
    const parentPath = GLib.build_filenamev([userPath, '/tiling-assistant']);
    const parent = Gio.File.new_for_path(parentPath);
    try { parent.make_directory_with_parents(null); } catch (e) {}
    const path = GLib.build_filenamev([parentPath, '/tiledSessionRestore.json']);
    const file = Gio.File.new_for_path(path);
    try { file.create(Gio.FileCreateFlags.NONE, null); } catch (e) {}
    file.replace_contents(JSON.stringify(saveObj), null, false,
        Gio.FileCreateFlags.REPLACE_DESTINATION, null);
}

/**
 * Extensions are disabled when the screen is locked. After having saved them,
 * reload them here.
 */
function _loadAfterSessionLock() {
    if (!this._wasLocked)
        return;

    this._wasLocked = false;

    const userPath = GLib.get_user_config_dir();
    const path = GLib.build_filenamev([userPath, '/tiling-assistant/tiledSessionRestore.json']);
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null))
        return;

    try { file.create(Gio.FileCreateFlags.NONE, null); } catch (e) {}
    const [success, contents] = file.load_contents(null);
    if (!success || !contents.length)
        return;

    const openWindows = this._twm.getWindows(false);
    const saveObj = JSON.parse(ByteArray.toString(contents));

    const windowObjects = saveObj['windows'];
    windowObjects.forEach(wObj => {
        const { windowId, isTiled, tiledRect, untiledRect } = wObj;
        const window = openWindows.find(w => w.get_stable_sequence() === windowId);
        if (!window)
            return;

        const jsToRect = jsRect => jsRect && new Rect(
            jsRect.x, jsRect.y, jsRect.width, jsRect.height
        );

        window.isTiled = isTiled;
        window.tiledRect = jsToRect(tiledRect);
        window.untiledRect = jsToRect(untiledRect);
    });

    const tileGroups = new Map(saveObj['tileGroups']);
    this._twm.setTileGroups(tileGroups);
    openWindows.forEach(w => {
        if (tileGroups.has(w.get_id())) {
            const group = this._twm.getTileGroupFor(w);
            this._twm.updateTileGroup(group);
        }
    });
}
