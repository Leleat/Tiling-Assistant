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

import { Gio, GLib, Meta, Mtk } from './src/dependencies/gi.js';
import { Extension, Main } from './src/dependencies/shell.js';

import { Direction, Orientation } from './src/common.js';
import {
    disable as disableActiveWindowHint,
    enable as enableActiveWindowHint
} from './src/extension/activeWindowHint.js';
import {
    disable as disableAltTabOverride,
    enable as enableAltTabOverride
} from './src/extension/altTab.js';
import {
    disable as disableInjections,
    enable as enableInjections,
    Injections
} from './src/extension/injections.js';
import {
    disable as disableKeybindingHandler,
    enable as enableKeybindingHandler
} from './src/extension/keybindingHandler.js';
import {
    disable as disableLayoutsManager,
    enable as enableLayoutsManager
} from './src/extension/layoutsManager.js';
import {
    disable as disableMoveHandler,
    enable as enableMoveHandler
} from './src/extension/moveHandler.js';
import {
    disable as disableResizeHandler,
    enable as enableResizeHandler
} from './src/extension/resizeHandler.js';
import {
    disable as disableSettings,
    enable as enableSettings,
    Settings
} from './src/extension/settings.js';
import {
    disable as disableTilingWindowManager,
    enable as enableTilingWindowManager,
    TilingWindowManager as Twm
} from './src/extension/tilingWindowManager.js';
import {
    disable as disableTimeouts,
    enable as enableTimeouts
} from './src/extension/timeouts.js';
import { getScaledGap, useIndividualGaps } from './src/extension/utility.js';

/**
 * 2 entry points:
 * 1. keyboard shortcuts:
 *  => keybindingHandler.js
 * 2. Grabbing a window:
 *  => moveHandler.js (when moving a window)
 *  => resizeHandler.js (when resizing a window)
 */

export default class TilingAssistantExtension extends Extension {
    enable() {
        // (utility) singletons
        enableTimeouts();
        enableSettings();
        enableInjections();

        // injections/overrides
        injectMtkRectangle();
        overrideNativeSettings();
        overrideTopPanelDrag();

        // features/modules
        enableTilingWindowManager();
        enableMoveHandler();
        enableResizeHandler();
        enableKeybindingHandler();
        enableLayoutsManager();
        enableActiveWindowHint();
        enableAltTabOverride();

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

        disableAltTabOverride();
        disableActiveWindowHint();
        disableLayoutsManager();
        disableKeybindingHandler();
        disableResizeHandler();
        disableMoveHandler();
        disableTilingWindowManager();

        disableInjections();
        disableSettings();
        disableTimeouts();

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
        const openWindows = Twm.getWindows(true);
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
            'tileGroups': Array.from(Twm.getTileGroups())
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

        const openWindows = Twm.getWindows(true);
        const saveObj = JSON.parse(new TextDecoder().decode(contents));

        const windowObjects = saveObj['windows'];
        windowObjects.forEach(wObj => {
            const { windowId, isTiled, tiledRect, untiledRect } = wObj;
            const window = openWindows.find(w => w.get_stable_sequence() === windowId);
            if (!window)
                return;

            const jsToRect = jsRect => jsRect && new Mtk.Rectangle({
                x: jsRect.x,
                y: jsRect.y,
                width: jsRect.width,
                height: jsRect.height
            });

            window.isTiled = isTiled;
            window.tiledRect = jsToRect(tiledRect);
            window.untiledRect = jsToRect(untiledRect);
        });

        const tileGroups = new Map(saveObj['tileGroups']);
        Twm.setTileGroups(tileGroups);
        openWindows.forEach(w => {
            if (tileGroups.has(w.get_id())) {
                const group = Twm.getTileGroupFor(w);
                Twm.updateTileGroup(group);
            }
        });
    }
}

function injectMtkRectangle() {
    Injections.addAccessorProperty(Mtk.Rectangle.prototype, 'x2', {
        get() {
            return this.x + this.width;
        },
        set(value) {
            this.width = Math.floor(value) - this.x;
        }
    });

    Injections.addAccessorProperty(Mtk.Rectangle.prototype, 'y2', {
        get() {
            return this.y + this.height;
        },
        set(value) {
            this.height = Math.floor(value) - this.y;
        }
    });

    Injections.addAccessorProperty(Mtk.Rectangle.prototype, 'center', {
        get() {
            return {
                x: this.x + Math.floor(this.width / 2),
                y: this.y + Math.floor(this.height / 2)
            };
        }
    });

    Injections.overrideMethod(Mtk.Rectangle.prototype, 'add_gaps', () => {
        /**
         * Gets a new rectangle where the screen and window gaps were
         * added/subbed to/from `this`.
         *
         * @param {Mtk.Rectangle} rect a tiled Mtk.Rectangle
         * @param {number} monitor the number of the monitor to scale the gap to
         * @returns {Mtk.Rectangle} the rectangle after the gaps were taken into account
         */
        return function (workArea, monitor) {
            const screenTopGap = getScaledGap('screen-top-gap', monitor);
            const screenLeftGap = getScaledGap('screen-left-gap', monitor);
            const screenRightGap = getScaledGap('screen-right-gap', monitor);
            const screenBottomGap = getScaledGap('screen-bottom-gap', monitor);
            const singleScreenGap = getScaledGap('single-screen-gap', monitor);
            const windowGap = getScaledGap('window-gap', monitor);
            const r = this.copy();

            // Prefer individual gaps
            if (useIndividualGaps(monitor)) {
                [
                    ['x', 'width', screenLeftGap, screenRightGap],
                    ['y', 'height', screenTopGap, screenBottomGap]
                ].forEach(([pos, dim, posGap, dimGap]) => {
                    if (this[pos] === workArea[pos]) {
                        r[pos] = this[pos] + posGap;
                        r[dim] -= posGap;
                    } else {
                        r[pos] = this[pos] + windowGap / 2;
                        r[dim] -= windowGap / 2;
                    }

                    if (this[pos] + this[dim] === workArea[pos] + workArea[dim])
                        r[dim] -= dimGap;
                    else
                        r[dim] -= windowGap / 2;
                });
                // Use the single screen gap
            } else {
                [['x', 'width'], ['y', 'height']].forEach(([pos, dim]) => {
                    if (this[pos] === workArea[pos]) {
                        r[pos] = this[pos] + singleScreenGap;
                        r[dim] -= singleScreenGap;
                    } else {
                        r[pos] = this[pos] + windowGap / 2;
                        r[dim] -= windowGap / 2;
                    }

                    if (this[pos] + this[dim] === workArea[pos] + workArea[dim])
                        r[dim] -= singleScreenGap;
                    else
                        r[dim] -= windowGap / 2;
                });
            }

            return r;
        };
    });

    Injections.overrideMethod(Mtk.Rectangle.prototype, 'contains_point', () => {
        return function (point) {
            return point.x >= this.x && point.x <= this.x2 &&
                point.y >= this.y && point.y <= this.y2;
        };
    });

    Injections.overrideMethod(Mtk.Rectangle.prototype, 'get_neighbor', () => {
        /**
         * Gets the neighbor in the direction `dir` within the list of Rects
         * `rects`.
         *
         * @param {Direction} dir the direction that is looked into.
         * @param {Mtk.Rectangle[]} rects an array of the available Rects. It may contain
         *      `this` itself. The rects shouldn't overlap each other.
         * @param {boolean} [wrap=true] whether wrap is enabled,
         *      if there is no Rect in the direction of `dir`.
         * @returns {Mtk.Rectangle|null} the nearest Rect.
         */
        return function (dir, rects, wrap = true) {
            // Since we can only move into 1 direction at a time, we just need
            // to check 1 axis / property of the rects per movement (...almost).
            // An example probably makes this clearer. If we want to get the
            // neighbor in the N direction, we just look at the y's of the rects.
            // More specifically, we look for the y2's ('cmprProp') of the other
            // rects which are bigger than the y1 ('startProp') of `this`. The
            // nearest neighbor has y2 == this.y1. i. e. the neighbor and `this`
            // share a border. There may be multiple windows with the same distance.
            // In our example it might happen, if 2 windows are tiled side by side
            // bordering `this`. In that case we choose the window, which is the
            // nearest on the non-compared axis ('nonCmprProp'). The x property
            // in the this example.
            let startProp, cmprProp, nonCmprProp;
            if (dir === Direction.N)
                [startProp, cmprProp, nonCmprProp] = ['y', 'y2', 'x'];
            else if (dir === Direction.S)
                [startProp, cmprProp, nonCmprProp] = ['y2', 'y', 'x'];
            else if (dir === Direction.W)
                [startProp, cmprProp, nonCmprProp] = ['x', 'x2', 'y'];
            else if (dir === Direction.E)
                [startProp, cmprProp, nonCmprProp] = ['x2', 'x', 'y'];

            // Put rects into a Map with their relevenat pos'es as the keys and
            // filter out `this`.
            const posMap = rects.reduce((map, rect) => {
                if (rect.equal(this))
                    return map;

                const pos = rect[cmprProp];
                if (!map.has(pos))
                    map.set(pos, []);

                map.get(pos).push(rect);
                return map;
            }, new Map());

            // Sort the pos'es in an ascending / descending order.
            const goForward = [Direction.S, Direction.E].includes(dir);
            const sortedPoses = [...posMap.keys()].sort((a, b) =>
                goForward ? a - b : b - a);

            const neighborPos = goForward
                ? sortedPoses.find(pos => pos >= this[startProp])
                : sortedPoses.find(pos => pos <= this[startProp]);

            if (!neighborPos && !wrap)
                return null;

            // Since the sortedPoses array is in descending order when 'going
            // backwards', we always wrap by getting the 0-th item, if there
            // is no actual neighbor.
            const neighbors = posMap.get(neighborPos ?? sortedPoses[0]);
            return neighbors.reduce((currNearest, rect) => {
                return Math.abs(currNearest[nonCmprProp] - this[nonCmprProp]) <=
                        Math.abs(rect[nonCmprProp] - this[nonCmprProp])
                    ? currNearest
                    : rect;
            });
        };
    });

    Injections.overrideMethod(Mtk.Rectangle.prototype, 'get_unit_at', () => {
        /**
         * Gets the rectangle at `index`, if `this` is split into equally
         * sized rects. This function is meant to prevent rounding errors.
         * Rounding errors may lead to rects not aligning properly and thus
         * messing up other calculations etc... This solution may lead to the
         * last rect's size being off by a few pixels compared to the other
         * rects, if we split `this` multiple times.
         *
         * @param {number} index the position of the rectangle we want after
         *      splitting this rectangle.
         * @param {number} unitSize the size of 1 partial unit of the rectangle.
         * @param {Orientation} orientation determines the split orientation
         *      (horizontally or vertically).
         * @returns {Mtk.Rectangle} the rectangle at `index` after the split.
         */
        return function (index, unitSize, orientation) {
            unitSize = Math.floor(unitSize);

            const isVertical = orientation === Orientation.V;
            const lastIndex = Math.round(this[isVertical ? 'width' : 'height'] / unitSize) - 1;

            const getLastRect = () => {
                const margin = unitSize * index;
                return new Mtk.Rectangle({
                    x: isVertical ? this.x + margin : this.x,
                    y: isVertical ? this.y : this.y + margin,
                    width: isVertical ? this.width - margin : this.width,
                    height: isVertical ? this.height : this.height - margin
                });
            };
            const getNonLastRect = (remainingRect, idx) => {
                const firstUnitRect = new Mtk.Rectangle({
                    x: remainingRect.x,
                    y: remainingRect.y,
                    width: isVertical ? unitSize : remainingRect.width,
                    height: isVertical ? remainingRect.height : unitSize
                });

                if (idx <= 0) {
                    return firstUnitRect;
                } else {
                    const remaining = remainingRect.minus(firstUnitRect)[0];
                    return getNonLastRect(remaining, idx - 1);
                }
            };

            if (index === lastIndex)
                return getLastRect();
            else
                return getNonLastRect(this, index);
        };
    });

    Injections.overrideMethod(Mtk.Rectangle.prototype, 'try_align_with', () => {
        /**
         * Makes `this` stick to `rect`, if they are close to each other. Use it
         * as a last resort to prevent rounding errors, if you can't use minus()
         * or get_unit_at().
         *
         * @param {Mtk.Rectangle} rect the rectangle to align `this` with.
         * @param {number} margin only align, if `this` and the `rect` are at most
         *      this far away.
         * @returns {Mtk.Rectangle} a reference to this.
         */
        return function (rect, margin = 4) {
            const equalApprox = (value1, value2) => Math.abs(value1 - value2) <= margin;

            if (equalApprox(rect.x, this.x))
                this.x = rect.x;
            else if (equalApprox(rect.x2, this.x))
                this.x = rect.x2;

            if (equalApprox(rect.y, this.y))
                this.y = rect.y;
            else if (equalApprox(rect.y2, this.y))
                this.y = rect.y2;

            if (equalApprox(rect.x, this.x2))
                this.width = rect.x - this.x;
            else if (equalApprox(rect.x2, this.x2))
                this.width = rect.x2 - this.x;

            if (equalApprox(rect.y, this.y2))
                this.height = rect.y - this.y;
            else if (equalApprox(rect.y2, this.y2))
                this.height = rect.y2 - this.y;

            return this;
        };
    });

    Injections.overrideMethod(Mtk.Rectangle.prototype, 'minus', () => {
        return function (r) {
            return Array.isArray(r) ? this._minusRectArray(r) : this._minusRect(r);
        };
    });

    Injections.overrideMethod(Mtk.Rectangle.prototype, '_minusRect', () => {
        /**
         * Gets the Rects, which remain from `this` after `rect` was cut off
         * / subtracted from it.
         *
         * Original idea from: \
         * https://en.wikibooks.org/wiki/Algorithm_Implementation/Geometry/Rectangle_difference \
         * No license is given except the general CC-BY-AS (for text) mentioned
         * in the footer. Since the algorithm seems fairly generic (just a few
         * additions / substractions), I think I should be good regardless...
         * I've modified the algorithm to make the left / right result rects bigger
         * instead of the top / bottom rects since screens usually have horizontal
         * orientations; so having the vertical rects take priority makes more sense.
         *
         * @param {Mtk.Rectangle} rect the Rect to cut off from `this`.
         * @returns {Mtk.Rectangle[]} an array of Rects. It contains 0 - 4 rects.
         */
        return function (rect) {
            if (rect.contains_rect(this))
                return [];

            const [intersect] = this.intersect(rect);
            if (!intersect)
                return [this.copy()];

            const resultRects = [];

            // Left rect
            const leftRectWidth = rect.x - this.x;
            if (leftRectWidth > 0 && this.height > 0) {
                resultRects.push(new Mtk.Rectangle({
                    x: this.x,
                    y: this.y,
                    width: leftRectWidth,
                    height: this.height
                }));
            }

            // Right rect
            const rightRectWidth = this.x2 - rect.x2;
            if (rightRectWidth > 0 && this.height > 0) {
                resultRects.push(new Mtk.Rectangle({
                    x: rect.x2,
                    y: this.y,
                    width: rightRectWidth,
                    height: this.height
                }));
            }

            const vertRectsX1 = rect.x > this.x ? rect.x : this.x;
            const vertRectsX2 = rect.x2 < this.x2 ? rect.x2 : this.x2;
            const vertRectsWidth = vertRectsX2 - vertRectsX1;

            // Top rect
            const topRectHeight = rect.y - this.y;
            if (topRectHeight > 0 && vertRectsWidth > 0) {
                resultRects.push(new Mtk.Rectangle({
                    x: vertRectsX1,
                    y: this.y,
                    width: vertRectsWidth,
                    height: topRectHeight
                }));
            }

            // Bottom rect
            const bottomRectHeight = this.y2 - rect.y2;
            if (bottomRectHeight > 0 && vertRectsWidth > 0) {
                resultRects.push(new Mtk.Rectangle({
                    x: vertRectsX1,
                    y: rect.y2,
                    width: vertRectsWidth,
                    height: bottomRectHeight
                }));
            }

            return resultRects;
        };
    });

    Injections.overrideMethod(Mtk.Rectangle.prototype, '_minusRectArray', () => {
        /**
         * Gets the Rects that remain from `this`, if a list of rects is cut
         * off from it.
         *
         * @param {Mtk.Rectangle[]} rects the list of Rects to cut off from `this`.
         * @returns {Mtk.Rectangle[]} an array of the remaining Rects.
         */
        return function (rects) {
            if (!rects.length)
                return [this.copy()];

            // First cut off all rects individually from `this`. The result is an
            // array of leftover rects (which are arrays themselves) from `this`.
            const individualLeftOvers = rects.map(r => this.minus(r));

            // Get the final result by intersecting all leftover rects.
            return individualLeftOvers.reduce((result, currLeftOvers) => {
                const intersections = [];

                for (const leftOver of currLeftOvers) {
                    for (const currFreeRect of result) {
                        const [ok, inters] = currFreeRect.intersect(leftOver);
                        ok && intersections.push(inters);
                    }
                }

                return intersections;
            });
        };
    });
}

function overrideTopPanelDrag() {
    Injections.overrideMethod(Main.panel, '_getDraggableWindowForPosition', () => {
        return function (stageX) {
            const workspaceManager = global.workspace_manager;
            const windows = workspaceManager.get_active_workspace()
                .list_windows();
            const allWindowsByStacking = global.display
                .sort_windows_by_stacking(windows)
                .reverse();

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
    });
}

function overrideNativeSettings() {
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
}
