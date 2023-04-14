'use strict';

const { GLib, Meta } = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

/** @enum {number} */
var Orientation = {
    H: -1,
    V: 1
};

/** A class representing a point. */
var Point = class Point {
    x = 0;
    y = 0;

    /** @param {{ x: number, y: number }} [params] */
    constructor({ x = 0, y = 0 } = {}) {
        this.x = x;
        this.y = y;
    }

    /**
     * @param {Point|{x: number, y: number}} point
     * @returns {number}
     */
    getDistance(point) {
        const diffX = this.x - point.x;
        const diffY = this.y - point.y;
        return Math.sqrt(diffX * diffX + diffY * diffY);
    }
};

/**
 * A wrapper class for a Meta.Rect. In actuality instances of this class will
 * be used as a handler for a Proxy. @see Rect.constructor.
 */
var Rect = class Rect {
    /**
     * Converts `value` to a Meta.Rectangle if it's an instance of Rect.
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
     * Converts `value` to a Rect if it's an instance of Meta.Rectangle.
     * Otherwise just return `value`.
     * @param {*} value
     * @returns {*}
     */
    static #convertValueToWrapper(value) {
        if (value instanceof Meta.Rectangle)
            return new Rect(value);
        else if (Array.isArray(value))
            return value.map(v => this.#convertValueToWrapper(v));
        else
            return value;
    }

    /** @type {Meta.Rectangle} */
    #wrappedObj = null;

    /**
     * Creates a wrapper for a Meta.Rectangle. This actually returns a Proxy
     * using the instance of this class as the handler.
     * @param {Meta.Rectangle} obj
     * @returns {Proxy}
     */
    constructor(obj) {
        if (obj.wrappedObj)
            return obj;

        this.#wrappedObj = obj instanceof Meta.Rectangle
            ? obj : new Meta.Rectangle(obj);

        return new Proxy(this.#wrappedObj, this);
    }

    /**
     * Traps the internal [[Get]] method. If the property is from the wrapped
     * object, get the property from it. Otherwise get the property from `this`.
     * @param {Meta.Rectangle} target - The wrapped object.
     * @param {string} property
     * @returns {*}
     */
    get(target, property) {
        const snakeCaseProperty = property.replace(/[A-Z]/g, v =>
            `_${v.toLowerCase()}`);

        if (snakeCaseProperty in target) {
            if (typeof target[snakeCaseProperty] === 'function') {
                return function (...args) {
                    const metaArgs = args.map(v => Rect.#convertValueToMeta(v));
                    const returnVal = target[snakeCaseProperty](...metaArgs);
                    return Rect.#convertValueToWrapper(returnVal);
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
     * @param {Meta.Rectangle} target - The wrapped object.
     * @param {string} property
     * @param {*} value
     * @returns {boolean}.
     */
    set(target, property, value) {
        this[property] = value;
        return true;
    }

    /**
     * @param {Point|{x: number, y: number}} point
     * @returns {boolean}
     */
    containsPoint(point) {
        return point.x >= this.x && point.x <= this.x2 &&
                point.y >= this.y && point.y <= this.y2;
    }

    /**
     * Gets the Rect at `index` if `this` is cut into units with - depending on
     * the `orientation` - the width or height of `unitSize`. All rects will have
     * the same size except maybe the last rect. Rect.minus() and this method are
     * meant to lessen the need for rounding.
     * @param {number} index
     * @param {number} unitSize
     * @param {Orientation} orientation
     * @returns {Rect}
     */
    getUnitAt(index, unitSize, orientation) {
        const size = Math.floor(unitSize);
        const isVertical = orientation === Orientation.V;
        const dimension = isVertical ? this.width : this.height;

        if (size > dimension)
            throw new Error('Inappropriate unit size.');

        if (index >= Math.floor(dimension / size) || index < 0)
            throw new Error('Index is outside the allowed range.');

        const firstUnitRect = new Rect({
            x: this.x,
            y: this.y,
            width: isVertical ? unitSize : this.width,
            height: isVertical ? this.height : unitSize
        });

        if (index < 1) {
            return firstUnitRect;
        } else {
            const remaining = this.minus(firstUnitRect)[0];
            return remaining.getUnitAt(index - 1, size, orientation);
        }
    }

    /**
     * Gets an array of Rects that remain from `this` if `rect` is cut off from it.
     * @param {Rect|Rect[]} rect
     * @returns {Rect[]}
     */
    minus(rect) {
        return Array.isArray(rect)
            ? this.#minusRectArray(rect)
            : this.#minusRect(rect);
    }

    /**
     * Helper method for Rect.minus(), which accepts 1 Rect as a parameter.
     * Original idea from: https://en.wikibooks.org/wiki/Algorithm_Implementation/Geometry/Rectangle_difference
     * No license is given except the general CC-BY-AS (for text) mentioned
     * in the footer. Since the algorithm seems fairly generic (just a few
     * additions / subtractions), I think I should be good regardless...
     * I've modified the algorithm to make the left / right result rects bigger
     * instead of the top / bottom rects since screens usually have horizontal
     * orientations; so having the vertical rects take priority makes more sense.
     * @param {Rect} rect
     * @returns {Rect[]}
     */
    #minusRect(rect) {
        if (rect.wrappedObj.contains_rect(this.#wrappedObj))
            return [];

        const [intersect] = this.#wrappedObj.intersect(rect.wrappedObj);
        if (!intersect)
            return [new Rect(this.#wrappedObj.copy())];

        const resultRects = [];

        // Left rect
        const leftRectWidth = rect.x - this.x;
        if (leftRectWidth > 0 && this.height > 0) {
            resultRects.push(new Rect({
                x: this.x,
                y: this.y,
                width: leftRectWidth,
                height: this.height
            }));
        }

        // Right rect
        const rightRectWidth = this.x2 - rect.x2;
        if (rightRectWidth > 0 && this.height > 0) {
            resultRects.push(new Rect({
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
            resultRects.push(new Rect({
                x: vertRectsX1,
                y: this.y,
                width: vertRectsWidth,
                height: topRectHeight
            }));
        }

        // Bottom rect
        const bottomRectHeight = this.y2 - rect.y2;
        if (bottomRectHeight > 0 && vertRectsWidth > 0) {
            resultRects.push(new Rect({
                x: vertRectsX1,
                y: rect.y2,
                width: vertRectsWidth,
                height: bottomRectHeight
            }));
        }

        return resultRects;
    }

    /**
     * Helper method for Rect.minus(), which accepts an array of Rects as a parameter.
     * @param {Rect[]} rects
     * @returns {Rect[]}
     */
    #minusRectArray(rects) {
        if (!rects.length)
            return [new Rect(this.#wrappedObj.copy())];

        // First cut off all rects individually from `this`. The result is an
        // array of leftover rects (which are arrays themselves) from `this`.
        const individualLeftOvers = rects.map(r => this.minus(r));

        // Get the final result by intersecting all leftover rects.
        return individualLeftOvers.reduce((result, currLeftOvers) => {
            const intersections = [];

            for (const leftOver of currLeftOvers) {
                for (const currFreeRect of result) {
                    const [ok, inters] = currFreeRect.intersect(leftOver);
                    ok && intersections.push(new Rect(inters));
                }
            }

            return intersections;
        });
    }

    /** @returns {Meta.Rectangle} */
    get wrappedObj() {
        return this.#wrappedObj;
    }

    /** @returns {number} */
    get x() {
        return this.#wrappedObj.x;
    }

    /** @returns {number} */
    get x2() {
        return this.#wrappedObj.x + this.#wrappedObj.width;
    }

    /** @returns {number} */
    get y() {
        return this.#wrappedObj.y;
    }

    /** @returns {number} */
    get y2() {
        return this.#wrappedObj.y + this.#wrappedObj.height;
    }

    /** @returns {number} */
    get width() {
        return this.#wrappedObj.width;
    }

    /** @returns {number} */
    get height() {
        return this.#wrappedObj.height;
    }

    /** @param {number} value */
    set x(value) {
        this.#wrappedObj.x = Math.floor(value);
    }

    /** @param {number} value */
    set x2(value) {
        this.#wrappedObj.width = Math.floor(value) - this.x;
    }

    /** @param {number} value */
    set y(value) {
        this.#wrappedObj.y = Math.floor(value);
    }

    /** @param {number} value */
    set y2(value) {
        this.#wrappedObj.height = Math.floor(value) - this.y;
    }

    /** @param {number} value */
    set width(value) {
        this.#wrappedObj.width = Math.floor(value);
    }

    /** @param {number} value */
    set height(value) {
        this.#wrappedObj.height = Math.floor(value);
    }
};

/**
 * A class implementing a singleton, which provides access to the extension's
 * settings. It wraps a Gio.Settings object with a Proxy. All members of
 * Gio.Settings can be accessed with camelCase.
 */
var Settings = class Settings {
    static #allowConstruction = false;
    static #SINGLETON = null;

    /**
     * Gets the singleton instance.
     * @returns {Proxy}
     */
    static get() {
        if (!Settings.#SINGLETON) {
            Settings.#allowConstruction = true;
            const gio = ExtensionUtils.getSettings(Me.metadata['settings-schema']);
            const handler = new Settings(gio);
            Settings.#allowConstruction = false;

            Settings.#SINGLETON = new Proxy(gio, handler);
        }

        return Settings.#SINGLETON;
    }

    /** @type {Gio.Settings} */
    #wrappedObj = null;

    /**
     * @param {Gio.Settings} gioSettings
     * @private
     */
    constructor(gioSettings) {
        if (!Settings.#allowConstruction)
            throw new Error('Settings is a Singleton. Use Settings.get().');

        this.#wrappedObj = gioSettings;

        // Used for detection of a new install and to do compatibility changes
        this.#wrappedObj.set_int('last-version-installed', Me.metadata.version);
    }

    /**
     * Traps the internal [[Get]] method. If the property is from the wrapped
     * object, get the property from it. Otherwise get the property from `this`.
     * @param {Gio.Settings} target - The wrapped object.
     * @param {string} property - The name or Symbol of the property to get.
     * @returns {*}
     */
    get(target, property) {
        const snakeCaseProperty = property.replace(/[A-Z]/g, v =>
            `_${v.toLowerCase()}`);

        if (snakeCaseProperty in target)
            return Reflect.get(target, snakeCaseProperty);

        return typeof this[property] === 'function'
            ? this[property].bind(this)
            : this[property];
    }

    destroy() {
        this.#wrappedObj.run_dispose();
        this.#wrappedObj = null;

        Settings.#SINGLETON = null;
    }

    /** @returns {Gio.Settings} */
    get wrappedObj() {
        return this.#wrappedObj;
    }
};

/** An array of the existing shortcuts. */
var Shortcuts = [
    'tile-maximize',
    'tile-to-top',
    'tile-to-bottom',
    'tile-to-left',
    'tile-to-right',
    'tile-to-top-left',
    'tile-to-top-right',
    'tile-to-bottom-left',
    'tile-to-bottom-right'
];

/**
 * An enum-ish object for the different possible tiling states.
 * @enum {number}
 */
var TileMode = {
    TOP: 1,
    LEFT: 2,
    RIGHT: 4,
    BOTTOM: 8,
    MAXIMIZE: 16,
    CUSTOM: 32,

    /**
     * Gets the TileMode for the Shortcut `shortcut`.
     * @param {string} shortcut
     * @returns {TileMode}
     */
    getForShortcut(shortcut) {
        switch (shortcut) {
            case 'tile-maximize':
                return this.MAXIMIZE;
            case 'tile-to-top':
                return this.TOP;
            case 'tile-to-bottom':
                return this.BOTTOM;
            case 'tile-to-left':
                return this.LEFT;
            case 'tile-to-right':
                return this.RIGHT;
            case 'tile-to-top-left':
                return this.TOP | this.LEFT;
            case 'tile-to-top-right':
                return this.TOP | this.RIGHT;
            case 'tile-to-bottom-left':
                return this.BOTTOM | this.LEFT;
            case 'tile-to-bottom-right':
                return this.BOTTOM | this.RIGHT;
            default:
                throw new Error('ERROR ERROR ERROR getForShortcut: unhandled shortcut.....');
        }
    }
};

/**
 * A simple singleton class to create timeouts. It cleans up all remaining
 * timeouts on destruction so that objects themselves no longer need to keep
 * track of their timeouts.
 */
var Timeouts = class Timeouts {
    static #allowConstruction = false;
    static #SINGLETON = null;

    /**
     * Gets the singleton instance.
     * @returns {Proxy}
     */
    static get() {
        if (!Timeouts.#SINGLETON) {
            Timeouts.#allowConstruction = true;
            Timeouts.#SINGLETON = new Timeouts();
            Timeouts.#allowConstruction = false;
        }

        return Timeouts.#SINGLETON;
    }

    /** @type {number[]} */
    #ids = [];

    /** @private */
    constructor() {
        if (!Timeouts.#allowConstruction)
            throw new Error('Timeouts is a Singleton. Use Timeouts.get().');
    }

    destroy() {
        this.#ids.forEach(sourceID => GLib.Source.remove(sourceID));
        this.#ids = [];

        Timeouts.#SINGLETON = null;
    }

    /**
     * Adds a timeout. The callback `fn` will be called repeatedly at `interval`
     * milliseconds until the timeout is removed with Timeouts.remove() or until
     * the callback returns GLib.SOURCE_REMOVE. This works analogously to
     * GLib.timeout_add().
     * @param {{interval: number, fn: function(): boolean, priority: number}} params
     * @returns {number} - The ID of the timeout.
     */
    add({ interval, fn, priority = GLib.PRIORITY_DEFAULT }) {
        let sourceID = 0;
        const selfCleaningFn = () => {
            const returnVal = fn();
            if (returnVal === GLib.SOURCE_REMOVE)
                this.#stopTracking(sourceID);

            return returnVal;
        };

        sourceID = GLib.timeout_add(priority, interval, selfCleaningFn);
        this.#ids.push(sourceID);

        return sourceID;
    }

    /**
     * Removes the timeout with the ID of `id`. This is the analogous function
     * to GLib.source.remove();
     * @param {number} id
     */
    remove(id) {
        if (!this.#ids.includes(id))
            return;

        this.#stopTracking(id);
        GLib.Source.remove(id);
    }

    /**
     * Stops tracking the timeout with the ID `id`. For instance, this is used
     * if the timeout removes itself with GLib.SOURCE_REMOVE in its callback.
     * @param {number} id
     */
    #stopTracking(id) {
        const idx = this.#ids.indexOf(id);
        idx !== -1 && this.#ids.splice(idx, 1);
    }
};
