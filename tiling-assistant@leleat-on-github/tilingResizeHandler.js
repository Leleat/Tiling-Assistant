"use strict";

const {Clutter, Meta} = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const MainExtension = Me.imports.extension;
const Util = Me.imports.tilingUtil;

const Side = {
	NONE: 0,
	SAME_H: 1,
	OPPOSING_H: 2,
	SAME_V: 4,
	OPPOSING_V: 8
};

/**
 * This class gets to handle the resize events of windows (wether they are tiled or not).
 * If a window isn't tiled, nothing happens. If the resized window is tiled, auto-resize the complementing tiled windows.
 * Intercardinal resizing is split into its [H]orizontal and [V]ertical components.
 */

var Handler = class TilingResizeHandler {

	constructor() {
		const isResizing = grabOp => {
			switch (grabOp) {
				case Meta.GrabOp.RESIZING_N:
				case Meta.GrabOp.RESIZING_NW:
				case Meta.GrabOp.RESIZING_NE:
				case Meta.GrabOp.RESIZING_S:
				case Meta.GrabOp.RESIZING_SW:
				case Meta.GrabOp.RESIZING_SE:
				case Meta.GrabOp.RESIZING_E:
				case Meta.GrabOp.RESIZING_W:
					return true;

				default:
					return false;
			}
		};

		this._displaySignals = [];
		this._displaySignals.push(global.display.connect("grab-op-begin", (...params) => {
			// pre GNOME 40 the signal emitter was added as the first and second param, fixed with !1734 in mutter
			const [window, grabOp] = [params[params.length - 2], params[params.length - 1]];
			if (window && isResizing(grabOp))
				this._onResizeStarted(window, grabOp);
		}));
		this._displaySignals.push(global.display.connect("grab-op-end", (...params) => {
			// pre GNOME 40 the signal emitter was added as the first and second param, fixed with !1734 in mutter
			const [window, grabOp] = [params[params.length - 2], params[params.length - 1]];
			if (window && isResizing(grabOp))
				this._onResizeFinished(window, grabOp);
		}));

		this._sizeChangedId = 0;
		this._preGrabRects = new Map();
		// save the windows, which are to be resized (passively) along the actively grabbed one, and a resizeOp.
		// a resizeOp saves the side of the window, which will be passively resized, relative to the actively resized window
		this._resizeOps = new Map();
	}

	destroy() {
		this._displaySignals.forEach(sId => global.display.disconnect(sId));
	}

	_onResizeStarted(window, grabOp) {
		if (!window.isTiled)
			return;

		const topTileGroup = Util.getTopTileGroup(false);
		topTileGroup.forEach(w => this._preGrabRects.set(w, w.get_frame_rect()));
		topTileGroup.splice(topTileGroup.indexOf(window), 1);
		const grabbedRect = window.tiledRect;

		switch (grabOp) {
			// resizing cardinal directions
			case Meta.GrabOp.RESIZING_N:
				for (const otherWindow of topTileGroup) {
					const otherRect = otherWindow.tiledRect;
					const resizeOp = ResizeOp.createResizeOp(
						Util.equalApprox(grabbedRect.y, otherRect.y)
						, Util.equalApprox(grabbedRect.y, otherRect.y + otherRect.height)
						, false
						, false
					);
					resizeOp && this._resizeOps.set(otherWindow, resizeOp);
				}

				this._sizeChangedId = window.connect("size-changed", this._onResizing.bind(this, window, grabOp, null));
				break;

			case Meta.GrabOp.RESIZING_S:
				for (const otherWindow of topTileGroup) {
					const otherRect = otherWindow.tiledRect;
					const resizeOp = ResizeOp.createResizeOp(
						Util.equalApprox(grabbedRect.y + grabbedRect.height, otherRect.y + otherRect.height)
						, Util.equalApprox(grabbedRect.y + grabbedRect.height, otherRect.y)
						, false
						, false
					);
					resizeOp && this._resizeOps.set(otherWindow, resizeOp);
				}

				this._sizeChangedId = window.connect("size-changed", this._onResizing.bind(this, window, grabOp, null));
				break;

			case Meta.GrabOp.RESIZING_E:
				for (const otherWindow of topTileGroup) {
					const otherRect = otherWindow.tiledRect;
					const resizeOp = ResizeOp.createResizeOp(
						false
						, false
						, Util.equalApprox(grabbedRect.x + grabbedRect.width, otherRect.x + otherRect.width)
						, Util.equalApprox(grabbedRect.x + grabbedRect.width, otherRect.x)
					);
					resizeOp && this._resizeOps.set(otherWindow, resizeOp);
				}

				this._sizeChangedId = window.connect("size-changed", this._onResizing.bind(this, window, null, grabOp));
				break;

			case Meta.GrabOp.RESIZING_W:
				for (const otherWindow of topTileGroup) {
					const otherRect = otherWindow.tiledRect;
					const resizeOp = ResizeOp.createResizeOp(
						false
						, false
						, Util.equalApprox(grabbedRect.x, otherRect.x)
						, Util.equalApprox(grabbedRect.x, otherRect.x + otherRect.width)
					);
					resizeOp && this._resizeOps.set(otherWindow, resizeOp);
				}

				this._sizeChangedId = window.connect("size-changed", this._onResizing.bind(this, window, null, grabOp));
				break;

			// resizing intercardinal directions:
			case Meta.GrabOp.RESIZING_NW:
				for (const otherWindow of topTileGroup) {
					const otherRect = otherWindow.tiledRect;
					const resizeOp = ResizeOp.createResizeOp(
						Util.equalApprox(grabbedRect.y, otherRect.y)
						, Util.equalApprox(grabbedRect.y, otherRect.y + otherRect.height)
						, Util.equalApprox(grabbedRect.x, otherRect.x)
						, Util.equalApprox(grabbedRect.x, otherRect.x + otherRect.width)
					);
					resizeOp && this._resizeOps.set(otherWindow, resizeOp);
				}

				this._sizeChangedId = window.connect("size-changed"
						, this._onResizing.bind(this, window, Meta.GrabOp.RESIZING_N, Meta.GrabOp.RESIZING_W));
				break;

			case Meta.GrabOp.RESIZING_NE:
				for (const otherWindow of topTileGroup) {
					const otherRect = otherWindow.tiledRect;
					const resizeOp = ResizeOp.createResizeOp(
						Util.equalApprox(grabbedRect.y, otherRect.y)
						, Util.equalApprox(grabbedRect.y, otherRect.y + otherRect.height)
						, Util.equalApprox(grabbedRect.x + grabbedRect.width, otherRect.x + otherRect.width)
						, Util.equalApprox(grabbedRect.x + grabbedRect.width, otherRect.x)
					);
					resizeOp && this._resizeOps.set(otherWindow, resizeOp);
				}

				this._sizeChangedId = window.connect("size-changed"
						, this._onResizing.bind(this, window, Meta.GrabOp.RESIZING_N, Meta.GrabOp.RESIZING_E));
				break;

			case Meta.GrabOp.RESIZING_SW:
				for (const otherWindow of topTileGroup) {
					const otherRect = otherWindow.tiledRect;
					const resizeOp = ResizeOp.createResizeOp(
						Util.equalApprox(grabbedRect.y + grabbedRect.height, otherRect.y + otherRect.height)
						, Util.equalApprox(grabbedRect.y + grabbedRect.height, otherRect.y)
						, Util.equalApprox(grabbedRect.x, otherRect.x)
						, Util.equalApprox(grabbedRect.x, otherRect.x + otherRect.width)
					);
					resizeOp && this._resizeOps.set(otherWindow, resizeOp);
				}

				this._sizeChangedId = window.connect("size-changed"
						, this._onResizing.bind(this, window, Meta.GrabOp.RESIZING_S, Meta.GrabOp.RESIZING_W));
				break;

			case Meta.GrabOp.RESIZING_SE:
				for (const otherWindow of topTileGroup) {
					const otherRect = otherWindow.tiledRect;
					const resizeOp = ResizeOp.createResizeOp(
						Util.equalApprox(grabbedRect.y + grabbedRect.height, otherRect.y + otherRect.height)
						, Util.equalApprox(grabbedRect.y + grabbedRect.height, otherRect.y)
						, Util.equalApprox(grabbedRect.x + grabbedRect.width, otherRect.x + otherRect.width)
						, Util.equalApprox(grabbedRect.x + grabbedRect.width, otherRect.x)
					);
					resizeOp && this._resizeOps.set(otherWindow, resizeOp);
				}

				this._sizeChangedId = window.connect("size-changed"
						, this._onResizing.bind(this, window, Meta.GrabOp.RESIZING_S, Meta.GrabOp.RESIZING_E));
		}
	}

	// update the windows' tiledRects
	_onResizeFinished(window, grabOp) {
		if (this._sizeChangedId) {
			window.disconnect(this._sizeChangedId);
			this._sizeChangedId = 0;
		}

		if (!window.isTiled)
			return;

		const gap = MainExtension.settings.get_int("window-gap");
		const workArea = window.get_work_area_for_monitor(window.get_monitor());

		// first calculate the new tiledRect for @window:
		// the new x/y coord for the @window's tiledRect can be calculated by a simple difference
		// because resizing on the E/S side wont change x/y and resizing on the N or W side will translate into a 1:1 shift
		const grabbedsNewRect = window.get_frame_rect();
		const grabbedsOldRect = this._preGrabRects.get(window);

		const isResizingW = (grabOp & Meta.GrabOp.RESIZING_W) > 1;
		const newGrabbedTiledRectX = window.tiledRect.x + (grabbedsNewRect.x - grabbedsOldRect.x)
				+ (isResizingW && window.tiledRect.x === workArea.x ? gap / 2 : 0);

		const isResizingN = (grabOp & Meta.GrabOp.RESIZING_N) > 1;
		const newGrabbedTiledRectY = window.tiledRect.y + (grabbedsNewRect.y - grabbedsOldRect.y)
				+ (isResizingN && window.tiledRect.y === workArea.y ? gap / 2 : 0);

		// if resizing on the E side, you can simply rely on get_frame_rect's new width
		// else x2 should stick to where it was (manual calc due special cases like gnome-terminal)
		const isResizingE = (grabOp & Meta.GrabOp.RESIZING_E) > 1;
		const newGrabbedTiledRectWidth = isResizingE
				? grabbedsNewRect.width + gap + (workArea.x === newGrabbedTiledRectX ? gap / 2 : 0)
				: window.tiledRect.x + window.tiledRect.width - newGrabbedTiledRectX;

		// same principal applies to the height and resizing on the S side
		const isResizingS = (grabOp & Meta.GrabOp.RESIZING_S) > 1;
		const newGrabbedTiledRectHeight = isResizingS
				? grabbedsNewRect.height + gap + (workArea.y === newGrabbedTiledRectY ? gap / 2 : 0)
				: window.tiledRect.y + window.tiledRect.height - newGrabbedTiledRectY;

		const grabbedsOldTiledRect = window.tiledRect;
		window.tiledRect = new Meta.Rectangle({
			x: newGrabbedTiledRectX,
			y: newGrabbedTiledRectY,
			width: newGrabbedTiledRectWidth,
			height: newGrabbedTiledRectHeight
		});

		// now calculate the new tiledRects for the windows, which were resized along the @window
		// based on the diff of the @window's tiledRect pre and after the grab
		const tiledRectDiffX = window.tiledRect.x - grabbedsOldTiledRect.x;
		const tiledRectDiffY = window.tiledRect.y - grabbedsOldTiledRect.y;
		const tiledRectDiffWidth = window.tiledRect.width - grabbedsOldTiledRect.width;
		const tiledRectDiffHeight = window.tiledRect.height - grabbedsOldTiledRect.height;

		this._resizeOps.forEach((resizeOp, win) => {
			if (win === window)
				return;

			if (resizeOp.side & Side.SAME_H) {
				win.tiledRect.x += tiledRectDiffX;
				win.tiledRect.width += tiledRectDiffWidth;
			} else if (resizeOp.side & Side.OPPOSING_H) {
				win.tiledRect.x += isResizingE ? tiledRectDiffWidth : 0;
				win.tiledRect.width -= tiledRectDiffWidth;
			}

			if (resizeOp.side & Side.SAME_V) {
				win.tiledRect.y += tiledRectDiffY;
				win.tiledRect.height += tiledRectDiffHeight;
			} else if (resizeOp.side & Side.OPPOSING_V) {
				win.tiledRect.y += isResizingS ? tiledRectDiffHeight : 0;
				win.tiledRect.height -= tiledRectDiffHeight;
			}
		});

		this._preGrabRects.clear();
		this._resizeOps.clear();
	}

	_onResizing(resizedWindow, grabOpV, grabOpH) {
		this._resizeOps.forEach((resizeOp, window) => {
			const rectV = this._getPassiveResizedRect(grabOpV, resizedWindow, window
					, resizeOp.side & Side.SAME_V, resizeOp.side & Side.OPPOSING_V);
			const rectH = this._getPassiveResizedRect(grabOpH, resizedWindow, window
					, resizeOp.side & Side.SAME_H, resizeOp.side & Side.OPPOSING_H);

			if (rectV && rectH)
				window.move_resize_frame(false, rectH[0], rectV[1], rectH[2], rectV[3]);
			else if (rectV)
				window.move_resize_frame(false, ...rectV);
			else if (rectH)
				window.move_resize_frame(false, ...rectH);
		});
	}

	// get the rect for the non-grabbed ("passive") window adapted to the resized grabbed window
	// *but* only adapted for 1 side (either vertically or horizontally) at a time
	_getPassiveResizedRect(grabOp, resizedWindow, window, resizeOnSameSide, resizeOnOpposingSide) {
		if (!grabOp)
			return null;

		if (!resizeOnSameSide && !resizeOnOpposingSide)
			return null;

		const resizedRect = resizedWindow.get_frame_rect();
		const wRect = window.get_frame_rect();
		const preGrabRect = this._preGrabRects.get(window);
		const gap = MainExtension.settings.get_int("window-gap");

		switch (grabOp) {
			case Meta.GrabOp.RESIZING_N:
				return resizeOnSameSide
						? [wRect.x, resizedRect.y, wRect.width, preGrabRect.y + preGrabRect.height - resizedRect.y]
						: [wRect.x, wRect.y, wRect.width, resizedRect.y - wRect.y - gap];

			case Meta.GrabOp.RESIZING_S:
				const resizedY2 = resizedRect.y + resizedRect.height;
				return resizeOnSameSide
						? [wRect.x, wRect.y, wRect.width, resizedRect.y + resizedRect.height - preGrabRect.y]
						: [wRect.x, resizedY2 + gap, wRect.width, preGrabRect.y + preGrabRect.height - resizedY2 - gap];

			case Meta.GrabOp.RESIZING_W:
				return resizeOnSameSide
						? [resizedRect.x, wRect.y, preGrabRect.x + preGrabRect.width - resizedRect.x, wRect.height]
						: [wRect.x, wRect.y, resizedRect.x - wRect.x - gap, wRect.height];

			case Meta.GrabOp.RESIZING_E:
				const resizedX2 = resizedRect.x + resizedRect.width;
				return resizeOnSameSide
						? [wRect.x, wRect.y, resizedRect.x + resizedRect.width - preGrabRect.x, wRect.height]
						: [resizedX2 + gap, wRect.y, preGrabRect.x + preGrabRect.width - resizedX2 - gap, wRect.height];
		}
	}
}

class ResizeOp {

	constructor(side) {
		this.side = side;
	}

	// a non-grabbed window may resize along with the grabbed window.
	// it can resize on the "same side", on the "opposing side" or not at all.
	// for ex.: resizing the top-left quarter on the E side means
	// the bottom-left quarter resizes on the same side (E) and the top/bottom-right quarters resize on the opposing side (W).
	// if the bottom window wasn't quartered but instead had its width equal the workArea.width, then it wouldn't resize at all.
	static createResizeOp(resizeOnSameSideV, resizeOnOpposingSideV, resizeOnSameSideH, resizeOnOpposingSideH) {
		let verticalResizeSide = Side.NONE;
		let horizontalResizeSide = Side.NONE;

		if (resizeOnSameSideV)
			verticalResizeSide = Side.SAME_V;
		else if (resizeOnOpposingSideV)
			verticalResizeSide = Side.OPPOSING_V;

		if (resizeOnSameSideH)
			horizontalResizeSide = Side.SAME_H;
		else if (resizeOnOpposingSideH)
			horizontalResizeSide = Side.OPPOSING_H;

		const resizeSide = verticalResizeSide | horizontalResizeSide;
		return resizeSide ? new ResizeOp(resizeSide) : null;
	}
}
