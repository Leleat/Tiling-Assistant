"use strict";

const {altTab, main} = imports.ui;
const {Clutter, Meta, Shell, St} = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const {Settings, Shortcuts} = Me.imports.src.common;

const GNOME_VERSION = parseFloat(imports.misc.config.PACKAGE_VERSION);

/**
 * Library of commonly used functions for the extension.js' files (and not prefs)
 */

var Util = class Utility {

	static initialize() {
		this._tileGroupManager = new TileGroupManager();
	};

	static destroy() {
		this._tileGroupManager.destroy();
	};

	static equalApprox(value, value2, margin = Settings.getInt(Settings.WINDOW_GAP)) {
		return Math.abs(value - value2) <= margin;
	};

	// given @rectA and @rectB, calculate the rectangles which remain from @rectA,
	// if @rectB is substracted from it. The result is an array of 0 - 4 rects
	// depending on @rectA/B's position.
	//
	// idea from https://en.wikibooks.org/wiki/Algorithm_Implementation/Geometry/Rectangle_difference
	// (Java implementation)
	// no license is given... only the general CC-BY-AS (for text) is mentioned in the footer.
	// Since I've translated it to JS, my function now is only based on the original principle
	// -- they implemented it in a way, which made the vertical rects (top and bottom) bigger
	// than horizontal rects (left and right), I prefered the horizontal rects
	// since screen's are mostly horizontal -- and the algorithm itself is fairly generic
	// (i. e. a short list of additions and subtractions), I think I should be good license-wise
	static subRectFrom(rectA, rectB, margin = Settings.getInt(Settings.WINDOW_GAP)) {
		const resultRects = [];
		if (!rectA || !rectB)
			return resultRects;

		// left rect
		const leftRectWidth = rectB.x - rectA.x;
		if (leftRectWidth > margin && rectA.height > margin)
			resultRects.push(new Meta.Rectangle({
				x: rectA.x,
				y: rectA.y,
				width: leftRectWidth,
				height: rectA.height
			}));

		// right rect
		const rectAX2 = rectA.x + rectA.width;
		const rectBX2 = rectB.x + rectB.width;
		const rightRectWidth = rectAX2 - rectBX2;
		if (rightRectWidth > margin && rectA.height > margin)
			resultRects.push(new Meta.Rectangle({
				x: rectBX2,
				y: rectA.y,
				width: rightRectWidth,
				height: rectA.height
			}));

		const sideRectsX1 = rectB.x > rectA.x ? rectB.x : rectA.x;
		const sideRectsX2 = rectBX2 < rectAX2 ? rectBX2 : rectAX2;
		const sideRectsWidth = sideRectsX2 - sideRectsX1;

		// top rect
		const topRectHeight = rectB.y - rectA.y;
		if (topRectHeight > margin && sideRectsWidth > margin)
			resultRects.push(new Meta.Rectangle({
				x: sideRectsX1,
				y: rectA.y,
				width: sideRectsWidth,
				height: topRectHeight
			}));

		// bottom rect
		const rectAY2 = rectA.y + rectA.height;
		const rectBY2 = rectB.y + rectB.height;
		const bottomRectHeight = rectAY2 - rectBY2;
		if (bottomRectHeight > margin && sideRectsWidth > margin)
			resultRects.push(new Meta.Rectangle({
				x: sideRectsX1,
				y: rectBY2,
				width: sideRectsWidth,
				height: bottomRectHeight
			}));

		return resultRects;
	};

	static hasPoint(rect, point) {
		return point.x >= rect.x && point.x <= rect.x + rect.width
				&& point.y >= rect.y && point.y <= rect.y + rect.height;
	};

	static getDistBetween2Points(pointA, pointB) {
		const diffX = pointA.x - pointB.x;
		const diffY = pointA.y - pointB.y;
		return Math.sqrt(diffX * diffX + diffY * diffY);
	};

	static isDirection(keyVal, direction) {
		switch (direction) {
			case Meta.MotionDirection.UP:
				return keyVal === Clutter.KEY_Up || keyVal === Clutter.KEY_w || keyVal === Clutter.KEY_W
						|| keyVal === Clutter.KEY_k || keyVal === Clutter.KEY_K;

			case Meta.MotionDirection.DOWN:
				return keyVal === Clutter.KEY_Down || keyVal === Clutter.KEY_s || keyVal === Clutter.KEY_S
						|| keyVal === Clutter.KEY_j || keyVal === Clutter.KEY_J;

			case Meta.MotionDirection.LEFT:
				return keyVal === Clutter.KEY_Left || keyVal === Clutter.KEY_a || keyVal === Clutter.KEY_A
						|| keyVal === Clutter.KEY_h || keyVal === Clutter.KEY_H;

			case Meta.MotionDirection.RIGHT:
				return keyVal === Clutter.KEY_Right || keyVal === Clutter.KEY_d || keyVal === Clutter.KEY_D
						|| keyVal === Clutter.KEY_l || keyVal === Clutter.KEY_L;
		}

		return false;
	};

	static isModPressed(modMask) {
		const event = Clutter.get_current_event();
		const modifiers = event?.get_state() ?? 0;
		return modifiers & modMask;
	};

	static isMaximized(window) {
		const workArea = window.get_work_area_current_monitor();
		return window.get_maximized() === Meta.MaximizeFlags.BOTH
				|| (window.tiledRect && window.tiledRect.equal(workArea));
	};

	static getOpenWindows(currentWorkspace = true) {
		const openWindows = altTab.getWindows(currentWorkspace
			? global.workspace_manager.get_active_workspace()
			: null
		);
		const orderedOpenWindows = global.display.sort_windows_by_stacking(openWindows).reverse();
		return orderedOpenWindows.filter(w => w.allows_move() && w.allows_resize()
				|| this.isMaximized(w));
	};

	// get the top most tiled windows in a group i. e. they complement each other and dont intersect.
	// this may differ from the TileGroupManager's *tracked* tileGroups
	// since floating windows may overlap some tiled windows atm.
	// ignore the top window if DNDing or tiling via keybinding since that window may not be tiled yet
	static getTopTileGroup(ignoreTopWindow = true, monitor = null) {
		const openWindows = this.getOpenWindows();
		const groupedWindows = [];
		const notGroupedWindows = [];
		let groupedWindowsArea = 0;
		monitor = monitor ?? (openWindows.length && openWindows[0].get_monitor());

		for (let i = ignoreTopWindow ? 1 : 0; i < openWindows.length; i++) {
			const window = openWindows[i];
			if (window.get_monitor() !== monitor)
				continue;

			if (window.isTiled) {
				const workArea = window.get_work_area_current_monitor();
				const wRect = window.tiledRect;

				// the grouped windows fill the entire screen, so no more new grouped windows possible
				if (groupedWindowsArea >= workArea.area())
					break;

				// if a non-grouped window in a higher stack order overlaps the currently tested tiled window,
				// the currently tested tiled window isn't part of the top tile group
				const windowOverlapsNonGroupedWindows =
						notGroupedWindows.some(w => (w.tiledRect || w.get_frame_rect()).overlap(wRect));
				// same applies for already grouped windows; but only check if
				// , it doesn't already overlap non-grouped window
				const windowOverlapsGroupedWindows = !windowOverlapsNonGroupedWindows
						&& groupedWindows.some(w => w.tiledRect.overlap(wRect));
				if (windowOverlapsNonGroupedWindows || windowOverlapsGroupedWindows) {
					notGroupedWindows.push(window);
				} else {
					groupedWindows.push(window);
					groupedWindowsArea += wRect.area();
				}

			} else {
				// window is maximized, so all windows below it cant belong to this group
				if (this.isMaximized(window))
					break;

				// ignore non-tiled windows, which are always-on-top, for the
				// calculation since they are probably some utility apps etc.
				if (!window.is_above())
					notGroupedWindows.push(window);
			}
		}

		return groupedWindows;
	};

	// get an array of Meta.Rectangles, which represent the free screen space
	static getFreeScreenRects(tileGroup) {
		const firstTiledWindow = tileGroup[0];
		const activeWs = global.workspace_manager.get_active_workspace();
		const entireWorkArea = firstTiledWindow?.get_work_area_for_monitor(firstTiledWindow.get_monitor())
				?? activeWs.get_work_area_for_monitor(global.display.get_current_monitor());

		// get freeSreenRects for each window in @tileGroup individually
		const freeRectsForWindows = tileGroup.map(w => this.subRectFrom(entireWorkArea, w.tiledRect));
		// get the final freeScreenRects by intersecting all freeScreenRects for each individual window
		return freeRectsForWindows.reduce((finalFreeScreenRects, individualWindowsFreeRects) => {
			const intersections = [];
			for (const windowsFreeRect of individualWindowsFreeRects) {
				for (const rect of finalFreeScreenRects) {
					const [doIntersect, intersectionRect] = rect.intersect(windowsFreeRect);
					doIntersect && intersections.push(intersectionRect);
				}
			}

			return intersections;
		}, [entireWorkArea]);
	};

	// get the unambiguous freeScreenSpace (Meta.Rectangle) formed by @tileGroup
	static getFreeScreenSpace(tileGroup) {
		const freeScreenRects = this.getFreeScreenRects(tileGroup);
		if (!freeScreenRects.length)
			return null;

		// create the union of all of freeScreenRects and calculate the sum of their areas.
		// if the area of the union-rect equals the area of the individual rects
		// , the individual rects align properly
		const [nonUnifiedArea, freeScreenSpace] = freeScreenRects.reduce((result, currRect) => {
			return [result[0] += currRect.area(), result[1].union(currRect)];
		}, [0, new Meta.Rectangle({
			x: freeScreenRects[0].x,
			y: freeScreenRects[0].y
		})]);

		// TODO potentionally rounding errors?
		// random min. size requirement
		if (freeScreenSpace.area() === nonUnifiedArea &&
				freeScreenSpace.width > 250 && freeScreenSpace.height > 250)
			return freeScreenSpace;

		return null;
	};

	static getClosestRect(currRect, rectList, direction, wrapAround = false) {
		// get closest rect WITHOUT wrapping around
		let closestRect = rectList.reduce((closest, rect) => {
			// first make sure the tested rect is roughly & completely on the side we want to move to.
			// E. g. if you want to get a rect towards the left,
			// **any** rect that is to the left of the @currRect will be further checked
			if (((direction === Shortcuts.TOP || direction === Shortcuts.MAXIMIZE) && rect.y + rect.height <= currRect.y)
					|| (direction === Shortcuts.BOTTOM && currRect.y + currRect.height <= rect.y)
					|| (direction === Shortcuts.LEFT && rect.x + rect.width <= currRect.x)
					|| (direction === Shortcuts.RIGHT && currRect.x + currRect.width <= rect.x)) {

				if (!closest)
					return rect;

				// calculate the distance between the center of the edge in the direction to
				// of the @currRect and the center of the opposite site of the rect. For ex.: Move up:
				// calculate the distance between the center of the top edge of the @currRect
				// and the center of the bottom edge of the other rect
				const dist2currRect = rect => {
					switch (direction) {
						case Shortcuts.TOP:
						case Shortcuts.MAXIMIZE:
							return this.getDistBetween2Points({x: rect.x + rect.width / 2, y: rect.y + rect.height}
									, {x: currRect.x + currRect.width / 2, y: currRect.y});

						case Shortcuts.BOTTOM:
							return this.getDistBetween2Points({x: rect.x + rect.width / 2, y: rect.y}
									, {x: currRect.x + currRect.width / 2, y: currRect.y + currRect.height});

						case Shortcuts.LEFT:
							return this.getDistBetween2Points({x: rect.x + rect.width, y: rect.y + rect.height / 2}
									, {x: currRect.x, y: currRect.y + currRect.height / 2});

						case Shortcuts.RIGHT:
							return this.getDistBetween2Points({x: rect.x, y: rect.y + rect.height / 2}
									, {x: currRect.x + currRect.width, y: currRect.y + currRect.height / 2});
					}
				}

				return dist2currRect(rect) < dist2currRect(closest) ? rect : closest;
			}

			return closest;
		}, null);

		// wrap around, if needed
		if (!closestRect && wrapAround) {
			// first: look for the rects, which are furthest on the opposite direction
			const closestRects = rectList.reduce((closests, rect) => {
				if (!closests.length)
					return [rect];

				switch (direction) {
					case Shortcuts.TOP:
					case Shortcuts.MAXIMIZE:
						if (closests[0].y + closests[0].height === rect.y + rect.height)
							return [...closests, rect];
						else
							return closests[0].y + closests[0].height > rect.y + rect.height
									? closests : [rect];

					case Shortcuts.BOTTOM:
						if (closests[0].y === rect.y)
							return [...closests, rect];
						else
							return closests[0].y < rect.y ? closests : [rect];

					case Shortcuts.LEFT:
						if (closests[0].x + closests[0].width === rect.x + rect.width)
							return [...closests, rect];
						else
							return closests[0].x + closests[0].width > rect.x + rect.width
									? closests : [rect];

					case Shortcuts.RIGHT:
						if (closests[0].x === rect.x)
							return [...closests, rect];
						else
							return closests[0].x < rect.x ? closests : [rect];
				}
			}, []);

			// second: prefer the rect closest to the @currRect's h/v axis
			closestRect = closestRects.reduce((closest, rect) => {
				switch (direction) {
					case Shortcuts.TOP:
					case Shortcuts.MAXIMIZE:
					case Shortcuts.BOTTOM:
						return Math.abs(closest.x - currRect.x) < Math.abs(rect.x - currRect.x) ? closest : rect;

					case Shortcuts.LEFT:
					case Shortcuts.RIGHT:
						return Math.abs(closest.y - currRect.y) < Math.abs(rect.y - currRect.y) ? closest : rect;
				}
			});
		}

		return closestRect;
	};

	static getBestFitTiledRect(window, topTileGroup = null) {
		if (!window.isTiled) {
			topTileGroup = topTileGroup || this.getTopTileGroup();
			const freeScreenSpace = this.getFreeScreenSpace(topTileGroup);
			return freeScreenSpace || window.get_work_area_current_monitor();

		} else {
			// check if the freeScreenRect borders the tiledRect and
			// if the bordering side of the freeScreenRect is bigger than the one of the tiledWindow
			const tileBordersFreeRect = function(freeRect, tiledRect) {
				const v = (freeRect.vert_overlap(tiledRect)
						&& freeRect.y <= tiledRect.y && freeRect.y + freeRect.height >= tiledRect.y + tiledRect.height
						&& (freeRect.x === tiledRect.x + tiledRect.width || freeRect.x + freeRect.width === tiledRect.x));
				const h = (freeRect.horiz_overlap(tiledRect)
						&& freeRect.x <= tiledRect.x && freeRect.x + freeRect.width >= tiledRect.x + tiledRect.width
						&& (freeRect.y === tiledRect.y + tiledRect.height || freeRect.y + freeRect.height === tiledRect.y))
				return v || h;
			}

			topTileGroup = topTileGroup || this.getTopTileGroup(false);
			const freeSpace = this.getFreeScreenSpace(topTileGroup);
			const freeScreenRects = freeSpace ? [freeSpace] : this.getFreeScreenRects(topTileGroup);
			const tileRect = window.tiledRect;
			for (const rect of freeScreenRects) {
				if (tileBordersFreeRect(rect, tileRect)) {
					const hOverlap = rect.horiz_overlap(tileRect);
					const vOverlap = rect.vert_overlap(tileRect);
					return new Meta.Rectangle({
						x: vOverlap && rect.x <= tileRect.x ? rect.x : tileRect.x,
						y: hOverlap && rect.y <= tileRect.y ? rect.y : tileRect.y,
						width: tileRect.width + (vOverlap ? rect.width : 0),
						height: tileRect.height + (hOverlap ? rect.height : 0),
					});
				}
			}

			return tileRect;
		}
	};

	static getTileRectFor(position, workArea, monitor = null) {
		const topTileGroup = this.getTopTileGroup(true, monitor);
		const screenRects = topTileGroup.map(w => w.tiledRect).concat(this.getFreeScreenRects(topTileGroup));

		let width, height, rect;
		switch (position) {
			case Shortcuts.MAXIMIZE:
				return workArea;

			case Shortcuts.LEFT:
				rect = screenRects.find(r => r.x === workArea.x && r.width !== workArea.width);
				width = rect?.width ?? Math.ceil(workArea.width / 2);
				return new Meta.Rectangle({
					x: workArea.x,
					y: workArea.y,
					width,
					height: workArea.height
				});

			case Shortcuts.RIGHT:
				rect = screenRects.find(r => r.x + r.width === workArea.x + workArea.width && r.width !== workArea.width);
				width = rect?.width ?? Math.ceil(workArea.width / 2);
				return new Meta.Rectangle({
					x: workArea.x + workArea.width - width,
					y: workArea.y,
					width,
					height: workArea.height
				});

			case Shortcuts.TOP:
				rect = screenRects.find(r => r.y === workArea.y && r.height !== workArea.height);
				height = rect?.height ?? Math.ceil(workArea.height / 2);
				return new Meta.Rectangle({
					x: workArea.x,
					y: workArea.y,
					width: workArea.width,
					height
				});

			case Shortcuts.BOTTOM:
				rect = screenRects.find(r => r.y + r.height === workArea.y + workArea.height && r.height !== workArea.height);
				height = rect?.height ?? Math.ceil(workArea.height / 2);
				return new Meta.Rectangle({
					x: workArea.x,
					y: workArea.y + workArea.height - height,
					width: workArea.width,
					height
				});

			case Shortcuts.TOP_LEFT:
				rect = screenRects.find(r => r.x === workArea.x && r.width !== workArea.width);
				width = rect?.width ?? Math.ceil(workArea.width / 2);
				rect = screenRects.find(r => r.y === workArea.y && r.height !== workArea.height);
				height = rect?.height ?? Math.ceil(workArea.height / 2);
				return new Meta.Rectangle({
					x: workArea.x,
					y: workArea.y,
					width,
					height
				});

			case Shortcuts.TOP_RIGHT:
				rect = screenRects.find(r => r.x + r.width === workArea.x + workArea.width && r.width !== workArea.width);
				width = rect?.width ?? Math.ceil(workArea.width / 2);
				rect = screenRects.find(r => r.y === workArea.y && r.height !== workArea.height);
				height = rect?.height ?? Math.ceil(workArea.height / 2);
				return new Meta.Rectangle({
					x: workArea.x + workArea.width - width,
					y: workArea.y,
					width,
					height
				});

			case Shortcuts.BOTTOM_LEFT:
				rect = screenRects.find(r => r.x === workArea.x && r.width !== workArea.width);
				width = rect?.width ?? Math.ceil(workArea.width / 2);
				rect = screenRects.find(r => r.y + r.height === workArea.y + workArea.height && r.height !== workArea.height);
				height = rect?.height ?? Math.ceil(workArea.height / 2);
				return new Meta.Rectangle({
					x: workArea.x,
					y: workArea.y + workArea.height - height,
					width,
					height
				});

			case Shortcuts.BOTTOM_RIGHT:
				rect = screenRects.find(r => r.x + r.width === workArea.x + workArea.width && r.width !== workArea.width);
				width = rect?.width ?? Math.ceil(workArea.width / 2);
				rect = screenRects.find(r => r.y + r.height === workArea.y + workArea.height && r.height !== workArea.height);
				height = rect?.height ?? Math.ceil(workArea.height / 2);
				return new Meta.Rectangle({
					x: workArea.x + workArea.width - width,
					y: workArea.y + workArea.height - height,
					width,
					height
				});
		}
	};

	static toggleTileState(window, tileRect) {
		const workArea = window.get_work_area_current_monitor();
		(window.isTiled && tileRect.equal(window.tiledRect)) || (tileRect.equal(workArea) && this.isMaximized(window))
				? this.untile(window)
				: this.tile(window, tileRect);
	};

	static tile(window, newRect, openTilingPopup = true, skipAnim = false) {
		if (!window || window.is_skip_taskbar())
			return;

		const wasMaximized = window.get_maximized();
		if (wasMaximized)
			window.unmaximize(wasMaximized);

		if (!window.allows_resize() || !window.allows_move())
			return;

		window.unminimize();
		// raise @window since tiling via the popup means that the window can be below others
		window.raise();

		// remove @window from other windows' tileGroups so it doesn't falsely get raised with them
		this._tileGroupManager.dissolveTileGroup(window.get_id());

		const oldRect = window.get_frame_rect();
		const gap = Settings.getInt(Settings.WINDOW_GAP);
		const workArea = window.get_work_area_for_monitor(window.get_monitor());
		const maximize = newRect.equal(workArea);

		window.isTiled = !maximize;
		if (!window.untiledRect)
			window.untiledRect = oldRect;

		if (maximize && (!gap || !Settings.getBoolean(Settings.MAXIMIZE_WITH_GAPS))) {
			window.tiledRect = null;
			window.maximize(Meta.MaximizeFlags.BOTH);
			return; // no anim needed or anything else when maximizing both
		}

		// save the intended tile rect for accurate operations later.
		// workaround for windows which cant be resized freely...
		// for ex. which only resize in full rows/columns like gnome-terminal
		window.tiledRect = newRect.copy();

		const x = newRect.x + (gap - (workArea.x === newRect.x ? 0 : gap / 2));
		const y = newRect.y + (gap - (workArea.y === newRect.y ? 0 : gap / 2));
		// lessen gap by half when the window isn't on the left or the right edge of the screen
		const width = newRect.width
				- (2 * gap - (workArea.x === newRect.x ? 0 : gap / 2)
				- (workArea.x + workArea.width === newRect.x + newRect.width ? 0 : gap / 2));
		const height = newRect.height
				- (2 * gap - (workArea.y === newRect.y ? 0 : gap / 2)
				- (workArea.y + workArea.height === newRect.y + newRect.height ? 0 : gap / 2));

		// animations
		const wActor = window.get_compositor_private();
		if (Settings.getBoolean(Settings.ENABLE_TILE_ANIMATIONS) && !skipAnim && wActor) {
			const onlyMove = oldRect.width === width && oldRect.height === height;
			if (onlyMove) { // custom anim because they dont exist
				const clone = new St.Widget({
					content: GNOME_VERSION < 41
							? Shell.util_get_content_for_window_actor(wActor, oldRect)
							: wActor.paint_to_content(oldRect),
					x: oldRect.x,
					y: oldRect.y,
					width: oldRect.width,
					height: oldRect.height
				});
				main.uiGroup.add_child(clone);
				wActor.hide();

				clone.ease({
					x, y, width, height,
					duration: 250,
					mode: Clutter.AnimationMode.EASE_OUT_QUAD,
					onComplete: () => {
						wActor.show();
						clone.destroy();
					}
				});

			} else if (wasMaximized) {

			} else {
				// HACK => journalctl: error in size change accounting; SizeChange flag?
				main.wm._prepareAnimationInfo(global.window_manager, wActor, oldRect, Meta.SizeChange.MAXIMIZE);
			}
		}

		// Wayland workaround because some apps dont work properly
		// e. g. tiling Nautilus and then choosing firefox from the popup
		Meta.is_wayland_compositor() && window.move_frame(false, x, y);
		// user_op as false needed for some apps
		window.move_resize_frame(false, x, y, width, height);

		if (maximize)
			return;

		// setup (new) tileGroup to raise tiled windows as a group
		const topTileGroup = this.getTopTileGroup(false);
		// only allow a window to be part of 1 tileGroup
		topTileGroup.forEach(w => this._tileGroupManager.dissolveTileGroup(w.get_id()));
		this._tileGroupManager.updateTileGroup(topTileGroup);

		openTilingPopup && this.tryOpeningTilingPopup();
	};

	// last 2 params are used for restoring the window size via DND
	static untile(window, restoreFullPos = true, grabXCoord = undefined, skipAnim = false) {
		const wasMaximized = window.get_maximized();
		if (wasMaximized)
			window.unmaximize(wasMaximized);

		if (!window.untiledRect || !window.allows_resize() || !window.allows_move())
			return;

		// if you tiled a window and then used the popup to tile more windows,
		// the consecutive windows will be raised above the first one.
		// so untiling the initial window after tiling more windows with the popup
		// (without re-focusing the initial window) means the untiled window will be below the others
		window.raise();

		// animation hack => journalctl: error in size change accounting; SizeChange flag?
		if (!wasMaximized && !skipAnim && Settings.getBoolean(Settings.ENABLE_UNTILE_ANIMATIONS))
			main.wm._prepareAnimationInfo(
				global.window_manager
				, window.get_compositor_private()
				, window.get_frame_rect()
				, Meta.SizeChange.UNMAXIMIZE
			);

		const oldRect = window.untiledRect;
		if (restoreFullPos) { // via keybinding
			// user_op as false to restore window while keeping it fully in screen
			// in case DND-tiling dragged it offscreen
			window.move_resize_frame(false, oldRect.x, oldRect.y, oldRect.width, oldRect.height);

		} else { // via DND: scale while keeping the top at the same relative y pos
			const currWindowFrame = window.get_frame_rect();
			grabXCoord = grabXCoord || global.get_pointer()[0];
			const relativeMouseX = (grabXCoord - currWindowFrame.x) / currWindowFrame.width;
			const newPosX = grabXCoord - oldRect.width * relativeMouseX;

			// Wayland workaround for DND/restore position
			Meta.is_wayland_compositor() && window.move_frame(true, newPosX, currWindowFrame.y);
			// user_op with true to properly restore big windows via DND so they can go partly offscreen
			window.move_resize_frame(true, newPosX, currWindowFrame.y, oldRect.width, oldRect.height);
		}

		this._tileGroupManager.dissolveTileGroup(window.get_id());
		window.isTiled = false;
		window.tiledRect = null;
		window.untiledRect = null;
	};

	static tryOpeningTilingPopup() {
		if (!Settings.getBoolean(Settings.ENABLE_TILING_POPUP))
			return;

		const currWorkspaceOnly = Settings.getBoolean(Settings.CURR_WORKSPACE_ONLY);
		const openWindows = this.getOpenWindows(currWorkspaceOnly);
		const topTileGroup = this.getTopTileGroup(false);
		topTileGroup.forEach(w => openWindows.splice(openWindows.indexOf(w), 1));
		if (!openWindows.length)
			return;

		const freeScreenSpace = this.getFreeScreenSpace(topTileGroup);
		if (!freeScreenSpace)
			return;

		const TilingPopup = Me.imports.src.tilingPopup;
		const popup = new TilingPopup.TilingSwitcherPopup(openWindows, freeScreenSpace);
		if (!popup.show(topTileGroup))
			popup.destroy();
	};

	static updateTileGroup(tileGroup) {
		this._tileGroupManager.updateTileGroup(tileGroup);
	};

	static dissolveTileGroup(windowId) {
		this._tileGroupManager.dissolveTileGroup(windowId);
	};

	static getTileGroups() {
		return this._tileGroupManager.getTileGroups();
	};

	static setupTileGroups(tileGroups) {
		this._tileGroupManager.setTileGroups(tileGroups);
	}

	static getTileGroupFor(window) {
		return this._tileGroupManager.getTileGroupFor(window);
	};

	static ___debugShowTiledRects() {
		const topTileGroup = this.getTopTileGroup(false);
		if (!topTileGroup.length) {
			main.notify("Tiling Assistant", "No tiled windows / tiled rects")
			return null;
		}

		const indicators = [];
		topTileGroup.forEach(w => {
			const indicator = new St.Widget({
				style_class: "tile-preview",
				opacity: 160,
				x: w.tiledRect.x,
				y: w.tiledRect.y,
				width: w.tiledRect.width,
				height: w.tiledRect.height
			});
			main.uiGroup.add_child(indicator);
			indicators.push(indicator);
		});

		return indicators;
	};

	static ___debugShowFreeScreenRects() {
		const topTileGroup = this.getTopTileGroup(false);
		const freeScreenRects = this.getFreeScreenRects(topTileGroup);
		const freeScreenSpace = this.getFreeScreenSpace(topTileGroup);
		const rects = freeScreenSpace ? [freeScreenSpace] : freeScreenRects;

		const indicators = [];
		rects.forEach(rect => {
			const indicator = new St.Widget({
				style_class: "tile-preview",
				x: rect.x,
				y: rect.y,
				width: rect.width,
				height: rect.height
			});
			main.uiGroup.add_child(indicator);
			indicators.push(indicator);
		});

		return indicators.length ? indicators : null;
	};
};

// Helper class for Util:
// This class tracks the different tileGroups for each tiled window.
// Windows in a tileGroup will be raised together, if a tiled window is raised
// (and if the setting isn't disabled).
const TileGroupManager = class TileGroupManager {

	constructor() {
		this._groupRaiseIds = new Map(); // {windowId1: int, windowId2: int, ...}
		this._unmanagedIds = new Map(); // {windowId1: int, windowId2: int, ...}
		this._tileGroups = new Map(); // {windowId1: [windowIdX, windowIdY, ...], windowId2: [,,,]...}
	};

	destroy() {
		this._groupRaiseIds.forEach((signalId, windowId) => this._getWindow(windowId).disconnect(signalId));
		this._groupRaiseIds.clear();
		this._unmanagedIds.forEach((signalId, windowId) => this._getWindow(windowId).disconnect(signalId));
		this._unmanagedIds.clear();
		this._tileGroups.clear();
	};

	// @tileGroup is an array of metaWindows.
	// save the windowIds in the tracking Maps and connect to the raise signals
	// to raise the tileGroup together
	updateTileGroup(tileGroup) {
		tileGroup.forEach(window => {
			const windowId = window.get_id();
			this._tileGroups.set(windowId, tileGroup.map(w => w.get_id()));
			this._groupRaiseIds.has(windowId) && window.disconnect(this._groupRaiseIds.get(windowId));

			this._groupRaiseIds.set(windowId, window.connect("raised", raisedWindow => {
				const raisedWindowId = raisedWindow.get_id();
				if (Settings.getBoolean(Settings.RAISE_TILE_GROUPS)) {
					const raisedWindowsTileGroup = this._tileGroups.get(raisedWindowId);
					raisedWindowsTileGroup.forEach(wId => {
						// disconnect the raise signal first, so we don't end up
						// in an infinite loop of windows raising each other
						const w = this._getWindow(wId);
						if (!w) { // may be undefined, if @w was just closed
							// in case I missed/don't know about other cases where @w may be nullish
							this.dissolveTileGroup(wId);
							return;
						}

						if (this._groupRaiseIds.has(wId)) {
							w.disconnect(this._groupRaiseIds.get(wId));
							this._groupRaiseIds.delete(wId);
						}
						w.raise();
					});

					// re-raise the just raised window so it may not be below other tiled window
					// otherwise when untiling via keyboard it may be below other tiled windows
					raisedWindow.raise();
				}

				const raisedTileGroup = this._tileGroups.get(raisedWindowId);
				this.updateTileGroup(this._getAllWindows()
						.filter(w => raisedTileGroup.includes(w.get_id())));
			}));

			this._unmanagedIds.has(windowId) && window.disconnect(this._unmanagedIds.get(windowId));
			this._unmanagedIds.set(windowId, window.connect("unmanaged", () =>
					this.dissolveTileGroup(windowId)));
		});
	};

	// delete the tileGroup of window with @windowId for group-raising and
	// remove the window from the tileGroup of other tiled windows
	dissolveTileGroup(windowId) {
		const window = this._getWindow(windowId);
		if (this._groupRaiseIds.has(windowId)) {
			window && window.disconnect(this._groupRaiseIds.get(windowId));
			this._groupRaiseIds.delete(windowId);
		}

		if (this._unmanagedIds.has(windowId)) {
			window && window.disconnect(this._unmanagedIds.get(windowId));
			this._unmanagedIds.delete(windowId);
		}

		if (!this._tileGroups.has(windowId))
			return;

		// delete @window's tileGroup
		this._tileGroups.delete(windowId);
		// delete @window from other windows' tileGroup
		this._tileGroups.forEach(tileGroup => {
			const idx = tileGroup.indexOf(windowId);
			idx !== -1 && tileGroup.splice(idx, 1);
		});
	};

	getTileGroups() {
		return this._tileGroups;
	};

	setTileGroups(tileGroups) {
		this._tileGroups = tileGroups;
	};

	getTileGroupFor(window) {
		const tileGroup = this._tileGroups.get(window.get_id());
		return this._getAllWindows().filter(w => tileGroup.includes(w.get_id()));
	};

	// the one used in tilingUtil is filtered for the tilingPopup
	_getAllWindows() {
		return global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null);
	};

	_getWindow(windowId) {
		return this._getAllWindows().find(w => w.get_id() === windowId);
	};
};
