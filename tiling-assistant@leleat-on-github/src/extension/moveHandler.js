"use strict";

const {windowManager} = imports.ui;
const {Clutter, GLib, Meta} = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const {RestoreOn, AlternatePreviewMod, Settings, Shortcuts} = Me.imports.src.common;
const {Util} = Me.imports.src.extension.utility;

/**
 * This class gets to handle the move events (grab & monitor change) of windows.
 * If the moved window is tiled at the start of the grab, untile it. This is
 * done by releasing the grab via code, resizing the window, and then restarting
 * the grab via code. On wayland this may not be reliable. As a workaround there
 * is a setting to restore a tiled window's size on the actual grab end.
 */

var Handler = class TilingMoveHandler {
	constructor() {
		const isMoving = grabOp => [Meta.GrabOp.MOVING, Meta.GrabOp.KEYBOARD_MOVING].includes(grabOp);

		this._displaySignals = [];
		this._displaySignals.push(global.display.connect("grab-op-begin", (display, window, grabOp) => {
			if (window && isMoving(grabOp))
				this._onMoveStarted(window, grabOp);
		}));
		this._displaySignals.push(global.display.connect("grab-op-end", (display, window, grabOp) => {
			if (window && isMoving(grabOp))
				this._onMoveFinished(window);
		}));

		// adapt the size of tiled windows when moving them the across monitors
		const leftId = global.display.connect("window-left-monitor", (display, monitorNr , window) => {
			// use this._isGrabbing because when tiling the @window during the grace period
			// on a monitor change, the @window will first be tiled and then moved
			// to the old monitor, which fires another window-left/window-entered signal.
			// untiledRect -> also maximized windows with gaps
			if (this._isGrabbing || !window.untiledRect)
				return;

			const activeWs = global.workspace_manager.get_active_workspace();
			const wsRect = activeWs.get_work_area_for_monitor(monitorNr);
			const windowRect = window.tiledRect || wsRect;
			this._scaleFactors = {
				x: (windowRect.x - wsRect.x) / wsRect.width,
				y: (windowRect.y - wsRect.y) / wsRect.height,
				width: windowRect.width / wsRect.width,
				height: windowRect.height / wsRect.height,
			};
		});
		this._displaySignals.push(leftId);

		const enteredId = global.display.connect("window-entered-monitor", (display, monitorNr , window) => {
			if (this._isGrabbing || !window.untiledRect)
				return;

			this._onMonitorChanged(window, monitorNr, this._scaleFactors);
		});
		this._displaySignals.push(enteredId);

		// save the windows, which need to make space for the grabbed window ("secondary mode")
		// {window1: newTileRect1, window2: newTileRect2, ...}
		this._splitRects = new Map();

		this._tilePreview = new windowManager.TilePreview();
		this._tilePreview.needsUpdate = rect =>
				!this._tilePreview._rect || !rect.equal(this._tilePreview._rect);
		// don't use rounded corners since it doesn't fit all possible tilePreviews
		this._tilePreview.style_class = "tile-preview";
		this._tilePreview._updateStyle = () => {};
	};

	destroy() {
		this._displaySignals.forEach(sId => global.display.disconnect(sId));
		this._tilePreview.destroy();
	};

	// windows, which are *way too* large for the new monitor, won't be moved
	// ... bug or intentional design in mutter / gnome shell?
	_onMonitorChanged(tiledWindow, newMonitorNr, scaleFactors) {
		const activeWs = global.workspace_manager.get_active_workspace();
		const wsRect = activeWs.get_work_area_for_monitor(newMonitorNr);
		const newTiledRect = new Meta.Rectangle({
			x: wsRect.x + (wsRect.width * scaleFactors.x),
			y: wsRect.y + (wsRect.height * scaleFactors.y),
			width: wsRect.width * scaleFactors.width,
			height: wsRect.height * scaleFactors.height,
		});

		// try to stick the newTiledRect to other windows in case of rounding errors
		const topTileGroup = Util.getTopTileGroup(true, newMonitorNr);
		topTileGroup.forEach(w => {
			if (Util.equalApprox(w.tiledRect.x + w.tiledRect.width, newTiledRect.x, 2))
				newTiledRect.x = w.tiledRect.x + w.tiledRect.width;
			if (Util.equalApprox(w.tiledRect.x, newTiledRect.x, 2))
				newTiledRect.x = w.tiledRect.x;
			if (Util.equalApprox(w.tiledRect.y + w.tiledRect.height, newTiledRect.y, 2))
				newTiledRect.y = w.tiledRect.y + w.tiledRect.height;
			if (Util.equalApprox(w.tiledRect.y, newTiledRect.y, 2))
				newTiledRect.y = w.tiledRect.y;

			if (Util.equalApprox(w.tiledRect.x, newTiledRect.x + newTiledRect.width, 2))
				newTiledRect.width = w.tiledRect.x - newTiledRect.x;
			if (Util.equalApprox(w.tiledRect.x + w.tiledRect.width, newTiledRect.x + newTiledRect.width, 2))
				newTiledRect.width = w.tiledRect.x + w.tiledRect.width - newTiledRect.x;
			if (Util.equalApprox(w.tiledRect.y, newTiledRect.y + newTiledRect.height, 2))
				newTiledRect.height = w.tiledRect.y - newTiledRect.y;
			if (Util.equalApprox(w.tiledRect.y + w.tiledRect.height, newTiledRect.y + newTiledRect.height, 2))
				newTiledRect.height = w.tiledRect.y + w.tiledRect.height - newTiledRect.y;
		});
		// stick to workspace edges
		if (Util.equalApprox(newTiledRect.x, wsRect.x, 2))
			newTiledRect.x = wsRect.x;
		if (Util.equalApprox(newTiledRect.y, wsRect.y, 2))
			newTiledRect.y = wsRect.y;
		if (Util.equalApprox(newTiledRect.x + newTiledRect.width, wsRect.x + wsRect.width, 2))
			newTiledRect.width = wsRect.x + wsRect.width - newTiledRect.x;
		if (Util.equalApprox(newTiledRect.y + newTiledRect.height, wsRect.y + wsRect.height, 2))
			newTiledRect.height = wsRect.y + wsRect.height - newTiledRect.y;

		Util.tile(tiledWindow, newTiledRect, false, true);
	};

	_onMoveStarted(window, grabOp) {
		this._wasMaximizedOnStart = window.get_maximized();
		const [eventX, eventY] = global.get_pointer();

		// try to restore the window size
		if ((window.tiledRect || window.get_maximized())
				&& Settings.getString(Settings.RESTORE_SIZE_ON) === RestoreOn.ON_GRAB_START) {

			// HACK:
			// the grab begin signal (and thus this function call) gets fired at the moment of
			// the first click... however I don't want to restore the window size on just a click.
			// only if the user actually wanted to start a grab. i.e. if the click is held for a bit
			// or if the cursor moved while holding the click. I assume a cursor change means the
			// grab was released since I couldn't find a better way...
			let grabReleased = false;
			let cursorId = global.display.connect("cursor-updated", () => {
				grabReleased = true;
				cursorId && global.display.disconnect(cursorId);
				cursorId = 0;
			});
			// clean up in case my assumption mentioned above is wrong
			// and the cursor never gets updated or something else...
			GLib.timeout_add(GLib.PRIORITY_LOW, 400, () => {
				cursorId && global.display.disconnect(cursorId);
				cursorId = 0;
				return GLib.SOURCE_REMOVE;
			});

			let counter = 0;
			GLib.timeout_add(GLib.PRIORITY_HIGH_IDLE, 10, () => {
				if (grabReleased)
					return GLib.SOURCE_REMOVE;

				counter += 10;
				if (counter >= 400) {
					this._restoreSizeAndRestartGrab(window, eventX, eventY, grabOp);
					return GLib.SOURCE_REMOVE;
				}

				const [currX, currY] = global.get_pointer();
				const moveDist = Util.getDistBetween2Points({x: currX, y: currY}, {x: eventX, y: eventY})
				if (moveDist > 10) {
					this._restoreSizeAndRestartGrab(window, eventX, eventY, grabOp);
					return GLib.SOURCE_REMOVE;
				}

				return GLib.SOURCE_CONTINUE;
			});

		// tile preview
		} else {
			this._isGrabbing = true;
			this._monitorNr = global.display.get_current_monitor();
			this._lastMonitorNr = this._monitorNr;

			const topTileGroup = Util.getTopTileGroup();
			const freeScreenRects = Util.getFreeScreenRects(topTileGroup);
			this._posChangedId = window.connect("position-changed"
					, this._onMoving.bind(this, grabOp, window, topTileGroup, freeScreenRects));
		}
	};

	_onMoveFinished(window) {
		if (this._posChangedId) {
			window.disconnect(this._posChangedId);
			this._posChangedId = 0;
		}

		if (!this._tilePreview._showing) {
			if (Settings.getString(Settings.RESTORE_SIZE_ON) === RestoreOn.ON_GRAB_END)
				Util.untile(window, false, this._lastPointerPos.x, this._wasMaximizedOnStart);
			return;
		}

		this._splitRects.forEach((rect, w) => Util.tile(w, rect, false));
		Util.tile(window, this._tileRect);

		this._splitRects.clear();
		this._tilePreview.close();
		this._tileRect = null;
		this._isGrabbing = false;
	};

	_onMoving(grabOp, window, topTileGroup, freeScreenRects) {
		// use the current event's coords instead of global.get_pointer to support touch...?
		const event = Clutter.get_current_event();
		if (!event)
			return;

		const [eventX, eventY] = grabOp === Meta.GrabOp.KEYBOARD_MOVING
				? global.get_pointer()
				: event.get_coords();
		this._lastPointerPos = {x: eventX, y: eventY};

		// tile preview
		const defaultToSecondaryMode = Settings.getBoolean(Settings.DEFAULT_TO_SECONDARY_PREVIEW);
		let secondaryModeActivatorPressed = false;
		switch (Settings.getString(Settings.SECONDARY_PREVIEW_ACTIVATOR)) {
			case AlternatePreviewMod.CTRL:
				secondaryModeActivatorPressed = Util.isModPressed(Clutter.ModifierType.CONTROL_MASK);
				break;
			case AlternatePreviewMod.ALT:
				secondaryModeActivatorPressed = Util.isModPressed(Clutter.ModifierType.MOD1_MASK)
						|| Util.isModPressed(Clutter.ModifierType.MOD5_MASK);
				break;
			case AlternatePreviewMod.RMB:
				secondaryModeActivatorPressed = Util.isModPressed(Clutter.ModifierType.BUTTON3_MASK);
		};

		!defaultToSecondaryMode && !secondaryModeActivatorPressed
		|| defaultToSecondaryMode && secondaryModeActivatorPressed
				? this._primaryPreviewTile(window, grabOp)
				: this._secondaryPreviewTile(window, grabOp, topTileGroup, freeScreenRects);
	};

	_restoreSizeAndRestartGrab(window, eventX, eventY, grabOp) {
		global.display.end_grab_op(global.get_current_time());

		const relativeX = (eventX - window.get_frame_rect().x) / window.get_frame_rect().width;
		let untiledRect = window.untiledRect;
		Util.untile(window, false, eventX, this._wasMaximizedOnStart);
		// untiledRect is null, if the window was maximized via non-extension way
		// (dblc-ing the titlebar, maximize button...).
		// so just get the restored window's rect directly...
		// doesn't work on Wayland because get_frame_rect() doesnt return
		// the correct size immediately after calling untile()... in that case just guess a random size
		if (!untiledRect && !Meta.is_wayland_compositor())
			untiledRect = window.get_frame_rect();

		const untiledWidth = untiledRect?.width ?? 1000;

		global.display.begin_grab_op(
			window,
			grabOp,
			true, // pointer already grabbed
			true, // frame action
			-1, // button
			global.get_pointer()[2], // modifier
			global.get_current_time(),
			window.get_frame_rect().x + untiledWidth * relativeX,
			Math.max(eventY, window.get_frame_rect().y) // so the pointer isn't above the window
		);
	};

	_primaryPreviewTile(window, grabOp) {
		// when switching monitors, provide a short grace period
		// in which the tile preview will stick to the old monitor so that
		// the user doesn't have to slowly inch the mouse to the monitor edge
		// just because there is another monitor at that edge
		const currMonitorNr = global.display.get_current_monitor();
		if (this._lastMonitorNr !== currMonitorNr) {
			this._monitorNr = this._lastMonitorNr;
			let timerId = 0;
			this._latestMonitorLockTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
				// only update the monitorNr, if the latest timer timed out
				if (timerId === this._latestMonitorLockTimerId) {
					this._monitorNr = global.display.get_current_monitor();
					if (global.display.get_grab_op() === grabOp) // !
						this._primaryPreviewTile(window, grabOp);
				}
				return GLib.SOURCE_REMOVE;
			});
			timerId = this._latestMonitorLockTimerId;
		}
		this._lastMonitorNr = currMonitorNr;

		const wRect = window.get_frame_rect();
		const workArea = window.get_work_area_for_monitor(this._monitorNr);

		const vDetectionSize = Settings.getInt(Settings.VERTICAL_PREVIEW_AREA);
		const pointerAtTopEdge = this._lastPointerPos.y <= workArea.y + vDetectionSize;
		const pointerAtBottomEdge = this._lastPointerPos.y >= workArea.y + workArea.height - vDetectionSize;
		const hDetectionSize = Settings.getInt(Settings.HORIZONTAL_PREVIEW_AREA);
		const pointerAtLeftEdge = this._lastPointerPos.x <= workArea.x + hDetectionSize;
		const pointerAtRightEdge = this._lastPointerPos.x >= workArea.x + workArea.width - hDetectionSize;
		// also use window's pos for top and bottom area detection for quarters
		// because global.get_pointer's y isn't accurate (no idea why...) when grabbing the titlebar
		// & slowly going from the left/right sides to the top/bottom corners
		const titleBarGrabbed = this._lastPointerPos.y - wRect.y < 50;
		const windowAtTopEdge = titleBarGrabbed && wRect.y === workArea.y;
		const windowAtBottomEdge = wRect.y >= workArea.y + workArea.height - 75;
		const tileTopLeftQuarter = pointerAtLeftEdge && (pointerAtTopEdge || windowAtTopEdge);
		const tileTopRightQuarter = pointerAtRightEdge && (pointerAtTopEdge || windowAtTopEdge);
		const tileBottomLeftQuarter = pointerAtLeftEdge && (pointerAtBottomEdge || windowAtBottomEdge);
		const tileBottomRightQuarter = pointerAtRightEdge && (pointerAtBottomEdge || windowAtBottomEdge);

		if (tileTopLeftQuarter) {
			this._tileRect = Util.getTileRectFor(Shortcuts.TOP_LEFT, workArea, this._monitorNr);
			this._tilePreview.open(window, this._tileRect, this._monitorNr);

		} else if (tileTopRightQuarter) {
			this._tileRect = Util.getTileRectFor(Shortcuts.TOP_RIGHT, workArea, this._monitorNr);
			this._tilePreview.open(window, this._tileRect, this._monitorNr);

		} else if (tileBottomLeftQuarter) {
			this._tileRect = Util.getTileRectFor(Shortcuts.BOTTOM_LEFT, workArea, this._monitorNr);
			this._tilePreview.open(window, this._tileRect, this._monitorNr);

		} else if (tileBottomRightQuarter) {
			this._tileRect = Util.getTileRectFor(Shortcuts.BOTTOM_RIGHT, workArea, this._monitorNr);
			this._tilePreview.open(window, this._tileRect, this._monitorNr);

		} else if (pointerAtTopEdge) {
			// switch between maximize & top tiling when keeping the mouse at the top edge for a short time
			const monitorRect = global.display.get_monitor_geometry(this._monitorNr);
			const isLandscape = monitorRect.width >= monitorRect.height;
			const shouldMaximize =
					isLandscape && !Settings.getBoolean(Settings.ENABLE_HOLD_INVERSE_LANDSCAPE)
					|| !isLandscape && !Settings.getBoolean(Settings.ENABLE_HOLD_INVERSE_PORTRAIT);
			const tileRect = shouldMaximize
					? workArea
					: Util.getTileRectFor(Shortcuts.TOP, workArea, this._monitorNr);
			const holdTileRect = shouldMaximize
					? Util.getTileRectFor(Shortcuts.TOP, workArea, this._monitorNr)
					: workArea;
			// dont open preview / start new timer if preview was already one for the top
			if (this._tilePreview._rect
						&& (holdTileRect.equal(this._tilePreview._rect)
								|| this._tilePreview._rect.equal(tileRect)))
				return;

			this._tileRect = tileRect;
			this._tilePreview.open(window, this._tileRect, this._monitorNr);

			let timerId = 0;
			this._latestPreviewTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
				Settings.getInt(Settings.INVERSE_TOP_MAXIMIZE_TIMER), () => {
				// only open the alternative preview, if the timeouted timer
				// is the same as the one which started last
				if (timerId === this._latestPreviewTimerId
						&& this._tilePreview._showing
						&& this._tilePreview._rect.equal(tileRect)) {
					this._tileRect = holdTileRect;
					this._tilePreview.open(window, this._tileRect, this._monitorNr);
				}

				return GLib.SOURCE_REMOVE;
			});
			timerId = this._latestPreviewTimerId;

		} else if (pointerAtBottomEdge) {
			this._tileRect = Util.getTileRectFor(Shortcuts.BOTTOM, workArea, this._monitorNr);
			this._tilePreview.open(window, this._tileRect, this._monitorNr);

		} else if (pointerAtLeftEdge) {
			this._tileRect = Util.getTileRectFor(Shortcuts.LEFT, workArea, this._monitorNr);
			this._tilePreview.open(window, this._tileRect, this._monitorNr);

		} else if (pointerAtRightEdge) {
			this._tileRect = Util.getTileRectFor(Shortcuts.RIGHT, workArea, this._monitorNr);
			this._tilePreview.open(window, this._tileRect, this._monitorNr);

		} else {
			this._tileRect = null;
			this._tilePreview.close();
		}
	};

	_secondaryPreviewTile(window, grabOp, topTileGroup, freeScreenRects) {
		if (!topTileGroup.length) {
			this._primaryPreviewTile(window, grabOp);
			return;
		}

		const screenRects = topTileGroup.map(w => w.tiledRect).concat(freeScreenRects);
		const hoveredRect = screenRects.find(rect => Util.hasPoint(rect, this._lastPointerPos));
		if (!hoveredRect) {
			this._tilePreview.close();
			return;
		}

		const edgeRadius = 50;
		const atTopEdge = this._lastPointerPos.y < hoveredRect.y + edgeRadius;
		const atBottomEdge = this._lastPointerPos.y > hoveredRect.y + hoveredRect.height - edgeRadius;
		const atLeftEdge = this._lastPointerPos.x < hoveredRect.x + edgeRadius;
		const atRightEdge = this._lastPointerPos.x > hoveredRect.x + hoveredRect.width - edgeRadius;

		atTopEdge || atBottomEdge || atLeftEdge || atRightEdge
			? this._secondaryPreviewGroup(window, hoveredRect, topTileGroup
					, {atTopEdge, atBottomEdge, atLeftEdge, atRightEdge})
			: this._secondaryPreviewSingle(window, hoveredRect, topTileGroup);
	};

	// split *1* existing tiled window under the moving window
	// when hovering over a tiled window while holding the secondary activator (default: ctrl)
	_secondaryPreviewSingle(window, hoveredRect, topTileGroup) {
		const atTop = this._lastPointerPos.y < hoveredRect.y + hoveredRect.height * .25;
		const atBottom = this._lastPointerPos.y > hoveredRect.y + hoveredRect.height * .75;
		const atRight = this._lastPointerPos.x > hoveredRect.x + hoveredRect.width * .75;
		const atLeft = this._lastPointerPos.x < hoveredRect.x + hoveredRect.width * .25;
		const splitVertically = atTop || atBottom;
		const splitHorizontally = atLeft || atRight;

		const previewRect = new Meta.Rectangle({
			x: hoveredRect.x + (atRight && !splitVertically ? Math.floor(hoveredRect.width / 2) : 0),
			y: hoveredRect.y + (atBottom ? Math.floor(hoveredRect.height / 2) : 0),
			width: Math.ceil(hoveredRect.width / (splitHorizontally && !splitVertically ? 2 : 1)),
			height: Math.ceil(hoveredRect.height / (splitVertically ? 2 : 1))
		});

		if (!this._tilePreview.needsUpdate(previewRect))
			return;

		this._tilePreview.open(window, previewRect, global.display.get_current_monitor());
		this._tileRect = previewRect;
		this._splitRects.clear();

		const hoveredWindow = topTileGroup.find(w => Util.hasPoint(w.tiledRect, this._lastPointerPos));
		if (!hoveredWindow)
			return;

		if (hoveredWindow.tiledRect.equal(previewRect))
			return;

		const splitRect = Util.subRectFrom(hoveredWindow.tiledRect, previewRect)[0];
		this._splitRects.set(hoveredWindow, splitRect);
	};

	// (possibly) split *multiple* existing tiled windows under the moving window
	// when hovering *at the very edges* while holding the secondary activator (default: ctrl)
	_secondaryPreviewGroup(window, hoveredRect, topTileGroup, hoveredInfo) {
		// calculate tilePreview
		const previewRect = new Meta.Rectangle();
		const previewSize = 20;

		if (hoveredInfo.atTopEdge) {
			const x1x2 = topTileGroup.reduce((result, w) => {
				return w.tiledRect.y === hoveredRect.y
					? [Math.min(w.tiledRect.x, result[0])
							, Math.max(w.tiledRect.x + w.tiledRect.width, result[1])]
					: result;
			}, [hoveredRect.x, hoveredRect.x + hoveredRect.width]);
			previewRect.x = x1x2[0];
			previewRect.y = hoveredRect.y - Math.floor(previewSize / 2);
			previewRect.width = x1x2[1] - x1x2[0];
			previewRect.height = previewSize;

		} else if (hoveredInfo.atBottomEdge) {
			const x1x2 = topTileGroup.reduce((result, w) => {
				return w.tiledRect.y + w.tiledRect.height === hoveredRect.y + hoveredRect.height
					? [Math.min(w.tiledRect.x, result[0])
							, Math.max(w.tiledRect.x + w.tiledRect.width, result[1])]
					: result;
			}, [hoveredRect.x, hoveredRect.x + hoveredRect.width]);
			previewRect.x = x1x2[0];
			previewRect.y = hoveredRect.y + hoveredRect.height - previewSize + Math.ceil(previewSize / 2);
			previewRect.width = x1x2[1] - x1x2[0];
			previewRect.height = previewSize;

		} else if (hoveredInfo.atLeftEdge) {
			const y1y2 = topTileGroup.reduce((result, w) => {
				return w.tiledRect.x === hoveredRect.x
					? [Math.min(w.tiledRect.y, result[0])
							, Math.max(w.tiledRect.y + w.tiledRect.height, result[1])]
					: result;
			}, [hoveredRect.y, hoveredRect.y + hoveredRect.height]);
			previewRect.x = hoveredRect.x - Math.floor(previewSize / 2);
			previewRect.y = y1y2[0];
			previewRect.width = previewSize;
			previewRect.height = y1y2[1] - y1y2[0];

		} else if (hoveredInfo.atRightEdge) {
			const y1y2 = topTileGroup.reduce((result, w) => {
				return w.tiledRect.x + w.tiledRect.width === hoveredRect.x + hoveredRect.width
					? [Math.min(w.tiledRect.y, result[0])
							, Math.max(w.tiledRect.y + w.tiledRect.height, result[1])]
					: result;
			}, [hoveredRect.y, hoveredRect.y + hoveredRect.height]);
			previewRect.x = hoveredRect.x + hoveredRect.width - previewSize + Math.ceil(previewSize / 2);
			previewRect.y = y1y2[0];
			previewRect.width = previewSize;
			previewRect.height = y1y2[1] - y1y2[0];
		}

		if (!this._tilePreview.needsUpdate(previewRect))
			return;

		this._tilePreview.open(window, previewRect, global.display.get_current_monitor());
		this._splitRects.clear();

		// find the smallest window that is to be split and use it to calcuate the
		// dimensions of the tileRect for the grabbed window.
		// then determine the new tileRects for the rest of the tileGroup via subRectFrom
		const smallestWindow = topTileGroup.reduce((smallestWindow, w) => {
			if (hoveredInfo.atTopEdge) {
				if (w.tiledRect.y === hoveredRect.y
						|| w.tiledRect.y + w.tiledRect.height === hoveredRect.y)
					return w.tiledRect.height < smallestWindow.tiledRect.height ? w : smallestWindow;

			} else if (hoveredInfo.atBottomEdge) {
				if (w.tiledRect.y === hoveredRect.y + hoveredRect.height
						|| w.tiledRect.y + w.tiledRect.height === hoveredRect.y + hoveredRect.height)
					return w.tiledRect.height < smallestWindow.tiledRect.height ? w : smallestWindow;

			} else if (hoveredInfo.atLeftEdge) {
				if (w.tiledRect.x === hoveredRect.x
						|| w.tiledRect.x + w.tiledRect.width === hoveredRect.x)
					return w.tiledRect.width < smallestWindow.tiledRect.width ? w : smallestWindow;

			} else if (hoveredInfo.atRightEdge) {
				if (w.tiledRect.x === hoveredRect.x + hoveredRect.width
						|| w.tiledRect.x + w.tiledRect.width === hoveredRect.x + hoveredRect.width)
					return w.tiledRect.width < smallestWindow.tiledRect.width ? w : smallestWindow;
			}

			return smallestWindow;
		});

		this._tileRect = new Meta.Rectangle();
		const isVertical = hoveredInfo.atTopEdge || hoveredInfo.atBottomEdge;
		const workArea = window.get_work_area_for_monitor(global.display.get_current_monitor());
		const factor = (hoveredRect.x === workArea.x && hoveredInfo.atLeftEdge)
				|| (hoveredRect.y === workArea.y && hoveredInfo.atTopEdge)
			? 1 / 3
			: 2 / 3;
		const size = Math.floor(smallestWindow.tiledRect[isVertical ? "height" : "width"] * factor);
		this._tileRect.x = isVertical
				? previewRect.x
				: Math.max(workArea.x , Math.floor(hoveredInfo.atLeftEdge
					? hoveredRect.x - size / 2
					: hoveredRect.x + hoveredRect.width - size / 2)
				);
		this._tileRect.y = !isVertical
				? previewRect.y
				: Math.max(workArea.y, Math.floor(hoveredInfo.atTopEdge
					? hoveredRect.y - size / 2
					: hoveredRect.y + hoveredRect.height - size / 2)
				);
		this._tileRect.width = isVertical
				? previewRect.width
				: Math.min(size, workArea.x + workArea.width - this._tileRect.x);
		this._tileRect.height = !isVertical
				? previewRect.height
				: Math.min(size, workArea.y + workArea.height - this._tileRect.y);

		topTileGroup.forEach(w => {
			const rectDiffs = Util.subRectFrom(w.tiledRect, this._tileRect);
			const splitRect = w.tiledRect.intersect(this._tileRect)[0] && rectDiffs.length && rectDiffs[0];
			splitRect && this._splitRects.set(w, splitRect);
		});
	};
};
