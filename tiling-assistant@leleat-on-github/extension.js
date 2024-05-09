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

import { Gio, GLib, Meta } from './src/dependencies/gi.js';
import { Extension, Main } from './src/dependencies/shell.js';

import MoveHandler from './src/extension/moveHandler.js';
import ResizeHandler from './src/extension/resizeHandler.js';
import KeybindingHandler from './src/extension/keybindingHandler.js';
import LayoutsManager from './src/extension/layoutsManager.js';
import ActiveWindowHint from './src/extension/activeWindowHint.js';
import AltTabOverride from './src/extension/altTab.js';
import {
    disable as disableInjections,
    enable as enableInjections
} from './src/extension/injections.js';
import {
    disable as disableSettings,
    enable as enableSettings,
    Settings
} from './src/extension/settings.js';
import {
    disable as disableTimeouts,
    enable as enableTimeouts
} from './src/extension/timeouts.js';
import { Rect } from './src/extension/utility.js';

/**
 * 2 entry points:
 * 1. keyboard shortcuts:
 *  => keybindingHandler.js
 * 2. Grabbing a window:
 *  => moveHandler.js (when moving a window)
 *  => resizeHandler.js (when resizing a window)
 */

export default class TilingAssistantExtension extends Extension {
    async enable() {
        // (utility) singletons
        enableTimeouts();
        enableSettings();
        enableInjections();

        const twmModule = await import('./src/extension/tilingWindowManager.js');

        this._twm = twmModule.TilingWindowManager;
        this._twm.initialize();

        this._moveHandler = new MoveHandler();
        this._resizeHandler = new ResizeHandler();
        this._keybindingHandler = new KeybindingHandler();
        this._layoutsManager = new LayoutsManager();
        this._activeWindowHintHandler = new ActiveWindowHint();
        this._altTabOverride = new AltTabOverride();

        // Disable native tiling.
        Settings.override(
            new Gio.Settings({ schema_id: 'org.gnome.mutter' }),
            'edge-tiling',
            new GLib.Variant('b', false)
        );

        // Disable native keybindings for Super+Up/Down/Left/Right
        const gnomeMutterKeybindings = new Gio.Settings({
            schema_id: 'org.gnome.mutter.keybindings'
        });
        const gnomeDesktopKeybindings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.wm.keybindings'
        });
        const emptyStrvVariant = new GLib.Variant('as', []);

        if (
            gnomeDesktopKeybindings.get_strv('maximize').includes('<Super>Up') &&
            Settings.getGioObject().get_strv('tile-maximize').includes('<Super>Up')
        ) {
            Settings.override(
                gnomeDesktopKeybindings,
                'maximize',
                emptyStrvVariant
            );
        }

        if (
            gnomeDesktopKeybindings.get_strv('unmaximize').includes('<Super>Down') &&
            Settings.getGioObject().get_strv('restore-window').includes('<Super>Down')
        ) {
            Settings.override(
                gnomeDesktopKeybindings,
                'unmaximize',
                emptyStrvVariant
            );
        }

        if (
            gnomeMutterKeybindings.get_strv('toggle-tiled-left').includes('<Super>Left') &&
            Settings.getGioObject().get_strv('tile-left-half').includes('<Super>Left')
        ) {
            Settings.override(
                gnomeMutterKeybindings,
                'toggle-tiled-left',
                emptyStrvVariant
            );
        }

        if (
            gnomeMutterKeybindings.get_strv('toggle-tiled-right').includes('<Super>Right') &&
            Settings.getGioObject().get_strv('tile-right-half').includes('<Super>Right')
        ) {
            Settings.override(
                gnomeMutterKeybindings,
                'toggle-tiled-right',
                emptyStrvVariant
            );
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
        this._loadAfterSessionLock();

        // Setting used for detection of a fresh install and do compatibility
        // changes if necessary...
        Settings.setLastVersionInstalled(this.metadata.version);
    }

    disable() {
        // Save tiled window properties, if the session was locked to restore
        // them after the session is unlocked again.
        this._saveBeforeSessionLock();

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

        disableInjections();
        disableSettings();
        disableTimeouts();

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
    _saveBeforeSessionLock() {
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
        const openWindows = this._twm.getWindows(true);
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

        try {
            parent.make_directory_with_parents(null);
        } catch (e) {
            if (e.code !== Gio.IOErrorEnum.EXISTS) {
                throw e;
            }
        }

        const path = GLib.build_filenamev([parentPath, '/tiledSessionRestore.json']);
        const file = Gio.File.new_for_path(path);

        try {
            file.create(Gio.FileCreateFlags.NONE, null);
        } catch (e) {
            if (e.code !== Gio.IOErrorEnum.EXISTS) {
                throw e;
            }
        }

        file.replace_contents(JSON.stringify(saveObj), null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    }

    /**
     * Extensions are disabled when the screen is locked. After having saved them,
     * reload them here.
     */
    _loadAfterSessionLock() {
        if (!this._wasLocked)
            return;

        this._wasLocked = false;

        const userPath = GLib.get_user_config_dir();
        const path = GLib.build_filenamev([userPath, '/tiling-assistant/tiledSessionRestore.json']);
        const file = Gio.File.new_for_path(path);
        if (!file.query_exists(null))
            return;

        try {
            file.create(Gio.FileCreateFlags.NONE, null);
        } catch (e) {
            if (e.code !== Gio.IOErrorEnum.EXISTS) {
                throw e;
            }
        }

        const [success, contents] = file.load_contents(null);
        if (!success || !contents.length)
            return;

        const openWindows = this._twm.getWindows(true);
        const saveObj = JSON.parse(new TextDecoder().decode(contents));

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
}
