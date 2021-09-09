"use strict";

const {windowManager} = imports.ui;
const {Clutter, GLib, Meta} = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const MainExtension = Me.imports.extension;
const Util = Me.imports.tilingUtil;
const GNOME_VERSION = parseFloat(imports.misc.config.PACKAGE_VERSION);

const PREVIEW_STATE = {
	DEFAULT: 1, // default screen edge/quarter tiling
	SINGLE: 2, // secondary preview mode while hovering any screen rect
	GROUP: 4 // secondary preview mode while hovering any screen rect at the very edges
};

/**
 * This class gets to handle the move events of windows.
 * If the moved window is tiled during the grab start, untile it.
 */

var Handler = class TilingMoveHandler {
	constructor() {
		this.displaySignals = [];
		this.displaySignals.push(global.display.connect("grab-op-begin", (...params) => {
			// pre GNOME 40 the signal emitter was added as the first and second param, fixed with !1734 in mutter
			const [grabbedWindow, grabOp] = [params[params.length - 2], params[params.length - 1]];
			if (grabbedWindow && this._isMoving(grabOp))
				this._onMoveStarted(grabbedWindow, grabOp);
		}));
		this.displaySignals.push(global.display.connect("grab-op-end", (...params) => {
			// pre GNOME 40 the signal emitter was added as the first and second param, fixed with !1734 in mutter
			const [grabbedWindow, grabOp] = [params[params.length - 2], params[params.length - 1]];
			if (!grabbedWindow || !this._isMoving(grabOp))
				return;

			if (grabbedWindow.grabSignalID) {
				grabbedWindow.disconnect(grabbedWindow.grabSignalID);
				grabbedWindow.grabSignalID = 0;
			}

			this._onMoveFinished(grabbedWindow);
		}));

		this.tilePreview = new windowManager.TilePreview();
		this.tilePreview.state = PREVIEW_STATE.DEFAULT;

		this.tilePreview.open = GNOME_VERSION < 3.36 ? this.tilePreview.show : this.tilePreview.open;
		this.tilePreview.close = GNOME_VERSION < 3.36 ? this.tilePreview.hide : this.tilePreview.close;

		// only use normal tile-preview style class and don't round corners
		// because native rounding code doesnt fit my possible previews
		const styleClasser = GNOME_VERSION < 3.36 ? this.tilePreview.actor : this.tilePreview;
		styleClasser.style_class = "tile-preview";
		this.tilePreview._updateStyle = () => {};
	}

	destroy() {
		this.displaySignals.forEach(sId => global.display.disconnect(sId));
		const actor = GNOME_VERSION < 3.36 ? this.tilePreview.actor : this.tilePreview;
		actor.destroy();
		this.tilePreview = null;
	}

	_isMoving(grabOp) {
		switch (grabOp) {
			case Meta.GrabOp.MOVING:
			case Meta.GrabOp.KEYBOARD_MOVING:
				return true;

			default:
				return false;
		}
	}

	// called via global.diplay's signal (grab-op-begin)
	_onMoveStarted(window, grabOp) {
		this.monitorNr = global.display.get_current_monitor();
		this.lastMonitorNr = this.monitorNr;

		if (!this.isArtificalGrab) {
			this._restoreOnGrabStart = MainExtension.settings.get_string("restore-window-size-on") === "Grab Start";
			this._windowWasMaximized = window.get_maximized();
			this._grabOp = grabOp;
			this._moveStarted = false;
		}

		const topTileGroup = Util.getTopTileGroup();
		window.grabSignalID = window.connect("position-changed", this._onMoving.bind(this, grabOp, window
				, topTileGroup, Util.getFreeScreenRects(topTileGroup)));
	}

	// called via global.diplay's signal (grab-op-end)
	_onMoveFinished(window) {
		if (!this._moveStarted)
			return;

		if (!this.tilePreview._showing) {
			// restore window size & restart the grab after having artificially ended it,
			// so the mouse is at the correct position
			if (window.tiledRect || this._windowWasMaximized) {
				// timer needed because for some apps the grab will overwrite the size changes of restoreWindowSize
				// so far I only noticed this behaviour with firefox
				GLib.timeout_add(GLib.PRIORITY_HIGH_IDLE + 10, 1, () => {
					if (this._restoreOnGrabStart) {
						Util.restoreWindowSize(window, false, this._grabStartX, this._windowWasMaximized);

					} else {
						if (this.isArtificalGrab) { // var used to restore window size on grab end
							!this._windowWasMaximized && Util.restoreWindowSize(window, false, this._lastCoord.x);
							this.isArtificalGrab = false;
							return;
						}
						this.isArtificalGrab = true;
					}

					const [, , mods] = global.get_pointer();
					global.display.begin_grab_op(
						window,
						this._grabOp,
						true, // pointer already grabbed
						true, // frame action
						-1, // button
						mods, // modifier
						global.get_current_time(),
						// Math.max so the pointer isn't above the window in some cases
						this._grabStartX, Math.max(this._grabStartY, window.get_frame_rect().y)
					);

					return GLib.SOURCE_REMOVE;
				});
			}

			return;
		}

		const previewRect = this.tilePreview._rect;

		switch (this.tilePreview.state) {
			case PREVIEW_STATE.GROUP:
				const topTileGroup = Util.getTopTileGroup();
				if (!topTileGroup.length)
					return;

				const isVertical = this.tilePreview._rect.width > this.tilePreview._rect.height;
				const [posProp, dimensionProp] = isVertical ? ["y", "height"] : ["x", "width"];
				// "before preview" means only the width/height of the window will change
				// i. e. window is bordering on the left/top of the tile preview
				const isBeforePreview = window => {
					const p2 = window.tiledRect[posProp] + window.tiledRect[dimensionProp];
					return window.tiledRect.overlap(previewRect) && p2 >= previewRect[posProp] && p2 <= previewRect[posProp] + previewRect[dimensionProp];
				};
				// "after preview" is the opposite (bottom/right of the tile preview)
				const isAfterPreview = window => {
					return window.tiledRect.overlap(previewRect) && window.tiledRect[posProp] >= previewRect[posProp] && window.tiledRect[posProp] <= previewRect[posProp] + previewRect[dimensionProp];
				};

				const windowsBeforePreview = [];
				const windowsAfterPreview = [];
				const smallestWindow = topTileGroup.reduce((smallest, w) => {
					const isBefore = isBeforePreview(w);
					const isAfter = isAfterPreview(w);
					isBefore && windowsBeforePreview.push(w);
					isAfter && windowsAfterPreview.push(w);
					return (isBefore || isAfter) && smallest && smallest[dimensionProp] < w[dimensionProp] ? smallest : w;
				}, null);
				const resizeAmount = Math.floor(smallestWindow.tiledRect[dimensionProp]
							/ (windowsBeforePreview.length && windowsAfterPreview.length ? 3 : 2));

				windowsBeforePreview.forEach(w => {
					Util.tileWindow(w, new Meta.Rectangle({
						x: w.tiledRect.x,
						y: w.tiledRect.y,
						width: isVertical ? w.tiledRect.width : w.tiledRect.width - resizeAmount,
						height: isVertical ? w.tiledRect.height - resizeAmount : w.tiledRect.height,
					}), false);
				});
				windowsAfterPreview.forEach(w => {
					Util.tileWindow(w, new Meta.Rectangle({
						x: isVertical ? w.tiledRect.x : w.tiledRect.x + resizeAmount,
						y: isVertical ? w.tiledRect.y + resizeAmount : w.tiledRect.y,
						width: isVertical ? w.tiledRect.width : w.tiledRect.width - resizeAmount,
						height: isVertical ? w.tiledRect.height - resizeAmount : w.tiledRect.height,
					}), false);
				});

				const workArea = window.get_work_area_for_monitor(window.get_monitor());
				const beforeWindow = windowsBeforePreview[0];
				const afterWindow = windowsAfterPreview[0];
				Util.tileWindow(window, new Meta.Rectangle({
					x: isVertical ? previewRect.x : (beforeWindow ? beforeWindow.tiledRect.x + beforeWindow.tiledRect.width : workArea.x),
					y: isVertical ? (beforeWindow ? beforeWindow.tiledRect.y + beforeWindow.tiledRect.height : workArea.y) : previewRect.y,
					width: isVertical ? previewRect.width : resizeAmount * (beforeWindow && afterWindow ? 2 : 1),
					height: isVertical ? resizeAmount * (beforeWindow && afterWindow ? 2 : 1) : previewRect.height
				}));
				break;

			case PREVIEW_STATE.SINGLE:
				if (this._secondaryHoveredWindow && !previewRect.equal(this._secondaryHoveredWindow.tiledRect)) {
					const splitRect = Util.rectDiff(this._secondaryHoveredWindow.tiledRect, previewRect)[0];
					Util.tileWindow(this._secondaryHoveredWindow, splitRect, false);
				}

			case PREVIEW_STATE.DEFAULT:
				Util.tileWindow(window, previewRect);
		}

		// reset everything that may have been set
		this._secondaryHoveredWindow = null;
		this._secondaryHoveredRect = null;

		this.tilePreview.close();
	}

	// called via @window's signal (position-changed)
	_onMoving(grabOp, window, topTileGroup, freeScreenRects) {
		this._moveStarted = true;
		// use the current event's coords instead of global.get_pointer to support touch.
		// event === null when dnding a maximized window...?
		const event = Clutter.get_current_event();
		if (!event)
			return;

		const [eventX, eventY] = grabOp === Meta.GrabOp.KEYBOARD_MOVING ? global.get_pointer() : event.get_coords();
		this._lastCoord = {x: eventX, y: eventY};

		// restore @window's size, if it's tiled. Try for @windowWasMaximized as well
		// since @window may have been tiled before it was maximized. .onMoveFinished restarts the grab
		// so the mouse is at the correct position, if the grab started in the panel
		if ((window.tiledRect || this._windowWasMaximized) && !this.isArtificalGrab) {
			this._grabStartX = eventX;
			this._grabStartY = eventY;
			global.display.end_grab_op(global.get_current_time());
			return;
		}

		// tile preview
		const defaultToSecondaryMode = MainExtension.settings.get_boolean("default-to-secondary-tiling-preview");
		let secondaryModeActivatorPressed = false;
		switch (MainExtension.settings.get_string("secondary-tiling-preview-activator")) {
			case "Ctrl":
				secondaryModeActivatorPressed = Util.isModPressed(Clutter.ModifierType.CONTROL_MASK);
				break;
			case "Alt":
				secondaryModeActivatorPressed = Util.isModPressed(Clutter.ModifierType.MOD1_MASK) || Util.isModPressed(Clutter.ModifierType.MOD5_MASK);
				break;
			case "RMB":
				secondaryModeActivatorPressed = event.get_state() & Clutter.ModifierType.BUTTON3_MASK;
		};

		if ((!secondaryModeActivatorPressed && !defaultToSecondaryMode) || (secondaryModeActivatorPressed && defaultToSecondaryMode))
			this._previewTile(window, eventX, eventY);
		else
			this._secondaryPreviewTile(window, topTileGroup, freeScreenRects, eventX, eventY)
	}

	_previewTile(window, eventX, eventY) {
		this.tilePreview.state = PREVIEW_STATE.DEFAULT;

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
				if (timerId === this.latestMonitorLockTimerId) {
					this.monitorNr = global.display.get_current_monitor();
					if (global.display.get_grab_op() == this._grabOp)
						this._previewTile(window, eventX, eventY);
				}
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
		// because global.get_pointer's y isn't accurate (no idea why...) when grabbing on titlebar
		// & slowly going from the left/right sides to the top/bottom corners
		const titleBarGrabbed = eventY - wRect.y < 50; // random MagicNrs
		const windowAtTopEdge = titleBarGrabbed && wRect.y === workArea.y;
		const windowAtBottomEdge = wRect.y >= workArea.y + workArea.height - 75;
		const tileTopLeftQuarter = pointerAtLeftEdge && (pointerAtTopEdge || windowAtTopEdge);
		const tileTopRightQuarter = pointerAtRightEdge && (pointerAtTopEdge || windowAtTopEdge);
		const tileBottomLeftQuarter = pointerAtLeftEdge && (pointerAtBottomEdge || windowAtBottomEdge);
		const tileBottomRightQuarter = pointerAtRightEdge && (pointerAtBottomEdge || windowAtBottomEdge);

		if (tileTopLeftQuarter) {
			this.tilePreview.open(window, Util.getTileRectFor(MainExtension.TILING.TOP_LEFT, workArea, this.monitorNr), this.monitorNr);

		} else if (tileTopRightQuarter) {
			this.tilePreview.open(window, Util.getTileRectFor(MainExtension.TILING.TOP_RIGHT, workArea, this.monitorNr), this.monitorNr);

		} else if (tileBottomLeftQuarter) {
			this.tilePreview.open(window, Util.getTileRectFor(MainExtension.TILING.BOTTOM_LEFT, workArea, this.monitorNr), this.monitorNr);

		} else if (tileBottomRightQuarter) {
			this.tilePreview.open(window, Util.getTileRectFor(MainExtension.TILING.BOTTOM_RIGHT, workArea, this.monitorNr), this.monitorNr);

		} else if (pointerAtTopEdge) {
			const monitorRect = global.display.get_monitor_geometry(this.monitorNr);
			const isLandscape = monitorRect.width >= monitorRect.height;
			const shouldMaximize = (isLandscape && !MainExtension.settings.get_boolean("enable-hold-maximize-inverse-landscape"))
					|| (!isLandscape && !MainExtension.settings.get_boolean("enable-hold-maximize-inverse-portrait"));
			const tileRect = shouldMaximize ? workArea : Util.getTileRectFor(MainExtension.TILING.TOP, workArea, this.monitorNr);
			const holdTileRect = shouldMaximize ? Util.getTileRectFor(MainExtension.TILING.TOP, workArea, this.monitorNr) : workArea;
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
			this.tilePreview.open(window, Util.getTileRectFor(MainExtension.TILING.BOTTOM, workArea, this.monitorNr), this.monitorNr);

		} else if (pointerAtLeftEdge) {
			this.tilePreview.open(window, Util.getTileRectFor(MainExtension.TILING.LEFT, workArea, this.monitorNr), this.monitorNr);

		} else if (pointerAtRightEdge) {
			this.tilePreview.open(window, Util.getTileRectFor(MainExtension.TILING.RIGHT, workArea, this.monitorNr), this.monitorNr);

		} else {
			this.tilePreview.close();
		}
	}

	_secondaryPreviewTile(window, topTileGroup, freeScreenRects, eventX, eventY) {
		if (!topTileGroup.length) {
			this._previewTile(window, eventX, eventY);
			return;
		}

		const pointerLocation = {x: eventX, y: eventY};
		const screenRects = topTileGroup.map(w => w.tiledRect).concat(freeScreenRects);
		const index = screenRects.findIndex(rect => Util.rectHasPoint(rect, pointerLocation));
		const hoveredRect = screenRects[index];
		if (!hoveredRect) {
			this.tilePreview.close();
			return;
		}

		this._secondaryHoveredWindow = topTileGroup[index];
		this._secondaryHoveredRect = hoveredRect;

		const edgeRadius = 40;
		const atTopEdge = eventY < hoveredRect.y + edgeRadius;
		const atBottomEdge = eventY > hoveredRect.y + hoveredRect.height - edgeRadius;
		const atLeftEdge = eventX < hoveredRect.x + edgeRadius;
		const atRightEdge = eventX > hoveredRect.x + hoveredRect.width - edgeRadius;

		// group: possibly push multiple windows away
		if (atTopEdge || atBottomEdge || atLeftEdge || atRightEdge)
			this._secondaryGroupPreview(window, hoveredRect, topTileGroup, atTopEdge, atBottomEdge, atLeftEdge, atRightEdge);
		// single: push at max. 1 window away
		else
			this._secondarySinglePreview(window, hoveredRect, eventX, eventY);
	}

	_secondarySinglePreview(window, hoveredRect, eventX, eventY) {
		this.tilePreview.state = PREVIEW_STATE.SINGLE;

		const atTop = eventY < hoveredRect.y + hoveredRect.height * .25;
		const atBottom = eventY > hoveredRect.y + hoveredRect.height * .75;
		const atRight = eventX > hoveredRect.x + hoveredRect.width * .75;
		const atLeft = eventX < hoveredRect.x + hoveredRect.width * .25;
		const splitVertically = atTop || atBottom;
		const splitHorizontally = atLeft || atRight;

		const previewRect = new Meta.Rectangle({
			x: hoveredRect.x + (atRight && !splitVertically ? Math.floor(hoveredRect.width / 2) : 0),
			y: hoveredRect.y + (atBottom ? Math.floor(hoveredRect.height / 2) : 0),
			width: Math.ceil(hoveredRect.width / (splitHorizontally && !splitVertically ? 2 : 1)),
			height: Math.ceil(hoveredRect.height / (splitVertically ? 2 : 1))
		});
		this.tilePreview.open(window, previewRect, global.display.get_current_monitor());
	}

	_secondaryGroupPreview(window, hoveredRect, topTileGroup, atTopEdge, atBottomEdge, atLeftEdge, atRightEdge) {
		this.tilePreview.state = PREVIEW_STATE.GROUP;

		if (!this._secondaryHoveredWindow) {
			this.tilePreview.close();
			return;
		}

		const previewRect = new Meta.Rectangle();
		const previewSize = 18;

		if (atTopEdge) {
			const x1x2 = topTileGroup.reduce((result, w) => {
				return w.tiledRect.y === hoveredRect.y
					? [Math.min(w.tiledRect.x, result[0]), Math.max(w.tiledRect.x + w.tiledRect.width, result[1])] : result;
			}, [hoveredRect.x, hoveredRect.x + hoveredRect.width]);
			previewRect.x = x1x2[0];
			previewRect.y = hoveredRect.y - Math.floor(previewSize / 2);
			previewRect.width = x1x2[1] - x1x2[0];
			previewRect.height = previewSize;

		} else if (atBottomEdge) {
			const x1x2 = topTileGroup.reduce((result, w) => {
				return w.tiledRect.y + w.tiledRect.height === hoveredRect.y + hoveredRect.height
					? [Math.min(w.tiledRect.x, result[0]), Math.max(w.tiledRect.x + w.tiledRect.width, result[1])] : result;
			}, [hoveredRect.x, hoveredRect.x + hoveredRect.width]);
			previewRect.x = x1x2[0];
			previewRect.y = hoveredRect.y + hoveredRect.height - previewSize + Math.ceil(previewSize / 2);
			previewRect.width = x1x2[1] - x1x2[0];
			previewRect.height = previewSize;

		} else if (atLeftEdge) {
			const y1y2 = topTileGroup.reduce((result, w) => {
				return w.tiledRect.x === hoveredRect.x
					? [Math.min(w.tiledRect.y, result[0]), Math.max(w.tiledRect.y + w.tiledRect.height, result[1])] : result;
			}, [hoveredRect.y, hoveredRect.y + hoveredRect.height]);
			previewRect.x = hoveredRect.x - Math.floor(previewSize / 2);
			previewRect.y = y1y2[0];
			previewRect.width = previewSize;
			previewRect.height = y1y2[1] - y1y2[0];

		} else if (atRightEdge) {
			const y1y2 = topTileGroup.reduce((result, w) => {
				return w.tiledRect.x + w.tiledRect.width === hoveredRect.x + hoveredRect.width
					? [Math.min(w.tiledRect.y, result[0]), Math.max(w.tiledRect.y + w.tiledRect.height, result[1])] : result;
			}, [hoveredRect.y, hoveredRect.y + hoveredRect.height]);
			previewRect.x = hoveredRect.x + hoveredRect.width - previewSize + Math.ceil(previewSize / 2);
			previewRect.y = y1y2[0];
			previewRect.width = previewSize;
			previewRect.height = y1y2[1] - y1y2[0];
		}

		this.tilePreview.open(window, previewRect, global.display.get_current_monitor());
	}
}