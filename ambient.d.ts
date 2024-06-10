import "@girs/gjs";
import "@girs/gjs/dom";
import "@girs/gnome-shell/ambient";
import "@girs/gnome-shell/extensions/global";

/***********************
 * Module Augmentation *
 ***********************/

import { Mtk } from '@girs/mtk-14';

declare module '@girs/gobject-2.0' {
    namespace GObject {
        interface Object {
            connectObject: (...args: unknown[]) => void;
            disconnectObject: (object: object) => void;
        }
    }
}

declare module '@girs/meta-14' {
    namespace Meta {
        interface Window {
            isTiled: boolean
            tiledRect: Mtk.Rectangle
            untiledRect: Mtk.Rectangle
            
            /**
             * @param workArea 
             * 
             * @returns whether the window is maximized. Be it using GNOME's native
             *      maximization or the maximization by this extension when using gaps.
             */
            isMaximized: (workArea: Mtk.Rectangle|null) => boolean
        }
    }
}

declare module '@girs/mtk-14' {
    namespace Mtk {
        interface Rectangle {
            get center(): { x: number;  y: number};
            get x2(): number;
            set x2(value: number);
            get y2(): number;
            set y2(value: number);

            /**
             * Gets a new rectangle where the screen and window gaps were
             * added/subbed to/from `this`.
             *
             * @param workArea
             * @param monitor
             *
             * @returns the rectangle after the gaps were taken
             *      into account
             */
            add_gaps: (workArea: Mtk.Rectangle, monitor: number) => Mtk.Rectangle;

            /**
             * @param point
             *
             * @returns
             */
            contains_point: (point: { x: number, y: number }) => boolean;

            /**
             * Gets the neighbor in the direction `dir` within the list of Rects
             * `rects`.
             *
             * @param dir the direction that is looked into.
             * @param rects an array of the available Rects. 
             *      It may contain `this` itself. The rects shouldn't overlap 
             *      each other.
             * @param wrap whether wrap is enabled, if there is no Rect in the
             *      direction of `dir`. Defaults to true.
             *
             * @returns the nearest Rect.
             */
            get_neighbor: (dir: number, rects: Mtk.Rectangle[], wrap?: boolean) => Mtk.Rectangle | null;

            /**
             * Gets the rectangle at `index`, if `this` is split into equally
             * sized rects. This function is meant to prevent rounding errors.
             * Rounding errors may lead to rects not aligning properly and thus
             * messing up other calculations etc... This solution may lead to the
             * last rect's size being off by a few pixels compared to the other
             * rects, if we split `this` multiple times.
             *
             * @param index the position of the rectangle we want after
             *      splitting this rectangle.
             * @param unitSize the size of 1 partial unit of the rectangle.
             * @param orientation determines the split orientation
             *      (horizontally or vertically).
             *
             * @returns the rectangle at `index` after the split.
             */
            get_unit_at: (index: number, unitSize: number, orientation: number) => Mtk.Rectangle

            minus: (r: Mtk.Rectangle | Mtk.Rectangle[]) => Mtk.Rectangle[];

            /**
             * Makes `this` stick to `rect`, if they are close to each other. Use
             * it as a last resort to prevent rounding errors, if you can't use
             * minus() or get_unit_at().
             *
             * @param rect the rectangle to align `this` with.
             * @param margin only align, if `this` and the `rect` are
             *      at most this far away.
             *
             * @returns a reference to this.
             */
            try_align_with: (rect: Mtk.Rectangle, margin?: number) => Mtk.Rectangle;
        }
    }
}
