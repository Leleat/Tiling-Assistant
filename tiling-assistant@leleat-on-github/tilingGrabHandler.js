"use strict";

const {windowManager} = imports.ui;
const {Clutter, GLib, Meta} = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const MainExtension = Me.imports.extension;
const Util = Me.imports.tilingUtil;

// class to handle the grab of a window

var WindowGrabHandler = class TilingWindowGrabHandler {
	constructor() {
		this.tilePreview = new windowManager.TilePreview();
	}

	destroy() {
		this.tilePreview.destroy();
	}

	// called via global.diplay's signal (grab-op-begin)
	onMoveStarted(window, grabOp) {
		this.monitorNr = global.display.get_current_monitor();
		this.lastMonitorNr = this.monitorNr;

		const topTileGroup = Util.getTopTileGroup();
		window.grabSignalID = window.connect("position-changed", this.onMoving.bind(this, grabOp, window
				, window.get_maximized(), topTileGroup, Util.getFreeScreenRects(topTileGroup)));
	}

	// called via global.diplay's signal (grab-op-end)
	onMoveFinished(window) {
		if (!this.tilePreview._showing)
			return;

		const previewRect = this.tilePreview._rect;
		// the hovered tiled window when holding Ctrl while moving a window
		if (Util.isModPressed(Clutter.ModifierType.CONTROL_MASK) && this.hoveredWindow)
			Util.tileWindow(this.hoveredWindow, Util.rectDiff(this.hoveredWindow.tiledRect, previewRect)[0], false);
		this.hoveredWindow = null;

		Util.tileWindow(window, previewRect);
		this.tilePreview.close();
	}

	// called via @window's signal (position-changed)
	onMoving(grabOp, window, windowWasMaximized, topTileGroup, freeScreenRects) {
		// use the current event's coords instead of global.get_pointer to support touch.
		// event === null when dnding a maximized window...?
		const event = Clutter.get_current_event();
		if (!event)
			return;

		const [eventX, eventY] = event.get_coords();

		// restore @window's size, if it's tiled. Try for @windowWasMaximized as well
		// since @window may have been tiled before it was maximized
		if (window.isTiled || windowWasMaximized) {
			const [, , mods] = global.get_pointer();
			global.display.end_grab_op(global.get_current_time());
			// timer needed because for some apps the grab will overwrite the size changes of restoreWindowSize
			// so far I only noticed this behaviour with firefox
			GLib.timeout_add(GLib.PRIORITY_HIGH_IDLE + 10, 1, () => {
				Util.restoreWindowSize(window, false, eventX, windowWasMaximized);
				global.display.begin_grab_op(
					window,
					grabOp,
					true, // pointer already grabbed
					true, // frame action
					-1, // button
					mods, // modifier
					global.get_current_time(),
					// Math.max so the pointer isn't above the window in some cases
					eventX, Math.max(eventY, window.get_frame_rect().y)
				);

				return GLib.SOURCE_REMOVE;
			});

			return;
		}

		// tile preview
		Util.isModPressed(Clutter.ModifierType.CONTROL_MASK)
				? this._alternatePreviewTile(window, topTileGroup, freeScreenRects, eventX, eventY)
				: this._previewTile(window, eventX, eventY);
	}

	_previewTile(window, eventX, eventY) {
        // when switching monitors, provide a short grace period
        // in which the tile preview will stick to the old monitor so that
        // the user doesn't have to slowly move/inch the mouse to the monitor edge
        // just because there is a second monitor in that direction
		const currMonitorNr = global.display.get_current_monitor();
		if (this.lastMonitorNr !== currMonitorNr) {
			this.monitorNr = this.lastMonitorNr;
			let timerId = 0;
			this.latestMonitorLockTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
				// only update the monitorNr, if the latest timer timed out
				if (timerId === this.latestMonitorLockTimerId)
					this.monitorNr = global.display.get_current_monitor();
				return GLib.SOURCE_REMOVE;
			});
			timerId = this.latestMonitorLockTimerId;
		}
		this.lastMonitorNr = currMonitorNr;

		const wRect = window.get_frame_rect();
		const workArea = window.get_work_area_for_monitor(this.monitorNr);

		const vDetectionSize = MainExtension.settings.get_int("vertical-preview-area");
		const pointerAtTopEdge = eventY <= workArea.y + vDetectionSize;
		const pointerAtBottomEdge = eventY >= workArea.y + workArea.height - vDetectionSize;
		const hDetectionSize = MainExtension.settings.get_int("horizontal-preview-area");
		const pointerAtLeftEdge = eventX <= workArea.x + hDetectionSize;
		const pointerAtRightEdge = eventX >= workArea.x + workArea.width - hDetectionSize;
		// also use window's pos for top and bottom area detection for quarters
		// because global.get_pointer's y isn't accurate (no idea why...)
		// when slowly going from the left/right sides to the top/bottom corners
		const windowAtTopEdge = wRect.y === workArea.y;
		const windowAtBottomEdge = wRect.y >= workArea.y + workArea.height - 75;
		const tileTopLeftQuarter = pointerAtLeftEdge && (pointerAtTopEdge || windowAtTopEdge);
		const tileTopRightQuarter = pointerAtRightEdge && (pointerAtTopEdge || windowAtTopEdge);
		const tileBottomLeftQuarter = pointerAtLeftEdge && (pointerAtBottomEdge || windowAtBottomEdge);
		const tileBottomRightQuarter = pointerAtRightEdge && (pointerAtBottomEdge || windowAtBottomEdge);

		if (tileTopLeftQuarter) {
			this.tilePreview.open(window, Util.getTileRectFor(MainExtension.TILING.TOP_LEFT, workArea), this.monitorNr);

		} else if (tileTopRightQuarter) {
			this.tilePreview.open(window, Util.getTileRectFor(MainExtension.TILING.TOP_RIGHT, workArea), this.monitorNr);

		} else if (tileBottomLeftQuarter) {
			this.tilePreview.open(window, Util.getTileRectFor(MainExtension.TILING.BOTTOM_LEFT, workArea), this.monitorNr);

		} else if (tileBottomRightQuarter) {
			this.tilePreview.open(window, Util.getTileRectFor(MainExtension.TILING.BOTTOM_RIGHT, workArea), this.monitorNr);

		} else if (pointerAtTopEdge) {
			const monitorRect = global.display.get_monitor_geometry(this.monitorNr);
			const isLandscape = monitorRect.width >= monitorRect.height;
			const shouldMaximize = (isLandscape && !MainExtension.settings.get_boolean("enable-hold-maximize-inverse-landscape"))
					|| (!isLandscape && !MainExtension.settings.get_boolean("enable-hold-maximize-inverse-portrait"));
			const tileRect = shouldMaximize ? workArea : Util.getTileRectFor(MainExtension.TILING.TOP, workArea);
			const holdTileRect = shouldMaximize ? Util.getTileRectFor(MainExtension.TILING.TOP, workArea) : workArea;
			// dont open preview / start new timer if preview was already one for the top
			if (this.tilePreview._rect && (holdTileRect.equal(this.tilePreview._rect) || this.tilePreview._rect.equal(tileRect)))
				return;

			this.tilePreview.open(window, tileRect, this.monitorNr);

			let timerId = 0;
			this.latestPreviewTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MainExtension.settings.get_int("toggle-maximize-tophalf-timer"), () => {
				// only open the hold/alternative preview, if the timeouted timer is the same as the one which started last
				if (timerId === this.latestPreviewTimerId && this.tilePreview._showing && this.tilePreview._rect.equal(tileRect))
					this.tilePreview.open(window, holdTileRect, this.monitorNr);

				return GLib.SOURCE_REMOVE;
			});
			timerId = this.latestPreviewTimerId;

		} else if (pointerAtBottomEdge) {
			this.tilePreview.open(window, Util.getTileRectFor(MainExtension.TILING.BOTTOM, workArea), this.monitorNr);

		} else if (pointerAtLeftEdge) {
			this.tilePreview.open(window, Util.getTileRectFor(MainExtension.TILING.LEFT, workArea), this.monitorNr);

		} else if (pointerAtRightEdge) {
			this.tilePreview.open(window, Util.getTileRectFor(MainExtension.TILING.RIGHT, workArea), this.monitorNr);

		} else {
			this.tilePreview.close();
		}
	}

	_alternatePreviewTile(window, topTileGroup, freeScreenRects, eventX, eventY) {
		const pointerLocation = {x: eventX, y: eventY};
		const hoveredWindow = topTileGroup.find(w => Util.rectHasPoint(w.get_frame_rect(), pointerLocation));
		const hoveredFreeRect = !hoveredWindow && freeScreenRects.find(r => Util.rectHasPoint(r, pointerLocation));

		const getSplitRect = function(rect) {
			const pointerAtTop = eventY < rect.y + rect.height * .2;
			const pointerAtBottom = eventY > rect.y + rect.height * .8;
			const pointerAtRight = eventX > rect.x + rect.width * .8;
			const pointerAtLeft = eventX < rect.x + rect.width * .2;
			const splitVertically = pointerAtTop || pointerAtBottom;
			const splitHorizontally = pointerAtLeft || pointerAtRight;

			return new Meta.Rectangle({
				x: rect.x + (pointerAtRight && !splitVertically ? rect.width / 2 : 0),
				y: rect.y + (pointerAtBottom ? rect.height / 2 : 0),
				width: rect.width / (splitHorizontally && !splitVertically ? 2 : 1),
				height: rect.height / (splitVertically ? 2 : 1)
			});
		};

		this.hoveredWindow = null;

		if (hoveredWindow) {
			const tileRect = getSplitRect(hoveredWindow.tiledRect);
			this.tilePreview.open(window, tileRect, global.display.get_current_monitor());
			this.hoveredWindow = hoveredWindow;

		} else if (hoveredFreeRect) {
			const tileRect = getSplitRect(hoveredFreeRect);
			this.tilePreview.open(window, tileRect, global.display.get_current_monitor());

		} else {
			this.tilePreview.close();
		}
	}

	// called via global.diplay's signal (grab-op-begin)
	onResizeStarted(window, grabOp) {
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
					!isCtrlPressed ? this._setupResizeDir(otherWindow, grabbedRect.y === otherRect.y, grabbedRect.y === otherRect.y + otherRect.height, false, false)
							: this._setupResizeDir(otherWindow, false, grabbedRect.y === otherRect.y + otherRect.height
									&& grabbedRect.x === otherRect.x && grabbedRect.width === otherRect.width, false, false);
				}

				window.grabSignalID = window.connect("size-changed", this.onResizing.bind(this, window, topTileGroup, grabOp, null));
				break;

			case Meta.GrabOp.RESIZING_S:
				for (const otherWindow of topTileGroup) {
					const otherRect = otherWindow.tiledRect;
					!isCtrlPressed ? this._setupResizeDir(otherWindow, grabbedRect.y + grabbedRect.height === otherRect.y + otherRect.height
							, grabbedRect.y + grabbedRect.height === otherRect.y, false, false)
							: this._setupResizeDir(otherWindow, false, grabbedRect.y + grabbedRect.height === otherRect.y
									&& grabbedRect.x === otherRect.x && grabbedRect.width === otherRect.width, false, false);
				}

				window.grabSignalID = window.connect("size-changed", this.onResizing.bind(this, window, topTileGroup, grabOp, null));
				break;

			case Meta.GrabOp.RESIZING_E:
				for (const otherWindow of topTileGroup) {
					const otherRect = otherWindow.tiledRect;
					!isCtrlPressed ? this._setupResizeDir(otherWindow, false, false, grabbedRect.x + grabbedRect.width === otherRect.x + otherRect.width
							, grabbedRect.x + grabbedRect.width === otherRect.x)
							: this._setupResizeDir(otherWindow, false, false, false, grabbedRect.x + grabbedRect.width === otherRect.x
									&& grabbedRect.y === otherRect.y && grabbedRect.height === otherRect.height);
				}

				window.grabSignalID = window.connect("size-changed", this.onResizing.bind(this, window, topTileGroup, null, grabOp));
				break;

			case Meta.GrabOp.RESIZING_W:
				for (const otherWindow of topTileGroup) {
					const otherRect = otherWindow.tiledRect;
					!isCtrlPressed ? this._setupResizeDir(otherWindow, false, false, grabbedRect.x === otherRect.x
							, grabbedRect.x === otherRect.x + otherRect.width)
							: this._setupResizeDir(otherWindow, false, false, false, grabbedRect.x === otherRect.x + otherRect.width
									&& grabbedRect.y === otherRect.y && grabbedRect.height === otherRect.height);
				}

				window.grabSignalID = window.connect("size-changed", this.onResizing.bind(this, window, topTileGroup, null, grabOp));
				break;

			// resizing intercardinal directions
			case Meta.GrabOp.RESIZING_NW:
				for (const otherWindow of topTileGroup) {
					const otherRect = otherWindow.tiledRect;
					this._setupResizeDir(otherWindow, grabbedRect.y === otherRect.y, grabbedRect.y === otherRect.y + otherRect.height
							, grabbedRect.x === otherRect.x, grabbedRect.x === otherRect.x + otherRect.width);
				}

				window.grabSignalID = window.connect("size-changed", this.onResizing.bind(this
						, window, topTileGroup, Meta.GrabOp.RESIZING_N, Meta.GrabOp.RESIZING_W));
				break;

			case Meta.GrabOp.RESIZING_NE:
				for (const otherWindow of topTileGroup) {
					const otherRect = otherWindow.tiledRect;
					this._setupResizeDir(otherWindow, grabbedRect.y === otherRect.y, grabbedRect.y === otherRect.y + otherRect.height
							, grabbedRect.x + grabbedRect.width === otherRect.x + otherRect.width
							, grabbedRect.x + grabbedRect.width === otherRect.x);
				}

				window.grabSignalID = window.connect("size-changed", this.onResizing.bind(this
						, window, topTileGroup, Meta.GrabOp.RESIZING_N, Meta.GrabOp.RESIZING_E));
				break;

			case Meta.GrabOp.RESIZING_SW:
				for (const otherWindow of topTileGroup) {
					const otherRect = otherWindow.tiledRect;
					this._setupResizeDir(otherWindow, grabbedRect.y + grabbedRect.height === otherRect.y + otherRect.height
						, grabbedRect.y + grabbedRect.height === otherRect.y, grabbedRect.x === otherRect.x
						, grabbedRect.x === otherRect.x + otherRect.width);
				}

				window.grabSignalID = window.connect("size-changed", this.onResizing.bind(this
						, window, topTileGroup, Meta.GrabOp.RESIZING_S, Meta.GrabOp.RESIZING_W));
				break;

			case Meta.GrabOp.RESIZING_SE:
				for (const otherWindow of topTileGroup) {
					const otherRect = otherWindow.tiledRect;
					this._setupResizeDir(otherWindow, grabbedRect.y + grabbedRect.height === otherRect.y + otherRect.height
							, grabbedRect.y + grabbedRect.height === otherRect.y
							, grabbedRect.x + grabbedRect.width === otherRect.x + otherRect.width
							, grabbedRect.x + grabbedRect.width === otherRect.x);
				}

				window.grabSignalID = window.connect("size-changed", this.onResizing.bind(this
						, window, topTileGroup, Meta.GrabOp.RESIZING_S, Meta.GrabOp.RESIZING_E));
		}
	}

	// called via global.diplay's signal (grab-op-end):
	// update the windows' tiledRects, if resizing a tiled window
	onResizeFinished(window, grabOp) {
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

		for (const w of window.tileGroup) {
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
	onResizing(resizedWindow, tileGroup, grabOpV, grabOpH) {
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