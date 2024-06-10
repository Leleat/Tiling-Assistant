import { InjectionManager } from '../dependencies/shell.js';

/** @type {Injections} */
let SINGLETON = null;

function enable() {
    SINGLETON = new Injections();
}

function disable() {
    SINGLETON.destroy();
    SINGLETON = null;
}

class Injections {
    /** @type {InjectionManager} */
    _injectionManager = new InjectionManager();
    /** @type {Map<object, string[]>} */
    _injectedProperties = new Map();

    destroy() {
        this._injectionManager.clear();

        this._injectedProperties.forEach((injectedProps, target) => {
            injectedProps.forEach(prop => {
                // accessor props
                delete target[prop];
                // data props
                delete target[`__injected_map_${prop}`];
            });
        });
        this._injectedProperties.clear();
    }

    /**
     * Injects new accessor property into a prototype
     *
     * @param {object} prototype -
     * @param {string} prop -
     * @param {object} descriptor -
     */
    addAccessorProperty(prototype, prop, descriptor) {
        if (prototype[prop] !== undefined) {
            throw new Error(
                `Overwriting existing property (${prop}) not supported....`
            );
        }

        Object.defineProperty(prototype, prop, {
            ...descriptor,
            configurable: true
        });

        const propNames = this._injectedProperties.get(prototype);

        if (propNames)
            propNames.push(prop);
        else
            this._injectedProperties.set(prototype, [prop]);
    }

    /**
     * Injects 'data properties' into objects. Behind the scenes this actually
     * attaches a WeakMap to the prototype with 'object instances' serving as
     * keys. The values of the Map are the 'instance properties'. By attaching
     * everything to the prototype, the removal of the custom properties is
     * relatively easy. We just need to track the prototype rather than finding
     * or tracking all object instances.
     *
     * @param {object} prototype -
     * @param {string} prop -
     */
    addDataProperty(prototype, prop) {
        if (prototype[prop] !== undefined) {
            throw new Error(
                `Overwriting existing property (${prop}) not supported....`
            );
        }

        if (!prototype[`__injected_map_${prop}`])
            prototype[`__injected_map_${prop}`] = new WeakMap();

        Object.defineProperty(prototype, prop, {
            get() {
                return this[`__injected_map_${prop}`].get(this);
            },
            set(value) {
                this[`__injected_map_${prop}`].set(this, value);
            },
            configurable: true
        });

        const propNames = this._injectedProperties.get(prototype);

        if (propNames)
            propNames.push(prop);
        else
            this._injectedProperties.set(prototype, [prop]);
    }

    /**
     * Modifies, replaces or injects a method into a (prototype) object
     *
     * @param {object} prototype - the object (or prototype) that is modified
     * @param {string} methodName - the name of the overwritten method
     * @param {(originalFn: Function) => Function} fnCreator - function to call
     *      to create the override. The parameter will be the original function,
     *      if it exists. It returns the new function be used for
     *      `methodName`.
     */
    overrideMethod(prototype, methodName, fnCreator) {
        this._injectionManager.overrideMethod(prototype, methodName, fnCreator);
    }

    /**
     * Deletes a custom property injected with this singleton
     *
     * @param {object} prototype -
     * @param {string} propName -
     */
    deleteProperty(prototype, propName) {
        const propNames = this._injectedProperties.get(prototype);

        if (!propNames || !propNames.includes(propName))
            return;

        if (propNames.length === 1) {
            this._injectedProperties.delete(prototype);
        } else {
            this._injectedProperties.set(
                prototype,
                propNames.filter(p => p !== propName)
            );
        }

        // accessor prop
        delete prototype[propName];
        // data prop
        delete prototype[`__injected_map_${propName}`];
    }

    /**
     * Restores the original method
     *
     * @param {object} prototype - the object (or prototype) that is modified
     * @param {string} methodName - the name of the method to restore
     */
    restoreMethod(prototype, methodName) {
        this._injectionManager.restoreMethod(prototype, methodName);
    }
}

export { enable, disable, SINGLETON as Injections };
