import { Clutter, Gio, GLib, Mtk, St } from '../dependencies/gi.js';
import { Main } from '../dependencies/shell.js';

import { Direction } from '../common.js';
import { Settings } from './settings.js';

/**
 * Library of commonly used functions for the extension.js' files
 * (and *not* the prefs files)
 */

export class Util {
    /**
     * Performs an approximate equality check. There will be times when
     * there will be inaccuracies. For example, the user may enable window
     * gaps and resize 2 tiled windows and try to line them up manually.
     * But since the gaps are implemented with this extension, there will
     * be no window snapping. So the windows won't be aligned pixel
     * perfectly... in that case we first check approximately and correct
     * the inaccuracies afterwards.
     *
     * @param {number} value
     * @param {number} value2
     * @param {number} [margin=4]
     * @returns {boolean} whether the values are approximately equal.
     */
    static equal(value, value2, margin = 4) {
        return Math.abs(value - value2) <= margin;
    }

    /**
     * @param {{x, y}} pointA
     * @param {{x, y}} pointB
     * @returns {number} the distance between `pointA` and `pointB`,
     */
    static getDistance(pointA, pointB) {
        const diffX = pointA.x - pointB.x;
        const diffY = pointA.y - pointB.y;
        return Math.sqrt(diffX * diffX + diffY * diffY);
    }

    /**
     * @param {number} keyVal
     * @param {Direction} direction
     * @returns {boolean} whether the `keyVal` is considered to be in the
     *      direction of `direction`.
     */
    static isDirection(keyVal, direction) {
        switch (direction) {
            case Direction.N:
                return keyVal === Clutter.KEY_Up ||
                        keyVal === Clutter.KEY_w || keyVal === Clutter.KEY_W ||
                        keyVal === Clutter.KEY_k || keyVal === Clutter.KEY_K;

            case Direction.S:
                return keyVal === Clutter.KEY_Down ||
                        keyVal === Clutter.KEY_s || keyVal === Clutter.KEY_S ||
                        keyVal === Clutter.KEY_j || keyVal === Clutter.KEY_J;

            case Direction.W:
                return keyVal === Clutter.KEY_Left ||
                        keyVal === Clutter.KEY_a || keyVal === Clutter.KEY_A ||
                        keyVal === Clutter.KEY_h || keyVal === Clutter.KEY_H;

            case Direction.E:
                return keyVal === Clutter.KEY_Right ||
                        keyVal === Clutter.KEY_d || keyVal === Clutter.KEY_D ||
                        keyVal === Clutter.KEY_l || keyVal === Clutter.KEY_L;
        }

        return false;
    }

    /**
     * @param {number} keyVal
     * @returns {Direction}
     */
    static getDirection(keyVal) {
        if (this.isDirection(keyVal, Direction.N))
            return Direction.N;
        else if (this.isDirection(keyVal, Direction.S))
            return Direction.S;
        else if (this.isDirection(keyVal, Direction.W))
            return Direction.W;
        else if (this.isDirection(keyVal, Direction.E))
            return Direction.E;
        else
            return null;
    }

    /**
     * Get the window or screen gaps scaled to the monitor scale.
     *
     * @param {String} settingsKey the key for the gap
     * @param {number} monitor the number of the monitor to scale the gap to
     * @returns {number} the scaled gap as a even number since the window gap
     *      will be divided by 2.
     */
    static getScaledGap(settingsKey, monitor) {
        const gap = Settings.getGioObject().get_int(settingsKey);
        const scaledGap = gap * global.display.get_monitor_scale(monitor);
        return scaledGap % 2 === 0 ? scaledGap : scaledGap + 1;
    }

    static useIndividualGaps(monitor) {
        // Prefer individual gaps over the single one
        const screenTopGap = this.getScaledGap('screen-top-gap', monitor);
        const screenLeftGap = this.getScaledGap('screen-left-gap', monitor);
        const screenRightGap = this.getScaledGap('screen-right-gap', monitor);
        const screenBottomGap = this.getScaledGap('screen-bottom-gap', monitor);
        return screenTopGap || screenLeftGap || screenRightGap || screenBottomGap;
    }

    /**
     * @param {number} modMask a Clutter.ModifierType.
     * @returns whether the current event the modifier at `modMask`.
     */
    static isModPressed(modMask) {
        return global.get_pointer()[2] & modMask;
    }

    /**
     * @returns {Layout[]} the layouts
     */
    static getLayouts() {
        const userDir = GLib.get_user_config_dir();
        const pathArr = [userDir, '/tiling-assistant/layouts.json'];
        const path = GLib.build_filenamev(pathArr);
        const file = Gio.File.new_for_path(path);
        if (!file.query_exists(null))
            return [];

        const [success, contents] = file.load_contents(null);
        if (!success || !contents.length)
            return [];

        return JSON.parse(new TextDecoder().decode(contents));
    }

    /**
     * @param {number|null} monitorNr determines which monitor the layout scales
     *      to. Sometimes we want the monitor of the pointer (when using dnd) and
     *      sometimes not (when using layouts with the keyboard shortcuts).
     * @returns {Mtk.Rectangle[]}
     */
    static getFavoriteLayout(monitorNr = null) {
        // I don't know when the layout may have changed on the disk(?),
        // so always get it anew.
        const monitor = monitorNr ?? global.display.get_current_monitor();
        const favoriteLayout = [];
        const layouts = this.getLayouts();
        const layout = layouts?.[Settings.getFavoriteLayouts()[monitor]];

        if (!layout)
            return [];

        const activeWs = global.workspace_manager.get_active_workspace();
        const workArea = activeWs.get_work_area_for_monitor(monitor);

        // Scale the rect's ratios to the workArea. Try to align the rects to
        // each other and the workArea to workaround possible rounding errors
        // due to the scaling.
        layout._items.forEach(({ rect: rectRatios }, idx) => {
            const rect = new Mtk.Rectangle({
                x: workArea.x + Math.floor(rectRatios.x * workArea.width),
                y: workArea.y + Math.floor(rectRatios.y * workArea.height),
                width: Math.ceil(rectRatios.width * workArea.width),
                height: Math.ceil(rectRatios.height * workArea.height)
            });
            favoriteLayout.push(rect);

            for (let i = 0; i < idx; i++)
                rect.try_align_with(favoriteLayout[i]);
        });

        favoriteLayout.forEach(rect => rect.try_align_with(workArea));
        return favoriteLayout;
    }

    /**
     * Shows the tiled rects of the top tile group.
     *
     * @returns {St.Widget[]} an array of St.Widgets to indicate the tiled rects.
     */
    static async ___debugShowTiledRects() {
        const twm = (await import('./tilingWindowManager.js')).TilingWindowManager;
        const topTileGroup = twm.getTopTileGroup();
        if (!topTileGroup.length) {
            Main.notify('Tiling Assistant', 'No tiled windows / tiled rects.');
            return null;
        }

        const indicators = [];
        topTileGroup.forEach(w => {
            const indicator = new St.Widget({
                style_class: 'tile-preview',
                opacity: 160,
                x: w.tiledRect.x,
                y: w.tiledRect.y,
                width: w.tiledRect.width,
                height: w.tiledRect.height
            });
            Main.uiGroup.add_child(indicator);
            indicators.push(indicator);
        });

        return indicators;
    }

    /**
     * Shows the free screen rects based on the top tile group.
     *
     * @returns {St.Widget[]} an array of St.Widgets to indicate the free
     *      screen rects.
     */
    static async ___debugShowFreeScreenRects() {
        const activeWs = global.workspace_manager.get_active_workspace();
        const monitor = global.display.get_current_monitor();
        const workArea = activeWs.get_work_area_for_monitor(monitor);
        const twm = (await import('./tilingWindowManager.js')).TilingWindowManager;
        const topTileGroup = twm.getTopTileGroup();
        const tRects = topTileGroup.map(w => w.tiledRect);
        const freeScreenSpace = twm.getFreeScreen(tRects);
        const rects = freeScreenSpace ? [freeScreenSpace] : workArea.minus(tRects);
        if (!rects.length) {
            Main.notify('Tiling Assistant', 'No free screen rects to show.');
            return null;
        }

        const indicators = [];
        rects.forEach(rect => {
            const indicator = new St.Widget({
                style_class: 'tile-preview',
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height
            });
            Main.uiGroup.add_child(indicator);
            indicators.push(indicator);
        });

        return indicators.length ? indicators : null;
    }

    /**
     * Print the tile groups to the logs.
     */
    static async __debugPrintTileGroups() {
        log('--- Tiling Assistant: Start ---');
        const twm = await import('./tilingWindowManager.js');
        const openWindows = twm.getWindows();
        openWindows.forEach(w => {
            if (!w.isTiled)
                return;

            log(`Tile group for: ${w.get_wm_class()}`);
            const tileGroup = twm.getTileGroupFor(w);
            tileGroup.forEach(tw => log(tw.get_wm_class()));
            log('---');
        });
        log('--- Tiling Assistant: End ---');
    }
}
