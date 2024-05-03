/**
 * Helper classes / enums for the settings.xml used in the extension files
 * *and* prefs files
 */

export const ActiveWindowHint = Object.freeze({
    DISABLED: 0,
    MINIMAL: 1,
    ALWAYS: 2
});

export const DynamicKeybindings = Object.freeze({
    DISABLED: 0,
    FOCUS: 1,
    TILING_STATE: 2,
    TILING_STATE_WINDOWS: 3,
    FAVORITE_LAYOUT: 4
});

export const MoveModeMods = Object.freeze({
    DISABLED: 0,
    CTRL: 1,
    ALT: 2,
    RMB: 3,
    META: 4
});

export const MoveModes = Object.freeze({
    EDGE_TILING: 0,
    ADAPTIVE_TILING: 1,
    FAVORITE_LAYOUT: 2,
    IGNORE_TA: 3
});

export const Orientation = Object.freeze({
    H: 1,
    V: 2
});

export const Direction = Object.freeze({
    N: 1,
    E: 2,
    S: 4,
    W: 8,
    opposite(dir) {
        let opposite = 0;

        if (dir & this.N)
            opposite |= this.S;
        if (dir & this.S)
            opposite |= this.N;
        if (dir & this.W)
            opposite |= this.E;
        if (dir & this.E)
            opposite |= this.W;

        return opposite;
    }
});

// Classes for the layouts:
// See src/prefs/layoutsPrefs.js for details on layouts.
export class Layout {
    /**
     * @param {object} layout is the parsed object from the layouts file.
     */
    constructor(layout = null) {
        this._name = layout?._name ?? '';
        this._items = layout?._items ?? [];
    }

    /**
     * @returns {string}
     */
    getName() {
        return this._name;
    }

    /**
     * @param {string} name
     */
    setName(name) {
        this._name = name;
    }

    /**
     * @param {number} index
     * @returns {LayoutItem}
     */
    getItem(index) {
        return this._items[index];
    }

    /**
     * @param {LayoutItem|null} item
     * @returns {LayoutItem} the added item.
     */
    addItem(item = null) {
        item = item ?? new LayoutItem();
        this._items.push(item);
        return item;
    }

    /**
     * @param {number} index
     * @returns {LayoutItem|null} the removed item.
     */
    removeItem(index) {
        return this._items.splice(index, 1)[0];
    }

    /**
     * @param {boolean} filterOutEmptyRects
     * @returns {LayoutItem[]}
     */
    getItems(filterOutEmptyRects = true) {
        return filterOutEmptyRects
            ? this._items.filter(i => Object.keys(i.rect).length === 4)
            : this._items;
    }

    /**
     * @param {LayoutItem[]} items
     */
    setItems(items) {
        this._items = items;
    }

    /**
     * @param {boolean} filterOutEmptyRects
     * @returns {number}
     */
    getItemCount(filterOutEmptyRects = false) {
        return filterOutEmptyRects
            ? this.getItems().length
            : this._items.length;
    }

    /**
     * @returns {[boolean, string]} whether the layout has valid rects and
     *      a potential error message.
     */
    validate() {
        const rects = this.getItems().map(i => i.rect);
        if (!rects.length)
            return [false, 'No valid rectangles defined.', -1];

        const getOverlapArea = (r1, r2) => {
            return Math.max(0, Math.min(r1.x + r1.width, r2.x + r2.width) - Math.max(r1.x, r2.x)) *
                    Math.max(0, Math.min(r1.y + r1.height, r2.y + r2.height) - Math.max(r1.y, r2.y));
        };

        for (let i = 0; i < rects.length; i++) {
            const rect = rects[i];

            if (rect.width <= 0 || rect.width > 1)
                return [false, `Rectangle ${i} has an invalid width.`, i];

            if (rect.height <= 0 || rect.height > 1)
                return [false, `Rectangle ${i} has an invalid height.`, i];

            if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > 1 || rect.y + rect.height > 1)
                return [false, `Rectangle ${i} extends beyond the screen.`, i];

            for (let j = i + 1; j < rects.length; j++) {
                if (getOverlapArea(rect, rects[j]) !== 0)
                    return [false, `Rectangles ${i} and ${j} overlap.`, j];
            }
        }

        return [true, '', -1];
    }
}

var LayoutItem = class LayoutItem {
    constructor() {
        this.rect = {};
        this.appId = null;
        this.loopType = null;
    }
};
