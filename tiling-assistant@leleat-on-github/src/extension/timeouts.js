import { GLib } from '../dependencies/gi.js';

/** @type {Timeouts} */
let SINGLETON = null;

function enable() {
    SINGLETON = new Timeouts();
}

function disable() {
    SINGLETON.destroy();
    SINGLETON = null;
}

/**
 * A convenience class to add timeouts that automatically removes the running
 * timeouts when the extensions is disabled. Otherwise each object or class
 * that uses a timeout needs to track their timeouts and remove them on disable
 * via `destroy`.
 */
class Timeouts {
    /** @type {Map<number, string>} */
    _sourceIdAndNames = new Map();

    destroy() {
        this._sourceIdAndNames.forEach((name, id) => GLib.Source.remove(id));
        this._sourceIdAndNames.clear();
    }

    /**
     * @param {object} param
     * @param {number} param.interval - the time between calls of `fn` in ms
     * @param {Function} param.fn - the function to call after `interval`
     * @param {number} [param.priority] - the GLib priority. The default is
     *      `GLib.PRIORITY_DEFAULT`
     * @param {string} [param.name] - the `name` to give a timeout. A `name` can
     *      only be associated with 1 timeout. The previous timeout associated
     *      with `name` will be stopped.
     *
     * @returns {number} the id of the event source
     */
    add({ interval, fn, priority = GLib.PRIORITY_DEFAULT, name = '' }) {
        if (name) {
            for (const [id, _name] of this._sourceIdAndNames.entries()) {
                if (name === _name) {
                    this.remove(id);
                    break;
                }
            }
        }

        let sourceID = 0;
        const selfRemovingFn = () => {
            const returnVal = fn();

            if (returnVal === GLib.SOURCE_REMOVE)
                this._sourceIdAndNames.delete(sourceID);

            return returnVal;
        };

        sourceID = GLib.timeout_add(priority, interval, selfRemovingFn);

        this._sourceIdAndNames.set(sourceID, name);

        return sourceID;
    }

    /**
     * @param {number} id
     */
    remove(id) {
        if (!this._sourceIdAndNames.has(id))
            return;

        this._sourceIdAndNames.delete(id);
        GLib.Source.remove(id);
    }
}

export { enable, disable, SINGLETON as Timeouts };
