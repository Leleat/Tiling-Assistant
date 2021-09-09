"use strict";

const {Clutter, Meta} = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const MainExtension = Me.imports.extension;
const Util = Me.imports.tilingUtil;

/**
 * This class gets to handle the resize events of windows (wether they are tiled or not).
 * If a window isn't tiled, nothing happens though. If the resized window is tiled
 * Resize the complementing tiled windows along.
 */

var Handler = class TilingResizeHandler {

	constructor() {
		this.displaySignals = [];
		this.displaySignals.push(global.display.connect("grab-op-begin", (...params) => {
			// pre GNOME 40 the signal emitter was added as the first and second param, fixed with !1734 in mutter
			const [grabbedWindow, grabOp] = [params[params.length - 2], params[params.length - 1]];
			if (grabbedWindow && this._isResizing(grabOp))
				this._onResizeStarted(grabbedWindow, grabOp);
		}));
		this.displaySignals.push(global.display.connect("grab-op-end", (...params) => {
			// pre GNOME 40 the signal emitter was added as the first and second param, fixed with !1734 in mutter
			const [grabbedWindow, grabOp] = [params[params.length - 2], params[params.length - 1]];
			if (!grabbedWindow || !this._isResizing(grabOp))
				return;

			if (grabbedWindow.grabSignalID) {
				grabbedWindow.disconnect(grabbedWindow.grabSignalID);
				grabbedWindow.grabSignalID = 0;
			}

			this._onResizeFinished(grabbedWindow);
		}));
	}

	destroy() {
		this.displaySignals.forEach(sId => global.display.disconnect(sId));
	}

	_isResizing(grabOp) {
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
	}

	// called via global.diplay's signal (grab-op-begin)
	_onResizeStarted(window, grabOp) {
		if (!window.isTiled)
			return;

		const topTileGroup = Util.getTopTileGroup(false);
		topTileGroup.splice(topTileGroup.indexOf(window), 1);
		const grabbedRect = window.tiledRect;
		window.preGrabRect = window.get_frame_rect();

		// only resize directly opposing windows when holding ctrl.
		// only for cardial directions since it isnt useful for intercardinal resizing
		const isCtrlPressed = Util.isModPressed(Clutter.ModifierType.CONTROL_MASK);

		switch (grabOp) {
			// resizing cardinal directions
			case Meta.GrabOp.RESIZING_N:
				for (const otherWindow of topTileGroup) {
					const otherRect = otherWindow.tiledRect;
					!isCtrlPressed ? this._setupResizeDir(otherWindow, Util.equalApprox(grabbedRect.y, otherRect.y)
							, Util.equalApprox(grabbedRect.y, otherRect.y + otherRect.height), false, false)
							: this._setupResizeDir(otherWindow, false, Util.equalApprox(grabbedRect.y, otherRect.y + otherRect.height)
									&& otherRect.x >= grabbedRect.x && otherRect.x + otherRect.width <= grabbedRect.x + grabbedRect.width, false, false);
				}

				window.grabSignalID = window.connect("size-changed", this._onResizing.bind(this, window, topTileGroup, grabOp, null));
				break;

			case Meta.GrabOp.RESIZING_S:
				for (const otherWindow of topTileGroup) {
					const otherRect = otherWindow.tiledRect;
					!isCtrlPressed ? this._setupResizeDir(otherWindow, Util.equalApprox(grabbedRect.y + grabbedRect.height, otherRect.y + otherRect.height)
							, Util.equalApprox(grabbedRect.y + grabbedRect.height, otherRect.y), false, false)
							: this._setupResizeDir(otherWindow, false, Util.equalApprox(grabbedRect.y + grabbedRect.height, otherRect.y)
									&& otherRect.x >= grabbedRect.x && otherRect.x + otherRect.width <= grabbedRect.x + grabbedRect.width, false, false);
				}

				window.grabSignalID = window.connect("size-changed", this._onResizing.bind(this, window, topTileGroup, grabOp, null));
				break;

			case Meta.GrabOp.RESIZING_E:
				for (const otherWindow of topTileGroup) {
					const otherRect = otherWindow.tiledRect;
					!isCtrlPressed ? this._setupResizeDir(otherWindow, false, false, Util.equalApprox(grabbedRect.x + grabbedRect.width, otherRect.x + otherRect.width)
							, Util.equalApprox(grabbedRect.x + grabbedRect.width, otherRect.x))
							: this._setupResizeDir(otherWindow, false, false, false, Util.equalApprox(grabbedRect.x + grabbedRect.width, otherRect.x)
									&& otherRect.y >= grabbedRect.y && otherRect.y + otherRect.height <= grabbedRect.y + grabbedRect.height);
				}

				window.grabSignalID = window.connect("size-changed", this._onResizing.bind(this, window, topTileGroup, null, grabOp));
				break;

			case Meta.GrabOp.RESIZING_W:
				for (const otherWindow of topTileGroup) {
					const otherRect = otherWindow.tiledRect;
					!isCtrlPressed ? this._setupResizeDir(otherWindow, false, false, Util.equalApprox(grabbedRect.x, otherRect.x)
							, Util.equalApprox(grabbedRect.x, otherRect.x + otherRect.width))
							: this._setupResizeDir(otherWindow, false, false, false, Util.equalApprox(grabbedRect.x, otherRect.x + otherRect.width)
									&& otherRect.y >= grabbedRect.y && otherRect.y + otherRect.height <= grabbedRect.y + grabbedRect.height);
				}

				window.grabSignalID = window.connect("size-changed", this._onResizing.bind(this, window, topTileGroup, null, grabOp));
				break;

			// resizing intercardinal directions
			case Meta.GrabOp.RESIZING_NW:
				for (const otherWindow of topTileGroup) {
					const otherRect = otherWindow.tiledRect;
					this._setupResizeDir(otherWindow, Util.equalApprox(grabbedRect.y, otherRect.y), Util.equalApprox(grabbedRect.y, otherRect.y + otherRect.height)
							, Util.equalApprox(grabbedRect.x, otherRect.x), Util.equalApprox(grabbedRect.x, otherRect.x + otherRect.width));
				}

				window.grabSignalID = window.connect("size-changed", this._onResizing.bind(this
						, window, topTileGroup, Meta.GrabOp.RESIZING_N, Meta.GrabOp.RESIZING_W));
				break;

			case Meta.GrabOp.RESIZING_NE:
				for (const otherWindow of topTileGroup) {
					const otherRect = otherWindow.tiledRect;
					this._setupResizeDir(otherWindow, Util.equalApprox(grabbedRect.y, otherRect.y), Util.equalApprox(grabbedRect.y, otherRect.y + otherRect.height)
							, Util.equalApprox(grabbedRect.x + grabbedRect.width, otherRect.x + otherRect.width)
							, Util.equalApprox(grabbedRect.x + grabbedRect.width, otherRect.x));
				}

				window.grabSignalID = window.connect("size-changed", this._onResizing.bind(this
						, window, topTileGroup, Meta.GrabOp.RESIZING_N, Meta.GrabOp.RESIZING_E));
				break;

			case Meta.GrabOp.RESIZING_SW:
				for (const otherWindow of topTileGroup) {
					const otherRect = otherWindow.tiledRect;
					this._setupResizeDir(otherWindow, Util.equalApprox(grabbedRect.y + grabbedRect.height, otherRect.y + otherRect.height)
						, Util.equalApprox(grabbedRect.y + grabbedRect.height, otherRect.y), Util.equalApprox(grabbedRect.x, otherRect.x)
						, Util.equalApprox(grabbedRect.x, otherRect.x + otherRect.width));
				}

				window.grabSignalID = window.connect("size-changed", this._onResizing.bind(this
						, window, topTileGroup, Meta.GrabOp.RESIZING_S, Meta.GrabOp.RESIZING_W));
				break;

			case Meta.GrabOp.RESIZING_SE:
				for (const otherWindow of topTileGroup) {
					const otherRect = otherWindow.tiledRect;
					this._setupResizeDir(otherWindow, Util.equalApprox(grabbedRect.y + grabbedRect.height, otherRect.y + otherRect.height)
							, Util.equalApprox(grabbedRect.y + grabbedRect.height, otherRect.y)
							, Util.equalApprox(grabbedRect.x + grabbedRect.width, otherRect.x + otherRect.width)
							, Util.equalApprox(grabbedRect.x + grabbedRect.width, otherRect.x));
				}

				window.grabSignalID = window.connect("size-changed", this._onResizing.bind(this
						, window, topTileGroup, Meta.GrabOp.RESIZING_S, Meta.GrabOp.RESIZING_E));
		}
	}

	// called via global.diplay's signal (grab-op-end):
	// update the windows' tiledRects, if resizing a tiled window
	_onResizeFinished(window, grabOp) {
		if (!window.isTiled)
			return;

		const gap = MainExtension.settings.get_int("window-gap");
		const workArea = window.get_work_area_for_monitor(window.get_monitor());

		// first calculate the new tiledRect for @window:
		// the new x/y coord for the @window's tiledRect can be calculated by a simple difference
		// because resizing on the E or S side wont change x/y and resizing on the N or W side will translate into a 1:1 shift
		const grabbedsNewRect = window.get_frame_rect();

		const isResizingW = grabOp === Meta.GrabOp.RESIZING_W || grabOp === Meta.GrabOp.RESIZING_NW || grabOp === Meta.GrabOp.RESIZING_SW;
		const newGrabbedTiledRectX = window.tiledRect.x + (grabbedsNewRect.x - window.preGrabRect.x) + (isResizingW && window.tiledRect.x === workArea.x ? gap / 2 : 0);

		const isResizingN = grabOp === Meta.GrabOp.RESIZING_N || grabOp === Meta.GrabOp.RESIZING_NW || grabOp === Meta.GrabOp.RESIZING_NE;
		const newGrabbedTiledRectY = window.tiledRect.y + (grabbedsNewRect.y - window.preGrabRect.y) + (isResizingN && window.tiledRect.y === workArea.y ? gap / 2 : 0);

		// if resizing on the E side, you can simply rely on get_frame_rect's new width
		// else x2 should stick to where it was (manual calc due special cases like gnome-terminal)
		const isResizingE = grabOp === Meta.GrabOp.RESIZING_E || grabOp === Meta.GrabOp.RESIZING_NE || grabOp === Meta.GrabOp.RESIZING_SE;
		const newGrabbedTiledRectWidth = isResizingE ? grabbedsNewRect.width + gap + (workArea.x === newGrabbedTiledRectX ? gap / 2 : 0)
				: window.tiledRect.x + window.tiledRect.width - newGrabbedTiledRectX;

		// same principal applies to the height and resizing on the S side
		const isResizingS = grabOp === Meta.GrabOp.RESIZING_S || grabOp === Meta.GrabOp.RESIZING_SW || grabOp === Meta.GrabOp.RESIZING_SE;
		const newGrabbedTiledRectHeight = isResizingS ? grabbedsNewRect.height + gap + (workArea.y === newGrabbedTiledRectY ? gap / 2 : 0)
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

		const tileGroup = MainExtension.tileGroupManager.getTileGroupFor(window);
		for (const w of tileGroup) {
			if (w === window)
				continue;

			if (w.resizeSameSideH) {
				w.tiledRect.x += tiledRectDiffX;
				w.tiledRect.width += tiledRectDiffWidth;
			} else if (w.resizeSameSideH === false) {
				w.tiledRect.x += isResizingE ? tiledRectDiffWidth : 0;
				w.tiledRect.width -= tiledRectDiffWidth;
			}

			if (w.resizeSameSideV) {
				w.tiledRect.y += tiledRectDiffY;
				w.tiledRect.height += tiledRectDiffHeight;
			} else if (w.resizeSameSideV === false) {
				w.tiledRect.y += isResizingS ? tiledRectDiffHeight : 0;
				w.tiledRect.height -= tiledRectDiffHeight;
			}

			w.resizeSameSideV = null;
			w.resizeSameSideH = null;
		}
	}

	// called via @window's signal (size-changed):
	// @resizedWindow was removed from @tileGroup
	_onResizing(resizedWindow, tileGroup, grabOpV, grabOpH) {
		const resizedRect = resizedWindow.get_frame_rect();
		tileGroup.forEach(w => {
			const rectV = this._getResizeDimensions(grabOpV, resizedRect, w, w.resizeSameSideV);
			const rectH = this._getResizeDimensions(grabOpH, resizedRect, w, w.resizeSameSideH);
			if (rectV && rectH)
				w.move_resize_frame(false, rectH[0], rectV[1], rectH[2], rectV[3]);
			else if (rectV)
				w.move_resize_frame(false, ...rectV);
			else if (rectH)
				w.move_resize_frame(false, ...rectH);
		});
	}

	_setupResizeDir(otherWindow, resizeSameSideV, resizeOpposingSideV, resizeSameSideH, resizeOpposingSideH) {
		otherWindow.preGrabRect = otherWindow.get_frame_rect();
		// non-grabbed windows resize along with the grabbed window.
		// they can resize on the "same side", on the "opposing side" or not at all (here: null).
		// for ex.: resizing the top-left quarter on the E side means
		// the bottom-left quarter resizes on the same side (E); the top/bottom-right quarters resize on the opposing side (W).
		// If the bottom window wasn't quartered but instead had its width == workArea.width, then it wouldn't resize at all.
		// split the grabOp into its [H]orizontal and [V]ertical parts for resizing at the window corners/diagonals
		otherWindow.resizeSameSideH = null;
		otherWindow.resizeSameSideV = null;

		if (resizeSameSideV)
			otherWindow.resizeSameSideV = true;
		else if (resizeOpposingSideV)
			otherWindow.resizeSameSideV = false;

		if (resizeSameSideH)
			otherWindow.resizeSameSideH = true;
		else if (resizeOpposingSideH)
			otherWindow.resizeSameSideH = false;
	}

	_getResizeDimensions(grabOp, resizedRect, window, resizeSameSide) {
		if (grabOp === null || resizeSameSide === null)
			return null;

		const gap = MainExtension.settings.get_int("window-gap");
		const wRect = window.get_frame_rect();
		switch (grabOp) {
			case Meta.GrabOp.RESIZING_N:
				return resizeSameSide
						? [wRect.x, resizedRect.y, wRect.width, window.preGrabRect.y + window.preGrabRect.height - resizedRect.y]
						: [wRect.x, wRect.y, wRect.width, resizedRect.y - wRect.y - gap];

			case Meta.GrabOp.RESIZING_S:
				const resizedY2 = resizedRect.y + resizedRect.height;
				return resizeSameSide
						? [wRect.x, wRect.y, wRect.width, resizedRect.y + resizedRect.height - window.preGrabRect.y]
						: [wRect.x, resizedY2 + gap, wRect.width, window.preGrabRect.y + window.preGrabRect.height - resizedY2 - gap];

			case Meta.GrabOp.RESIZING_W:
				return resizeSameSide
						? [resizedRect.x, wRect.y, window.preGrabRect.x + window.preGrabRect.width - resizedRect.x, wRect.height]
						: [wRect.x, wRect.y, resizedRect.x - wRect.x - gap, wRect.height];

			case Meta.GrabOp.RESIZING_E:
				const resizedX2 = resizedRect.x + resizedRect.width;
				return resizeSameSide
						? [wRect.x, wRect.y, resizedRect.x + resizedRect.width - window.preGrabRect.x, wRect.height]
						: [resizedX2 + gap, wRect.y, window.preGrabRect.x + window.preGrabRect.width - resizedX2 - gap, wRect.height];
		}
	}
}