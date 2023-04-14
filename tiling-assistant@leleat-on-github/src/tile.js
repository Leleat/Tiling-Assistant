/**
 * @file Contains the core classes for the tiling behavior: TileGroupManager,
 * TileGroup, and Tile. A TileGroupManager may contain multiple TileGroups. A
 * TileGroup may contain multiple Tiles. Other files/objects should ideally only
 * use the high level API exposed via the TileGroupManager.
 */

'use strict';

const { Clutter, GObject, Meta } = imports.gi;
const { main: Main } = imports.ui;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const { WindowManager } = Me.imports.src.window;
const { Orientation, TileMode, Rect } = Me.imports.src.util;

/**
 * A class managing tile groups on 1 monitor. This exposes high level tiling
 * APIs that other code ideally should call into instead of interacting with
 * tile groups or tiles directly. This should guarantee feature parity between
 * pointer based and keyboard based workflows while also providing consistency
 * since all code paths need to pass through this class.
 */
var TileGroupManager = GObject.registerClass({
}, class TileGroupManager extends Clutter.Actor {
    #tileGroups = [];
    #monitor = 0;

    constructor({ monitor }) {
        super();

        this.#monitor = monitor;

        this.#createTileGroup();
    }

    destroy() {
        this.#tileGroups.forEach(tg => tg.destroy());
        this.#tileGroups = [];

        super.destroy();
    }

    /**
     * Gets a generator to tile a window. The first `next()` call will yield the
     * tile that the `window` will tile into. The next (and final) call will tile
     * the `window`. This 2-step process can be used when users want to tile a
     * window with the pointer. First the yielded tile will be used to create
     * the tile preview and on the grab release the window will be tiled. If the
     * generator shouldn't finish the tiling process, it should `throw()`. Then
     * tiles and tile groups, that may have been created, will be cleaned up. If
     * the tiling process should happen in 1 step, use the convenience function
     * {@link tileWindow()}. It just calls this function in the background.
     * @param {Window} window
     * @param {TileMode} tileMode
     * @returns {Generator<Tile|undefined, undefined, undefined>}
     */
    *generateTiledWindow(window, tileMode) {
        log('func: generateTiledWindow');

        let tmpTileGroup = null;
        let tile = null;

        try {
            // Don't ignore the focused window if we want to untile it. In that
            // case we need to get the tile group it's actually part of.
            const ignoreFocusedWindow = window.tile?.tileMode !== tileMode;
            const visibleTileGroup = this.#getVisibleTileGroup({
                ignoreFocusedWindow
            });

            // Remove `window` from its tile without actually moving it so it
            // doesn't interfere with other tiling operations like findBestTile.
            // This is only relevant to the keyboard-shortcut-based workflow
            // since only then windows may still be tiled here. During pointer-
            // grabs windows are already untiled at this point in time.
            const maybePrevTile = window.tile;
            const windowRemover = maybePrevTile?.generateWindowRemover();
            windowRemover?.next();

            if (visibleTileGroup) {
                tile = visibleTileGroup.findBestTile(tileMode);

                if (tile)
                    visibleTileGroup.addTile(tile);
                else
                    [tmpTileGroup, tile] = this.#createTileGroupAndDefaultTile(tileMode);
            } else {
                [tmpTileGroup, tile] = this.#createTileGroupAndDefaultTile(tileMode);
            }

            yield tile;

            if (tile === maybePrevTile)
                windowRemover.next();
            else
                tile.addWindow(window);
        } catch (error) {
            if (tmpTileGroup)
                this.#removeTileGroup(tmpTileGroup);
        }
    }

    /**
     * Tiles a window. See {@link generateTiledWindow} for details.
     * @param {Window} window
     * @param {TileMode} tileMode
     */
    tileWindow(window, tileMode) {
        log('func: tileWindow');

        [...this.generateTiledWindow(window, tileMode)];
    }

    /** @param {Window} window */
    untileWindow(window) {
        log('func: untileWindow');

        const windowRemover = window.tile?.generateWindowRemover();
        if (windowRemover)
            [...windowRemover];
    }

    /** @returns {TileGroup} */
    #createTileGroup() {
        log('func: #createTileGroup');

        const tileGroup = new TileGroup({ tileGroupManager: this });
        this.#tileGroups.push(tileGroup);
        return tileGroup;
    }

    /**
     * Creates a new empty tile group and adds a new tile for `tileMode` to it.
     * That means the tile will be a default tile i. e. it will cover a screen
     * half or quarter, or the full screen.
     * @param {TileMode} tileMode
     * @returns {[TileGroup, Tile]}
     */
    #createTileGroupAndDefaultTile(tileMode) {
        log('func: #createTileGroupAndDefaultTile');

        const tileGroup = this.#createTileGroup();
        const tile = tileGroup.findBestTile(tileMode);
        tileGroup.addTile(tile);

        return [tileGroup, tile];
    }

    /**
     * Removes `tileGroup` from `this` and destroys it.
     * @param {TileGroup} tileGroup
     */
    #removeTileGroup(tileGroup) {
        const idx = this.#tileGroups.indexOf(tileGroup);
        if (idx === -1)
            return;

        this.#tileGroups.splice(idx, 1);
        tileGroup.destroy();
    }

    /**
     * Gets the top most visible tile group that contains windows and isn't
     * overlapped by floating windows. The windows of the top tile group don't
     * necessarily need to be at the top of the window stack. For instance,
     * always-on-top windows will be disregarded when searching for the top tile
     * group. The focused window may also be disregarded. For instance, this is
     * needed when a window is dnd-ed or when tiling a floating window via
     * shortcuts and other situations. Other floating windows will also be
     * disregarded if they don't overlap a tile group. To illustrate the desired
     * behavior: let's say there are Windows 1, 2, and 3 (1 on top and 3 at the
     * bottom of the stacking order). Window 2 is a floating window on the left
     * side of the screen. Window 3 is tiled to the right with 2/3 screen width.
     * Windows 2 and 3 don't overlap each other. If the user drags Window 1 to
     * the left screen edge, the tile preview should open for 1/3 of the screen
     * width. Reason is that the user may not know the exact stacking order of
     * windows. Instead the tile should adapt to the visible layout/tile group.
     * @param {Object} params
     * @param {boolean=true} params.ignoreFocusedWindow - Determines, if the
     *      focused window should be disregarded when searching for the top
     *      visible tile group. It's needed most of the time, so defaults to true.
     * @returns {TileGroup|null}
     */
    #getVisibleTileGroup({ ignoreFocusedWindow = true } = {}) {
        const getWindowsMaybeExcludingFocus = () => {
            const windows = WindowManager.get().getWindows();
            if (!windows.length)
                return [];

            const focus = WindowManager.get().getFocusedWindow();

            if (ignoreFocusedWindow) {
                const idx = windows.indexOf(focus);
                idx !== -1 && windows.splice(idx, 1);
            }

            return windows;
        };

        const windows = getWindowsMaybeExcludingFocus();
        const ignoredWindows = [];

        for (const window of windows) {
            // If always-on-top windows aren't tiled, assume that they are
            // utility windows and completely disregard them for the search.
            if (window.isAbove() && !window.tile)
                continue;

            if (window.tile) {
                const overlappedByIgnoredWindow = ignoredWindows.some(w => {
                    const rect = w.tile?.rect ?? w.rect;
                    return rect.overlap(window.tile.rect);
                });

                if (overlappedByIgnoredWindow)
                    ignoredWindows.push(window);
                else
                    return window.tile.tileGroup;
            } else {
                ignoredWindows.push(window);
            }
        }

        return null;
    }

    /** @returns {number} */
    get monitor() {
        return this.#monitor;
    }
});

/**
 * A class containing a set of tiles. All tiles within a tile group don't overlap
 * each other and span the entire work area of the monitor. A tile group raises
 * and resizes all its tiles in unison. A tile group should only be instanced
 * in a tile group manager since it will be aware of the needed context.
 */
const TileGroup = GObject.registerClass({
}, class TileGroup extends Clutter.Actor {
    #tileGroupManager = null;
    #tiles = [];

    constructor({ tileGroupManager }) {
        super();

        this.#tileGroupManager = tileGroupManager;

        const wm = WindowManager.get();
        const workArea = wm.getWorkArea(tileGroupManager.monitor);

        this.#trackTile(new Tile({
            rect: workArea,
            tileGroup: this
        }));
    }

    destroy() {
        this.#tiles.forEach(t => t.destroy());
        this.#tiles = [];
        this.#tileGroupManager = null;

        super.destroy();
    }

    /**
     * Adds `tile` to `this`. Tiles that are overlapped by `tile` will make
     * space for it by resizing on 1 axis (either horizontally or vertically).
     * If needed, new tiles will be created to fill up the empty space that
     * came from the resizing. Only tiles that were created through the APIs
     * of TileGroup and TileGroupManager should be added. Otherwise this may
     * lead to undefined behavior.
     * @param {Tile} tile
     * @returns {boolean} ok
     */
    addTile(tile) {
        log('func: addTile');

        if (this.#tiles.includes(tile))
            return true;

        if (tile.tileGroup !== this)
            throw new Error('==== ERROR addTile1 ====');

        if (!this.#canAdd(tile))
            throw new Error('==== ERROR addTile2 ====');

        const tilesToRemove = [];
        const yieldSpaceTo = (yielder, pusher) => {
            if (!pusher.rect.overlap(yielder.rect))
                return;

            if (pusher.rect.containsRect(yielder.rect)) {
                tilesToRemove.push(yielder);
                return;
            }

            const preYieldRect = yielder.rect.copy();
            const resizeYielderInOneDirection = () => {
                const diffs = yielder.rect.minus(pusher.rect);
                const rectWithNoHorizOverlap = diffs.find(d => !d.horizOverlap(pusher.rect));
                const rectWithNoVertOverlap = diffs.find(d => !d.vertOverlap(pusher.rect));
                const rect = yielder.rect.copy();

                if (rectWithNoHorizOverlap) {
                    rect.x = rectWithNoHorizOverlap.x;
                    rect.width = rectWithNoHorizOverlap.width;
                } else if (rectWithNoVertOverlap) {
                    rect.y = rectWithNoVertOverlap.y;
                    rect.height = rectWithNoVertOverlap.height;
                }

                const resizedByRect = yielder.rect.minus(rect)[0];
                yielder.resize(rect);
                return resizedByRect;
            };

            const resizedByRect = resizeYielderInOneDirection();
            const noEmptySpaceWasCreated = pusher.rect.containsRect(resizedByRect);
            if (noEmptySpaceWasCreated)
                return;

            const remainder = preYieldRect.minus(yielder.rect)[0];
            const fillerRect = remainder.minus(pusher.rect)[0];
            const fillerTile = new Tile({ rect: fillerRect, tileGroup: this });
            this.#trackTile(fillerTile);
        };

        for (const otherTile of this.#tiles)
            yieldSpaceTo(otherTile, tile);

        this.#trackTile(tile);
        tilesToRemove.forEach(t => this.#removeTile(t));

        const area = this.#tiles.reduce((sum, t) => sum + t.rect.area(), 0);
        if (area !== WindowManager.get().getWorkArea(0).area())
            log('........ERROR ERROR ERROR wrongly added tile.....');

        return true;
    }

    /**
     * Finds the best tile for a given tile mode in `this`. The tile may or may
     * not be part of this tile group yet since `this` may have an arbitrary
     * layout, which could potentially cause weird tiling. The returned tile is
     * however guaranteed to be at least addable to `this`. For instance, let's
     * say the top tile group consists of 4 rectangles like this:
     *
     *  -----------------   Tiles 1 and 2 are quarter tiled windows, which were
     *  |  1  |    3    |   resized resulting in the empty tiles 3 and 4. Now,
     *  -----------------   if we want the tile for the right-side tiling, we
     *  |  2  |    4    |   want to return a tile that spans the rects 3 and 4
     *  -----------------   instead of returning null. If however tiles 3 or 4
     *                      contained a window, this should return null.
     * @param {TileMode} tileMode
     * @returns {Tile|null}
     */
    findBestTile(tileMode) {
        const monitor = this.#tileGroupManager.monitor;
        const workArea = WindowManager.get().getWorkArea(monitor);
        const tileRects = this.#tiles.map(t => t.rect);
        const maybeGetTileForBestRect = bestRect => {
            const existingTile = this.#tiles.find(t => t.rect.equal(bestRect));
            if (existingTile)
                return existingTile;

            const newTile = new Tile({ rect: bestRect, tileGroup: this });
            if (this.#canAdd(newTile))
                return newTile;

            newTile.destroy();
            return null;
        };

        switch (tileMode) {
            case TileMode.MAXIMIZE: {
                return maybeGetTileForBestRect(workArea);
            } case TileMode.LEFT: {
                const left = tileRects.find(r =>
                    r.x === workArea.x &&
                    r.width !== workArea.width);
                const { width } = left ?? workArea.getUnitAt(
                    0, workArea.width / 2, Orientation.V);

                return maybeGetTileForBestRect(new Rect({
                    x: workArea.x,
                    y: workArea.y,
                    width,
                    height: workArea.height
                }));
            } case TileMode.RIGHT: {
                const right = tileRects.find(r =>
                    r.x2 === workArea.x2 &&
                    r.width !== workArea.width);
                const { width } = right ?? workArea.getUnitAt(
                    1, workArea.width / 2, Orientation.V);

                return maybeGetTileForBestRect(new Rect({
                    x: workArea.x2 - width,
                    y: workArea.y,
                    width,
                    height: workArea.height
                }));
            } case TileMode.TOP: {
                const top = tileRects.find(
                    r => r.y === workArea.y &&
                    r.height !== workArea.height);
                const { height } = top ?? workArea.getUnitAt(
                    0, workArea.height / 2, Orientation.H);

                return maybeGetTileForBestRect(new Rect({
                    x: workArea.x,
                    y: workArea.y,
                    width: workArea.width,
                    height
                }));
            } case TileMode.BOTTOM: {
                const bottom = tileRects.find(r =>
                    r.y2 === workArea.y2 &&
                    r.height !== workArea.height);
                const { height } = bottom ?? workArea.getUnitAt(
                    1, workArea.height / 2, Orientation.H);

                return maybeGetTileForBestRect(new Rect({
                    x: workArea.x,
                    y: workArea.y2 - height,
                    width: workArea.width,
                    height
                }));
            } case TileMode.TOP | TileMode.LEFT: {
                const left = tileRects.find(r =>
                    r.x === workArea.x &&
                    r.width !== workArea.width);
                const { width } = left ?? workArea.getUnitAt(
                    0, workArea.width / 2, Orientation.V);
                const top = tileRects.find(r =>
                    r.y === workArea.y &&
                    r.height !== workArea.height);
                const { height } = top ?? workArea.getUnitAt(
                    0, workArea.height / 2, Orientation.H);

                return maybeGetTileForBestRect(new Rect({
                    x: workArea.x,
                    y: workArea.y,
                    width,
                    height
                }));
            } case TileMode.TOP | TileMode.RIGHT: {
                const right = tileRects.find(r =>
                    r.x2 === workArea.x2 &&
                    r.width !== workArea.width);
                const { width } = right ?? workArea.getUnitAt(
                    1, workArea.width / 2, Orientation.V);
                const top = tileRects.find(r =>
                    r.y === workArea.y &&
                    r.height !== workArea.height);
                const { height } = top ?? workArea.getUnitAt(
                    0, workArea.height / 2, Orientation.H);

                return maybeGetTileForBestRect(new Rect({
                    x: workArea.x2 - width,
                    y: workArea.y,
                    width,
                    height
                }));
            } case TileMode.BOTTOM | TileMode.LEFT: {
                const left = tileRects.find(r =>
                    r.x === workArea.x &&
                    r.width !== workArea.width);
                const { width } = left ?? workArea.getUnitAt(
                    0, workArea.width / 2, Orientation.V);
                const bottom = tileRects.find(r =>
                    r.y2 === workArea.y2 &&
                    r.height !== workArea.height);
                const { height } = bottom ?? workArea.getUnitAt(
                    1, workArea.height / 2, Orientation.H);

                return maybeGetTileForBestRect(new Rect({
                    x: workArea.x,
                    y: workArea.y2 - height,
                    width,
                    height
                }));
            } case TileMode.BOTTOM | TileMode.RIGHT: {
                const right = tileRects.find(r =>
                    r.x2 === workArea.x2 &&
                    r.width !== workArea.width);
                const { width } = right ?? workArea.getUnitAt(
                    1, workArea.width / 2, Orientation.V);
                const bottom = tileRects.find(r =>
                    r.y2 === workArea.y2 &&
                    r.height !== workArea.height);
                const { height } = bottom ?? workArea.getUnitAt(
                    1, workArea.height / 2, Orientation.H);

                return maybeGetTileForBestRect(new Rect({
                    x: workArea.x2 - width,
                    y: workArea.y2 - height,
                    width,
                    height
                }));
            }
        }
    }

    /**
     * Removes `tile` from `this` and destroys it.
     * @param {Tile} tile
     */
    #removeTile(tile) {
        if (!this.#tiles.includes(tile))
            return;

        this.#untrackTile(tile);
        tile.destroy();
    }

    /**
     * Returns whether `tile` can be added to `this`.
     * @param {Tile} tile
     * @returns {boolean}
     */
    #canAdd(tile) {
        return this.#tiles.every(otherTile =>
            !otherTile.rect.overlap(tile.rect) || !otherTile.window);
    }

    /**
     * Starts tracking `tile` and listening to its signals.
     * @param {Tile} tile
     */
    #trackTile(tile) {
        if (this.#tiles.includes(tile))
            return;

        tile.connectObject(
            'user-raised', t => this.#onTileRaised(t),
            'user-changed-size', (t, preResizeRect) => {
                this.#onTileResized(t, preResizeRect);
            },
            this);

        this.#tiles.push(tile);
    }

    /**
     * Stops tracking `tile` and disconnect its signals from `this`.
     * @param {Tile} tile
     */
    #untrackTile(tile) {
        const idx = this.#tiles.indexOf(tile);
        if (idx === -1)
            return;

        this.#tiles.splice(idx, 1);
        tile.disconnectObject(this);
    }

    /**
     * Is called when a tile's window is raised **by the user**. This raises all
     * other windows of the tile group.
     * @param {Tile} raisedTile
     */
    #onTileRaised(raisedTile) {
        log('func: #onTileRaised');

        this.#tiles.forEach(tile =>
            tile.window?.raiseAndMakeRecent?.() ?? tile.window?.raise());
        raisedTile.window.raiseAndMakeRecent?.() ?? raisedTile.window.raise();
    }

    /**
     * Is called when a tile's window is resized **by the user**. This resizes
     * all other tiles to accommodate the resized tile.
     * @param {Tile} resizedTile
     * @param {Rect} preResizeRect
     */
    #onTileResized(resizedTile, preResizeRect) {
        log('func: #onTileResized', resizedTile.window.getWmClass());

        const postResizeRect = resizedTile.rect;

        this.#tiles.forEach(tile => {
            if (tile === resizedTile)
                return;

            const newRect = tile.rect.copy();

            // TODO Currently, this is problem for complex layouts: Instead we
            // only want to resize windows that actually border each other even
            // just transitively rather than all windows with the same coords.

            // TODO currently undefined behavior if you resize a tile on the
            // edge that borders the screen since that means the tile group
            // layout will have a gap an no longer equal the work area...

            // x
            if (tile.rect.x === preResizeRect.x)
                newRect.x = postResizeRect.x;
            else if (tile.rect.x === preResizeRect.x2)
                newRect.x = postResizeRect.x2;

            // y
            if (tile.rect.y === preResizeRect.y)
                newRect.y = postResizeRect.y;
            else if (tile.rect.y === preResizeRect.y2)
                newRect.y = postResizeRect.y2;

            // width
            if (tile.rect.x2 === preResizeRect.x)
                newRect.x2 = postResizeRect.x;
            else if (tile.rect.x2 === preResizeRect.x2)
                newRect.x2 = postResizeRect.x2;
            else
                newRect.x2 = tile.rect.x2;

            // height
            if (tile.rect.y2 === preResizeRect.y)
                newRect.y2 = postResizeRect.y;
            else if (tile.rect.y2 === preResizeRect.y2)
                newRect.y2 = postResizeRect.y2;
            else
                newRect.y2 = tile.rect.y2;

            tile.resize(newRect, { animate: false });
        });
    }

    /** @returns {TileGroupManager} */
    get tileGroupManager() {
        return this.#tileGroupManager;
    }

    // TODO delete this? only used for debugging
    get tiles() {
        return this.#tiles;
    }
});

/**
 * A tile is the base unit for tiling. It's basically just a rectangle with some
 * additional fluff. It may or may not contain a window. Tiles should only be
 * instanced by a tile group since only a tile group will be aware of the
 * necessary context (i. e. other tiles) to create the appropriately sized tile.
 * That's why a tile will always be associated with 1 tile group. That doesn't
 * mean a created tile is immediately added to the responsible tile group.
 */
const Tile = GObject.registerClass({
    Signals: {
        // Ideally, we'd use a window's focus signal so we don't have to worry
        // about endless 'raise recursions' of tiled windows. But on x11, focus
        // doesn't work very well with 'grabs' like when using the app switcher.
        'user-raised': {},
        'user-changed-size': { 'param_types': [GObject.TYPE_JSOBJECT] }
    }
}, class Tile extends Clutter.Actor {
    static #allowRaiseSignal = true;
    static #allowSizeChangedSignal = true;

    #rect = null;
    #tileGroup = null;
    #window = null;

    constructor({ rect, tileGroup }) {
        super();

        this.#rect = rect.copy();
        this.#tileGroup = tileGroup;
    }

    destroy() {
        this.#rect = null;
        this.#tileGroup = null;
        this.#window = null;

        super.destroy();
    }

    /**
     * Adds `window` to `this` and move the window to this' rect. Colloquially
     * said, 'tile the window'.
     * @param {Window} window
     * @param {Object} params
     * @param {boolean} params.animate - Determines whether the window movement
     *      should be animated.
     */
    addWindow(window, { animate = true } = {}) {
        log('func: addWindow');

        if (this.hasWindow())
            throw new Error('ERROR ERROR ERROR addWindow 1');

        if (window.tile)
            throw new Error('ERROR ERROR ERROR addWindow 2');

        if (!window.tilable)
            return;

        this.#window = window;
        this.#window.tile = this;

        if (!this.#window.floatingRect)
            this.#window.floatingRect = window.rect.copy();

        const maximizedFlags = window.getMaximized();
        maximizedFlags && window.unmaximize(maximizedFlags);
        window.unmakeFullscreen();
        window.unminimize();
        window.unmakeAbove();

        const workArea = WindowManager.get().getWorkArea(window.monitor);
        const maximize = this.#rect.equal(workArea);

        if (maximize) {
            window.maximize(Meta.MaximizeFlags.BOTH);
        } else {
            if (animate)
                this.#prepareWindowAnimation(window);

            const { x, y, width, height } = this.#rect;

            // Some terminals such as GNOME Terminal will only resize but not
            // move. Working HACK: first move and then move/resize the window.
            window.moveFrame(true, x, y);
            window.moveResizeFrame(true, x, y, width, height);
        }

        window.connectObject(
            'raised', () => this.#onWindowRaised(),
            'size-changed', () => this.#onWindowSizeChanged(),
            'unmanaging', () => this.#onWindowUnmanaging(),
            this);
    }

    /**
     * Returns whether a window is tiled in `this`.
     * @returns {boolean}
     */
    hasWindow() {
        return this.#window !== null;
    }

    // TODO clean up empty tile groups after window is removed?

    /**
     * Gets a generator to remove `window` from `this`. Said in other words:
     * untile the window. The first `next()` call will remove the `window` from
     * `this`. However, `window` won't actually be moved/resized to its original
     * dimensions (`window.floatingRect`) yet. The next and final `next()` call
     * will actually restore the original rect and remove the `floatingRect`
     * property. The reason for the 2-step process is that we may want to
     * temporarily remove `window` from its tile so that it may not interfere
     * with other tile operations, if it is the window that is operated on. For
     * an example about this take a look at {@link TileGroupManager.generateTiledWindow}.
     * If the untiling process should be aborted, the generator can `throw()`.
     * Then the connection between `this` and `window` will be restored. If the
     * untiling should happen in 1 step, take a look at the convenience function
     * {@link TileGroupManager.untileWindow}. It just calls this function in the
     * background.
     * @param {Object} params
     * @param {boolean} params.animate
     * @returns {Generator<undefined, undefined, undefined>}
     */
    *generateWindowRemover({ animate } = {}) {
        log('func: generateWindowRemover');

        if (!this.#window)
            throw new Error('ERROR ERROR ERROR generateWindowRemover 1');

        const window = this.#window;

        try {
            this.#window.disconnectObject(this);
            this.#window.tile = null;
            this.#window = null;

            yield;

            const maxFlags = window.getMaximized();
            maxFlags && window.unmaximize(maxFlags);

            animate = animate ?? !maxFlags;

            if (animate)
                this.#prepareWindowAnimation(window);

            const { x, y, width, height } = window.floatingRect;
            window.moveResizeFrame(false, x, y, width, height);
            window.floatingRect = null;
        } catch (error) {
            this.#window = window;
            this.#window.tile = this;
            this.#window.connectObject(
                'raised', () => this.#onWindowRaised(),
                'size-changed', () => this.#onWindowSizeChanged(),
                'unmanaging', () => this.#onWindowUnmanaging(),
                this);
        }
    }

    /**
     * Resizes `this`. This function isn't meant to be actively used to resize
     * a tile. Instead it's called as a result of an event or something else
     * happening because `resize` will not lead to other tiles adapting to
     * the resize operation. For example, if the user resized a tiled window,
     * `onWindowSizeChanged()` is called. In turn the tile will change its size
     * and fire the `user-changed-size` signal. This will lead to other tiles
     * resizing to adapt to the changed tile. The last step uses this `resize`
     * function.
     * @param {Rect} rect
     * @param {Object} params
     * @param {boolean} params.animate
     */
    resize(rect, { animate = true } = {}) {
        if (this.#rect.equal(rect))
            return;

        this.#rect = rect.copy();

        if (!this.#window)
            return;

        if (animate)
            this.#prepareWindowAnimation(this.#window);

        Tile.#allowSizeChangedSignal = false;
        this.#window.moveResizeFrame(true, rect.x, rect.y, rect.width, rect.height);
        Tile.#allowSizeChangedSignal = true;
    }

    /** Prepares to animate the window's movement. It's pretty hacky... */
    #prepareWindowAnimation(window) {
        log('func: #prepareWindowAnimation');

        const actor = window.actor;
        if (!actor)
            return;

        actor.remove_all_transitions();
        Main.wm._prepareAnimationInfo(
            global.window_manager,
            actor,
            window.rect.wrappedObj,
            Meta.SizeChange.MAXIMIZE
        );
    }

    /** Is called when is window is unmanaging. */
    #onWindowUnmanaging() {
        this.#window = null;
    }

    /**
     * Is called when this' window is raised. This fires the tile raised signal,
     * which will end up raising the other windows. To prevent endless recursion
     * of windows raising each other, temporarily block the signal for all tiles.
     */
    #onWindowRaised() {
        if (!Tile.#allowRaiseSignal)
            return;

        Tile.#allowRaiseSignal = false;
        this.emit('user-raised');
        Tile.#allowRaiseSignal = true;
    }

    /**
     * Is called when this' window is resized. This fires the tile resized signal,
     * which will end up resizing the other windows. To prevent endless recursion
     * of windows resizing each other, temporarily block the signal for all tiles.
     */
    #onWindowSizeChanged() {
        if (!Tile.#allowSizeChangedSignal)
            return;

        const prevRect = this.#rect.copy();

        this.#rect.x = this.#window.rect.x;
        this.#rect.y = this.#window.rect.y;
        this.#rect.width = this.#window.rect.width;
        this.#rect.height = this.#window.rect.height;

        Tile.#allowSizeChangedSignal = false;
        this.emit('user-changed-size', prevRect);
        Tile.#allowSizeChangedSignal = true;
    }

    /** @returns {Rect} */
    get rect() {
        return this.#rect;
    }

    /** @returns {TileGroup} */
    get tileGroup() {
        return this.#tileGroup;
    }

    /** @returns {TileMode} */
    get tileMode() {
        const monitor = this.#tileGroup.tileGroupManager.monitor;
        const workArea = WindowManager.get().getWorkArea(monitor);

        if ( // Top left origin
            this.#rect.x === workArea.x &&
            this.#rect.y === workArea.y
        ) {
            if (this.#rect.x2 === workArea.x2 && this.#rect.y2 === workArea.y2)
                return TileMode.MAXIMIZE;
            else if (this.#rect.x2 === workArea.x2 && this.#rect.y2 !== workArea.y2)
                return TileMode.TOP;
            else if (this.#rect.x2 !== workArea.x2 && this.#rect.y2 === workArea.y2)
                return TileMode.LEFT;
            else if (this.#rect.x2 !== workArea.x2 && this.#rect.y2 !== workArea.y2)
                return TileMode.TOP | TileMode.LEFT;
        } else if ( // Top non-left origin
            this.#rect.x !== workArea.x &&
            this.#rect.y === workArea.y
        ) {
            if (this.#rect.x2 === workArea.x2 && this.#rect.y2 === workArea.y2)
                return TileMode.RIGHT;
            else if (this.#rect.x2 === workArea.x2 && this.#rect.y2 !== workArea.y2)
                return TileMode.TOP | TileMode.RIGHT;
        } else if ( // Bottom left origin
            this.#rect.x === workArea.x &&
            this.#rect.y !== workArea.y
        ) {
            if (this.#rect.x2 === workArea.x2 && this.#rect.y2 === workArea.y2)
                return TileMode.BOTTOM;
            else if (this.#rect.x2 !== workArea.x2 && this.#rect.y2 === workArea.y2)
                return TileMode.BOTTOM | TileMode.LEFT;
        } else if ( // Bottom non-left origin
            this.#rect.x !== workArea.x && this.#rect.y !== workArea.y
        ) {
            if (this.#rect.x2 === workArea.x2 && this.#rect.y2 === workArea.y2)
                return TileMode.BOTTOM | TileMode.RIGHT;
        }

        return TileMode.CUSTOM;
    }

    /** @returns {Window} */
    get window() {
        return this.#window;
    }
});
