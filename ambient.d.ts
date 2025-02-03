import "@girs/gjs";
import "@girs/gjs/dom";
import "@girs/gnome-shell/ambient";
import "@girs/gnome-shell/extensions/global";

/***********************
 * Module Augmentation *
 ***********************/

import "tiling-assistant@leleat-on-github/src/dependencies/gi.js";
import { Rect } from "tiling-assistant@leleat-on-github/src/extension/utility.js";

declare module "tiling-assistant@leleat-on-github/src/dependencies/gi.js" {
    namespace Clutter {
        interface Actor {
            ease: (params: object) => void;
        }
    }

    namespace GObject {
        interface Object {
            connectObject: (...args: unknown[]) => void;
            disconnectObject: (object: object) => void;
        }
    }

    namespace Meta {
        interface Window {
            assertExistence: () => void;
            isTiled: boolean
            tiledRect?: Rect
            untiledRect?: Rect
        }
    }

}
