const { Clutter, GObject, Meta, St } = imports.gi;
const Main = imports.ui.main;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const { Direction, Orientation, Settings } = Me.imports.src.common;
const Rect = Me.imports.src.extension.geometry.Rect;
const Util = Me.imports.src.extension.utility.Util;

const Gettext = imports.gettext;
const Domain = Gettext.domain(Me.metadata.uuid);
const _ = Domain.gettext;

const MODES = {
    SELECT: 1,
    SWAP: 2
};

// TODO: Rewrite entire file. The mode and indicator system,
// the keyboard handling and basically everything else as well are quite bad...
// although they are working correctly.
// Change resize mode: follow gnomes keyboard-based resizing

// eslint-disable-next-line no-unused-vars
var TileEditor = GObject.registerClass(class TilingEditingMode extends St.Widget {

    _init() {
        const currMon = global.display.get_current_monitor();
        const display = global.display.get_monitor_geometry(currMon);
        super._init({
            x: display.x,
            y: display.y,
            width: display.width,
            height: display.height,
            reactive: true
        });

        this._haveModal = false;
        this.currMode = MODES.SELECT;
        Main.uiGroup.add_child(this);
    }

    open() {
        if (!Main.pushModal(this)) {
            // Probably someone else has a pointer grab, try again with keyboard
            const alreadyGrabbed = Meta.ModalOptions.POINTER_ALREADY_GRABBED;
            if (!Main.pushModal(this, { options: alreadyGrabbed })) {
                this.destroy();
                return;
            }
        }

        this._haveModal = true;
        this._windows = Util.getTopTileGroup(false);

        const openWindows = Util.getWindows();
        if (!openWindows.length || !this._windows.length) {
            const msg = _("Can't enter 'Tile Editing Mode', if a tile group isn't visible.");
            Main.notify('Tiling Assistant', msg);
            this.close();
            return;
        }

        const window = this._windows[0];
        for (const w of openWindows) {
            if (w === this._windows[0])
                break;

            w.lower();
        }

        const gap = Settings.getInt(Settings.WINDOW_GAP);
        const color = Settings.getString(Settings.TILE_EDITING_MODE_COLOR); // 'rgb(X,Y,Z)'

        // primary window is the focused window, which is operated on
        const style = `border: ${Math.max(gap / 2, 4)}px solid ${color};`;
        this._primaryIndicator = new Indicator(style, gap);
        this.add_child(this._primaryIndicator);

        // secondary indicator (for swapping with focused window).
        // the primary and secondary indicator combined indicate the focus.
        // the primary indicator is the thick border/outline and the seconday indicator the filling
        const rgb = color.substring(color.indexOf('(') + 1, color.indexOf(')')).split(',');
        const style2 = `background-color: rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, .3);`;
        this._secondaryIndicator = new Indicator(style2, gap);
        this.add_child(this._secondaryIndicator);

        this.select(window.tiledRect, window);
    }

    close() {
        if (this._haveModal) {
            Main.popModal(this);
            this._haveModal = false;
        }

        const window = this._primaryIndicator?.window;
        window?.activate(global.get_current_time());

        this.ease({
            opacity: 0,
            duration: 100,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this.destroy()
        });
    }

    select(rect, window) {
        this.currMode = MODES.SELECT;
        this._primaryIndicator.select(rect, window);
        this._secondaryIndicator.select(rect, window);
    }

    secondarySelect(rect, window) {
        this.currMode = MODES.SWAP;
        this._secondaryIndicator.select(rect, window);
    }

    vfunc_button_press_event() {
        this.close();
    }

    vfunc_key_press_event(keyEvent) {
        const keySym = keyEvent.keyval;
        const modState = keyEvent.modifier_state;
        const isCtrlPressed = modState & Clutter.ModifierType.CONTROL_MASK;
        const isShiftPressed = modState & Clutter.ModifierType.SHIFT_MASK;
        const isSuperPressed = modState & Clutter.ModifierType.MOD4_MASK;

        // [E]xpand to fill space
        if (keySym === Clutter.KEY_e || keySym === Clutter.KEY_E) {
            const window = this._primaryIndicator.window;
            if (!window)
                return;

            const tiledRect = this._windows.map(w => w.tiledRect);
            const tileRect = Util.getBestFreeRect(tiledRect, window.tiledRect);
            if (window.tiledRect.equal(tileRect))
                return;

            const maximize = tileRect.equal(window.get_work_area_current_monitor());
            if (maximize && this._windows.length > 1)
                return;

            Util.tile(window, tileRect, { openTilingPopup: false });
            maximize ? this.close() : this.select(window.tiledRect, window);

        // [C]ycle through halves of the available space of the window
        } else if ((keySym === Clutter.KEY_c || keySym === Clutter.KEY_C)) {
            const window = this._primaryIndicator.window;
            if (!window)
                return;

            const tiledRects = this._windows.map(w => w.tiledRect);
            const fullRect = Util.getBestFreeRect(tiledRects, window.tiledRect);
            const topHalf = fullRect.getUnitAt(0, fullRect.height / 2, Orientation.H);
            const rightHalf = fullRect.getUnitAt(1, fullRect.width / 2, Orientation.V);
            const bottomHalf = fullRect.getUnitAt(1, fullRect.height / 2, Orientation.H);
            const leftHalf = fullRect.getUnitAt(0, fullRect.width / 2, Orientation.V);
            const rects = [topHalf, rightHalf, bottomHalf, leftHalf];
            const currIdx = rects.findIndex(r => r.equal(window.tiledRect));
            const newIndex = (currIdx + 1) % 4;

            Util.tile(window, rects[newIndex], { openTilingPopup: false });
            this.select(rects[newIndex], window);

        // [Q]uit a window
        } else if (keySym === Clutter.KEY_q || keySym === Clutter.KEY_Q) {
            const window = this._primaryIndicator.window;
            if (!window)
                return;

            this._windows.splice(this._windows.indexOf(window), 1);
            window.delete(global.get_current_time());
            const newWindow = this._windows[0];
            newWindow ? this.select(newWindow.tiledRect, newWindow) : this.close();

        // [R]estore window size
        } else if (keySym === Clutter.KEY_r || keySym === Clutter.KEY_R) {
            const window = this._primaryIndicator.window;
            if (!window)
                return;

            const ogRect = window.tiledRect.copy();
            this._windows.splice(this._windows.indexOf(window), 1);
            Util.untile(window);
            if (!this._windows.length) {
                this.close();
                return;
            }

            this._windows.forEach(w => w.raise());
            const topTiled = Util.getWindows().find(w => this._windows.includes(w));
            topTiled.activate(global.get_current_time());
            this.select(ogRect, null);

        // [Esc]ape tile editing mode
        } else if (keySym === Clutter.KEY_Escape) {
            this.currMode === MODES.SELECT
                ? this.close()
                : this.select(this._primaryIndicator.rect, this._primaryIndicator.window);

        // [Enter/Space]
        } else if (keySym === Clutter.KEY_Return || keySym === Clutter.KEY_space) {
            if (this.currMode !== MODES.SELECT)
                return;

            const window = this._primaryIndicator.window;
            if (window) {
                this.close();

            // open Tiling Popup, when activating an empty spot
            } else {
                const openWindows = Util.getWindows(Settings.getBoolean(Settings.CURR_WORKSPACE_ONLY))
                    .filter(w => !this._windows.includes(w));
                const rect = this._primaryIndicator.rect;
                const TilingPopup = Me.imports.src.extension.tilingPopup;
                const tilingPopup = new TilingPopup.TilingSwitcherPopup(openWindows, rect, false);
                if (!tilingPopup.show(this._windows)) {
                    tilingPopup.destroy();
                    return;
                }

                tilingPopup.connect('closed', (popup, canceled) => {
                    if (canceled)
                        return;

                    const { tiledWindow } = popup;
                    this._windows.unshift(tiledWindow);
                    this.select(tiledWindow.tiledRect, tiledWindow);
                });
            }

        // [Direction] (WASD, hjkl or arrow keys)
        } else if (Util.isDirection(keySym, Direction.N)) {
            isSuperPressed
                ? this._resize(Direction.N, isShiftPressed)
                : this._selectTowards(Direction.N, isCtrlPressed);

        } else if (Util.isDirection(keySym, Direction.S)) {
            isSuperPressed
                ? this._resize(Direction.S, isShiftPressed)
                : this._selectTowards(Direction.S, isCtrlPressed);

        } else if (Util.isDirection(keySym, Direction.W)) {
            isSuperPressed
                ? this._resize(Direction.W, isShiftPressed)
                : this._selectTowards(Direction.W, isCtrlPressed);

        } else if (Util.isDirection(keySym, Direction.E)) {
            isSuperPressed
                ? this._resize(Direction.E, isShiftPressed)
                : this._selectTowards(Direction.E, isCtrlPressed);
        }
    }

    _selectTowards(direction, isCtrlPressed) {
        const activeWs = global.workspace_manager.get_active_workspace();
        const monitor = global.display.get_current_monitor();
        const workArea = new Rect(activeWs.get_work_area_for_monitor(monitor));
        const currRect = isCtrlPressed ? this._secondaryIndicator.rect : this._primaryIndicator.rect;
        const tiledRects = this._windows.map(w => w.tiledRect);
        const freeScreenRects = workArea.minus(tiledRects);
        const closestRect = currRect.getNeighbor(direction, tiledRects.concat(freeScreenRects));
        if (!closestRect)
            return;

        const newWindow = this._windows.find(w => w.tiledRect.equal(closestRect));
        isCtrlPressed
            ? this.secondarySelect(closestRect, newWindow)
            : this.select(closestRect, newWindow);
    }

    _resize(direction, isShiftPressed) {
        const window = this._primaryIndicator.window;
        if (!window)
            return;

        const resizedRect = window.tiledRect.copy();
        const workArea = new Rect(window.get_work_area_current_monitor());
        let resizeStep = 100;
        // limit resizeStep when trying to extend outside of the current screen
        if (direction === Direction.N && isShiftPressed)
            resizeStep = Math.min(resizeStep, resizedRect.y - workArea.y);
        else if (direction === Direction.S && !isShiftPressed)
            resizeStep = Math.min(resizeStep,
                workArea.y2 - resizedRect.y2);
        else if (direction === Direction.W && isShiftPressed)
            resizeStep = Math.min(resizeStep, resizedRect.x - workArea.x);
        else if (direction === Direction.E && !isShiftPressed)
            resizeStep = Math.min(resizeStep,
                workArea.x2 - resizedRect.x2);

        if (!resizeStep) {
            Main.notify('Tiling Assistant', _("Can't resize in that direction. Super + Directions resizes on the S and E side. Super + Shift + Directions on the N and W side."));
            return;
        }

        const isVertical = direction === Direction.N || direction === Direction.S;
        const changeDir = ((direction === Direction.S || direction === Direction.E) ? 1 : -1)
                * (isShiftPressed ? -1 : 1);
        const getResizedRect = function(rect, dimensionChangeOnly, dir) {
            return new Rect(
                rect.x + (dimensionChangeOnly || isVertical ? 0 : resizeStep * -dir),
                rect.y + (!dimensionChangeOnly && isVertical ? resizeStep * -dir : 0),
                rect.width + (isVertical ? 0 : resizeStep * dir),
                rect.height + (isVertical ? resizeStep * dir : 0)
            );
        };
        const resizeSide = function(rect1, rect2, opposite) {
            const [posProp, dimensionProp] = isVertical ? ['y', 'height'] : ['x', 'width'];
            if (isShiftPressed)
                return opposite ? Util.equal(rect1[posProp] + rect1[dimensionProp], rect2[posProp])
                    : Util.equal(rect1[posProp], rect2[posProp]);
            else
                return opposite
                    ? Util.equal(rect1[posProp], rect2[posProp] + rect2[dimensionProp])
                    : Util.equal(rect1[posProp] + rect1[dimensionProp],
                        rect2[posProp] + rect2[dimensionProp]);
        };

        this._windows.forEach(w => {
            if (resizeSide.call(this, w.tiledRect, resizedRect, false)) {
                const tileRect = getResizedRect(w.tiledRect, !isShiftPressed, changeDir);
                if (tileRect.equal(w.get_work_area_current_monitor()))
                    return;

                Util.tile(w, tileRect, { openTilingPopup: false });
            } else if (resizeSide.call(this, w.tiledRect, resizedRect, true)) {
                const tileRect = getResizedRect(w.tiledRect, isShiftPressed, -changeDir);
                if (tileRect.equal(w.get_work_area_current_monitor()))
                    return;

                Util.tile(w, tileRect, { openTilingPopup: false });
            }
        });
        this.select(window.tiledRect, window);
    }

    vfunc_key_release_event(keyEvent) {
        const primWindow = this._primaryIndicator.window;
        const secWindow = this._secondaryIndicator.window;

        if (this.currMode === MODES.SWAP
                && [Clutter.KEY_Control_L, Clutter.KEY_Control_R].includes(keyEvent.keyval)) {
            // TODO messy code and difficult to use/activate since ctrl needs to be released first...
            // try to [equalize] the size (width OR height) of the highlighted rectangles
            // including the rectangles which are in the union of the 2 highlighted rects
            if (keyEvent.modifier_state & Clutter.ModifierType.SHIFT_MASK) {
                const equalize = function(pos, dimension) {
                    const unifiedRect = primWindow.tiledRect.union(secWindow.tiledRect);
                    const windowsToResize = Util.getTopTileGroup(false).filter(w => unifiedRect.containsRect(w.tiledRect));
                    if (unifiedRect.area !== windowsToResize.reduce((areaSum, w) => areaSum + w.tiledRect.area, 0))
                        return;

                    const [beginnings, endings] = windowsToResize.reduce((array, w) => {
                        array[0].push(w.tiledRect[pos]);
                        array[1].push(w.tiledRect[pos] + w.tiledRect[dimension]);
                        return array;
                    }, [[], []]);
                    const uniqueBeginnings = [...new Set(beginnings)].sort((a, b) => a - b);
                    const uniqueEndings = [...new Set(endings)].sort((a, b) => a - b);
                    const newDimension = Math.ceil(unifiedRect[dimension] / uniqueEndings.length); // per row/column
                    windowsToResize.forEach(w => {
                        const rect = w.tiledRect.copy();
                        const begIdx = uniqueBeginnings.indexOf(w.tiledRect[pos]);
                        const endIdx = uniqueEndings.indexOf(w.tiledRect[pos] + w.tiledRect[dimension]);
                        rect[pos] = unifiedRect[pos] + begIdx * newDimension;
                        rect[dimension] = w.tiledRect[pos] + w.tiledRect[dimension] === unifiedRect[pos] + unifiedRect[dimension]
                            ? unifiedRect[pos] + unifiedRect[dimension] - rect[pos]
                            : (endIdx - begIdx + 1) * newDimension;
                        Util.tile(w, rect, { openTilingPopup: false });
                    });
                };

                if (primWindow.tiledRect.x === secWindow.tiledRect.x
                        || primWindow.tiledRect.x2 === secWindow.tiledRect.x2)
                    equalize('y', 'height');
                else if (primWindow.tiledRect.y === secWindow.tiledRect.y
                        || primWindow.tiledRect.y2 === secWindow.tiledRect.y2)
                    equalize('x', 'width');

                this.select(secWindow.tiledRect, secWindow);

            // [swap] focused and secondary window(s)/rect
            } else {
                primWindow && Util.tile(primWindow, this._secondaryIndicator.rect, { openTilingPopup: false });
                secWindow && Util.tile(secWindow, this._primaryIndicator.rect, { openTilingPopup: false });
                this.select(this._secondaryIndicator.rect, primWindow);
            }
        }
    }
});

const Indicator = GObject.registerClass(
    class TilingEditingModeIndicator extends St.Widget {

        _init(style, gap) {
            super._init({
                style,
                opacity: 0
            });

            this.rect = null;
            this.window = null;
            this._gap = gap;
        }

        select(rect, window) {
            const monitor = global.display.get_current_monitor();
            const display = global.display.get_monitor_geometry(monitor);
            this.ease({
                x: rect.x + (this._gap - 2) / 2 - display.x,
                y: rect.y + (this._gap - 2) / 2 - display.y,
                width: rect.width - this._gap + 2,
                height: rect.height - this._gap + 2,
                opacity: 255,
                duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD
            });

            this.rect = rect;
            this.window = window;
        }
    });
