'use strict';

/**
 * Library of commonly used functions for the prefs' files
 * (and *not* the extension files)
 */

var Util = class Utility {
    /**
     * Loops through the children of a Gtk.Widget.
     *
     * @param {object} that `this` for the `func`.
     * @param {object} container the parent widget of the children.
     * @param {function(object, number)} func the function to execute each
     *      loop with the child and its index as a parameter.
     */
    static forEachChild(that, container, func) {
        for (let i = 0, child = container.get_first_child(); !!child; i++) {
            // Get a ref to the next widget in case the curr widget
            // gets destroyed during the function call.
            const nxtSibling = child.get_next_sibling();
            func.call(that, child, i);
            child = nxtSibling;
        }
    }

    /**
     * @param {Gtk.Widget} container the parent container.
     * @param {number} idx the index of the child to get.
     * @returns {Gtk.Widget|null} the child at the index, if it exists.
     */
    static getChild(container, idx) {
        let child = container.get_first_child();
        for (let i = 0; !!child; i++) {
            if (i === idx)
                return child;

            child = child.get_next_sibling();
        }

        return null;
    }
};
