"use strict";

const {altTab, main} = imports.ui;
const {Clutter, GLib, Meta, Shell, St} = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const MainExtension = Me.imports.extension;
const TilingPopup = Me.imports.tilingPopup;

function equalApprox(value, value2, margin = MainExtension.settings.get_int("window-gap")) {
	return value >= value2 - margin && value <= value2 + margin;
};

// given @rectA and @rectB, calculate the rectangles which remain from @rectA,
// if @rectB is substracted from it. The result is an array of 0 - 4 rects depending on @rectA/B's position.
//
// idea from https://en.wikibooks.org/wiki/Algorithm_Implementation/Geometry/Rectangle_difference (Java implementation)
// no license is given... only the general CC-BY-AS (for text) is mentioned in the footer.
// Since I've translated it to JS, my function now is only based on the original principle -- they implemented it in a way,
// which made the vertical rects (top and bottom) bigger than horizontal rects (left and right),
// I prefered the horizontal rects since screen's are mostly horizontal -- and the algorithm itself is fairly generic
// (i. e. a short list of additions and subtractions), I think I should be good license-wise
function rectDiff(rectA, rectB, margin = MainExtension.settings.get_int("window-gap")) {
	const resultRects = [];
	if (!rectA || !rectB)
		return resultRects;

	// left rect
	const leftRectWidth = rectB.x - rectA.x;
	if (leftRectWidth > margin && rectA.height > margin)
		resultRects.push(new Meta.Rectangle({x: rectA.x, y: rectA.y, width: leftRectWidth, height: rectA.height}));

	// right rect
	const rectAX2 = rectA.x + rectA.width;
	const rectBX2 = rectB.x + rectB.width;
	const rightRectWidth = rectAX2 - rectBX2;
	if (rightRectWidth > margin && rectA.height > margin)
		resultRects.push(new Meta.Rectangle({x: rectBX2, y: rectA.y, width: rightRectWidth, height: rectA.height}));

	const sideRectsX1 = rectB.x > rectA.x ? rectB.x : rectA.x;
	const sideRectsX2 = rectBX2 < rectAX2 ? rectBX2 : rectAX2;
	const sideRectsWidth = sideRectsX2 - sideRectsX1;

	// top rect
	const topRectHeight = rectB.y - rectA.y;
	if (topRectHeight > margin && sideRectsWidth > margin)
		resultRects.push(new Meta.Rectangle({x: sideRectsX1, y: rectA.y, width: sideRectsWidth, height: topRectHeight}));

	// bottom rect
	const rectAY2 = rectA.y + rectA.height;
	const rectBY2 = rectB.y + rectB.height;
	const bottomRectHeight = rectAY2 - rectBY2;
	if (bottomRectHeight > margin && sideRectsWidth > margin)
		resultRects.push(new Meta.Rectangle({x: sideRectsX1, y: rectBY2, width: sideRectsWidth, height: bottomRectHeight}));

	return resultRects;
};

function rectHasPoint(rect, point) {
	return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
};

function distBetween2Points(pointA, pointB) {
	const diffX = pointA.x - pointB.x;
	const diffY = pointA.y - pointB.y;
	return Math.sqrt(diffX * diffX + diffY * diffY);
};

function eventIsDirection(keyVal, direction) {
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

function isModPressed(modMask) {
	const event = Clutter.get_current_event();
	const modifiers = event ? event.get_state() : 0;
	return modifiers & modMask;
};

function windowIsMaximized(window) {
	const workArea = window.get_work_area_current_monitor();
	return window.get_maximized() === Meta.MaximizeFlags.BOTH || (window.tiledRect && window.tiledRect.equal(workArea));
};

function getOpenWindows(currentWorkspace = true) {
	const openWindows = altTab.getWindows(currentWorkspace ? global.workspace_manager.get_active_workspace() : null);
	const orderedOpenWindows = global.display.sort_windows_by_stacking(openWindows).reverse();
	return orderedOpenWindows.filter(w => (w.allows_move() && w.allows_resize()) || windowIsMaximized(w));
};

// get the top most tiled windows in a group i. e. they complement each other and dont intersect.
// ignore the top window if DNDing or tiling via keybinding since that window may not be tiled yet
function getTopTileGroup(ignoreTopWindow = true, monitor = null) {
	const openWindows = getOpenWindows();
	const groupedWindows = [];
	const notGroupedWindows = [];
	let groupedWindowsArea = 0;
	monitor = monitor !== null ? monitor : (openWindows.length && openWindows[0].get_monitor());

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
			const windowOverlapsNonGroupedWindows = notGroupedWindows.some(w => (w.tiledRect || w.get_frame_rect()).overlap(wRect));
			// same applies for already grouped windows; but only check if, it doesn't already overlap non-grouped window
			const windowOverlapsGroupedWindows = !windowOverlapsNonGroupedWindows && groupedWindows.some(w => w.tiledRect.overlap(wRect));
			if (windowOverlapsNonGroupedWindows || windowOverlapsGroupedWindows) {
				notGroupedWindows.push(window);
			} else {
				groupedWindows.push(window);
				groupedWindowsArea += wRect.area();
			}

		} else {
			// window is maximized, so all windows below it cant belong to this group
			if (windowIsMaximized(window))
				break;

			notGroupedWindows.push(window);
		}
	}

	return groupedWindows;
};

// get an array of Meta.Rectangles, which represent the free screen space
function getFreeScreenRects(tileGroup) {
	const firstTiledWindow = tileGroup[0];
	const entireWorkArea = firstTiledWindow ? firstTiledWindow.get_work_area_for_monitor(firstTiledWindow.get_monitor())
			: global.workspace_manager.get_active_workspace().get_work_area_for_monitor(global.display.get_current_monitor());

	// get freeSreenRects for each window in @tileGroup individually
	const freeRectsForWindows = tileGroup.map(w => rectDiff(entireWorkArea, w.tiledRect));
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
function getFreeScreenSpace(tileGroup) {
	const freeScreenRects = getFreeScreenRects(tileGroup);
	if (!freeScreenRects.length)
		return null;

	// create the union of all of freeScreenRects and calculate the sum of their areas.
	// if the area of the union-rect equals the area of the individual rects, the individual rects align properly
	// e. g. free screen space = 2 horizontally/vertically aligned quarters or only 1 free quarter
	const [nonUnifiedArea, freeScreenSpace] = freeScreenRects.reduce((result, currRect) => {
		return [result[0] += currRect.area(), result[1].union(currRect)];
	}, [0, new Meta.Rectangle({x: freeScreenRects[0].x, y: freeScreenRects[0].y})]);

	// TODO potentionally rounding errors?
	// random min. size requirement
	if (freeScreenSpace.area() === nonUnifiedArea && (freeScreenSpace.width > 250 && freeScreenSpace.height > 250))
		return freeScreenSpace;

	return null;
};

function getClosestRect(currRect, rectList, direction, wrapAround = false) {
	// get closest rect WITHOUT wrapping around
	let closestRect = rectList.reduce((closest, rect) => {
		// first make sure the tested rect is roughly & completely on the side we want to move to.
		// E. g. if you want to get a rect towards the left,
		// **any** rect that is to the left of the @currRect will be further checked
		if (((direction === MainExtension.TILING.TOP || direction === MainExtension.TILING.MAXIMIZE) && rect.y + rect.height <= currRect.y)
				|| (direction === MainExtension.TILING.BOTTOM && currRect.y + currRect.height <= rect.y)
				|| (direction === MainExtension.TILING.LEFT && rect.x + rect.width <= currRect.x)
				|| (direction === MainExtension.TILING.RIGHT && currRect.x + currRect.width <= rect.x)) {

			if (!closest)
				return rect;

			// calculate the distance between the center of the edge in the direction to
			// of the @currRect and the center of the opposite site of the rect. For ex.: Move up:
			// calculate the distance between the center of the top edge of the @currRect
			// and the center of the bottom edge of the other rect
			const dist2currRect = function(rect) {
				switch (direction) {
					case MainExtension.TILING.TOP:
					case MainExtension.TILING.MAXIMIZE:
						return distBetween2Points({x: rect.x + rect.width / 2, y: rect.y + rect.height}
								, {x: currRect.x + currRect.width / 2, y: currRect.y});

					case MainExtension.TILING.BOTTOM:
						return distBetween2Points({x: rect.x + rect.width / 2, y: rect.y}
								, {x: currRect.x + currRect.width / 2, y: currRect.y + currRect.height});

					case MainExtension.TILING.LEFT:
						return distBetween2Points({x: rect.x + rect.width, y: rect.y + rect.height / 2}
								, {x: currRect.x, y: currRect.y + currRect.height / 2});

					case MainExtension.TILING.RIGHT:
						return distBetween2Points({x: rect.x, y: rect.y + rect.height / 2}
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
				case MainExtension.TILING.TOP:
				case MainExtension.TILING.MAXIMIZE:
					if (closests[0].y + closests[0].height === rect.y + rect.height)
						return [...closests, rect];
					else
						return closests[0].y + closests[0].height > rect.y + rect.height
								? closests : [rect];

				case MainExtension.TILING.BOTTOM:
					if (closests[0].y === rect.y)
						return [...closests, rect];
					else
						return closests[0].y < rect.y ? closests : [rect];

				case MainExtension.TILING.LEFT:
					if (closests[0].x + closests[0].width === rect.x + rect.width)
						return [...closests, rect];
					else
						return closests[0].x + closests[0].width > rect.x + rect.width
								? closests : [rect];

				case MainExtension.TILING.RIGHT:
					if (closests[0].x === rect.x)
						return [...closests, rect];
					else
						return closests[0].x < rect.x ? closests : [rect];
			}
		}, []);

		// second: prefer the rect closest to the @currRect's h/v axis
		closestRect = closestRects.reduce((closest, rect) => {
			switch (direction) {
				case MainExtension.TILING.TOP:
				case MainExtension.TILING.MAXIMIZE:
				case MainExtension.TILING.BOTTOM:
					return Math.abs(closest.x - currRect.x) < Math.abs(rect.x - currRect.x) ? closest : rect;

				case MainExtension.TILING.LEFT:
				case MainExtension.TILING.RIGHT:
					return Math.abs(closest.y - currRect.y) < Math.abs(rect.y - currRect.y) ? closest : rect;
			}
		});
	}

	return closestRect;
};

function getBestFitTiledRect(window, topTileGroup = null) {
	if (!window.isTiled) {
		topTileGroup = topTileGroup || getTopTileGroup();
		const freeScreenSpace = getFreeScreenSpace(topTileGroup);
		return freeScreenSpace || window.get_work_area_current_monitor();

	} else {
		// check if the freeScreenRect borders the tiledRect and
		// if the bordering side of the freeScreenRect is bigger than the one of the tiledWindow
		const tileBordersFreeRect = function(freeRect, tiledRect) {
			const v = (freeRect.vert_overlap(tiledRect) && freeRect.y <= tiledRect.y && freeRect.y + freeRect.height >= tiledRect.y + tiledRect.height
					&& (freeRect.x === tiledRect.x + tiledRect.width || freeRect.x + freeRect.width === tiledRect.x));
			const h = (freeRect.horiz_overlap(tiledRect) && freeRect.x <= tiledRect.x && freeRect.x + freeRect.width >= tiledRect.x + tiledRect.width
					&& (freeRect.y === tiledRect.y + tiledRect.height || freeRect.y + freeRect.height === tiledRect.y))
			return v || h;
		}

		topTileGroup = topTileGroup || getTopTileGroup(false);
		const freeSpace = getFreeScreenSpace(topTileGroup);
		const freeScreenRects = freeSpace ? [freeSpace] : getFreeScreenRects(topTileGroup);
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

function getTileRectFor(position, workArea, monitor = null) {
	const topTileGroup = getTopTileGroup(true, monitor);
	const screenRects = topTileGroup.map(w => w.tiledRect).concat(getFreeScreenRects(topTileGroup));

	let width, height, rect;
	switch (position) {
		case MainExtension.TILING.MAXIMIZE:
			return workArea;

		case MainExtension.TILING.LEFT:
			rect = screenRects.find(r => r.x === workArea.x && r.width !== workArea.width);
			width = rect ? rect.width : Math.ceil(workArea.width / 2);
			return new Meta.Rectangle({x: workArea.x, y: workArea.y, width, height: workArea.height});

		case MainExtension.TILING.RIGHT:
			rect = screenRects.find(r => r.x + r.width === workArea.x + workArea.width && r.width !== workArea.width);
			width = rect ? rect.width : Math.ceil(workArea.width / 2);
			return new Meta.Rectangle({x: workArea.x + workArea.width - width, y: workArea.y, width,height: workArea.height});

		case MainExtension.TILING.TOP:
			rect = screenRects.find(r => r.y === workArea.y && r.height !== workArea.height);
			height = rect ? rect.height : Math.ceil(workArea.height / 2);
			return new Meta.Rectangle({x: workArea.x, y: workArea.y, width: workArea.width, height});

		case MainExtension.TILING.BOTTOM:
			rect = screenRects.find(r => r.y + r.height === workArea.y + workArea.height && r.height !== workArea.height);
			height = rect ? rect.height : Math.ceil(workArea.height / 2);
			return new Meta.Rectangle({x: workArea.x, y: workArea.y + workArea.height - height, width: workArea.width, height});

		case MainExtension.TILING.TOP_LEFT:
			rect = screenRects.find(r => r.x === workArea.x && r.width !== workArea.width);
			width = rect ? rect.width : Math.ceil(workArea.width / 2);
			rect = screenRects.find(r => r.y === workArea.y && r.height !== workArea.height);
			height = rect ? rect.height : Math.ceil(workArea.height / 2);
			return new Meta.Rectangle({x: workArea.x, y: workArea.y, width, height: height});

		case MainExtension.TILING.TOP_RIGHT:
			rect = screenRects.find(r => r.x + r.width === workArea.x + workArea.width && r.width !== workArea.width);
			width = rect ? rect.width : Math.ceil(workArea.width / 2);
			rect = screenRects.find(r => r.y === workArea.y && r.height !== workArea.height);
			height = rect ? rect.height : Math.ceil(workArea.height / 2);
			return new Meta.Rectangle({x: workArea.x + workArea.width - width, y: workArea.y, width, height});

		case MainExtension.TILING.BOTTOM_LEFT:
			rect = screenRects.find(r => r.x === workArea.x && r.width !== workArea.width);
			width = rect ? rect.width : Math.ceil(workArea.width / 2);
			rect = screenRects.find(r => r.y + r.height === workArea.y + workArea.height && r.height !== workArea.height);
			height = rect ? rect.height : Math.ceil(workArea.height / 2);
			return new Meta.Rectangle({x: workArea.x, y: workArea.y + workArea.height - height, width, height});

		case MainExtension.TILING.BOTTOM_RIGHT:
			rect = screenRects.find(r => r.x + r.width === workArea.x + workArea.width && r.width !== workArea.width);
			width = rect ? rect.width : Math.ceil(workArea.width / 2);
			rect = screenRects.find(r => r.y + r.height === workArea.y + workArea.height && r.height !== workArea.height);
			height = rect ? rect.height : Math.ceil(workArea.height / 2);
			return new Meta.Rectangle({x: workArea.x + workArea.width - width, y: workArea.y + workArea.height - height, width, height});
	}
};

function toggleTileState(window, tileRect) {
	const workArea = window.get_work_area_current_monitor();
	(window.isTiled && tileRect.equal(window.tiledRect)) || (tileRect.equal(workArea) && windowIsMaximized(window))
			? restoreWindowSize(window) : tileWindow(window, tileRect);
};

function tileWindow(window, newRect, openTilingPopup = true, skipAnim = false) {
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
	dissolveTileGroupFor(window);

	const oldRect = window.get_frame_rect();
	const gap = MainExtension.settings.get_int("window-gap");
	const workArea = window.get_work_area_for_monitor(window.get_monitor());
	const maximize = newRect.equal(workArea);

	window.isTiled = !maximize;
	if (!window.untiledRect)
		window.untiledRect = oldRect;

	if (maximize && (!gap || !MainExtension.settings.get_boolean("maximize-with-gap"))) {
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
	// lessen gap by half when the window isn't on the left or the right edge of the screen respectively
	const width = newRect.width - (2 * gap - (workArea.x === newRect.x ? 0 : gap / 2) - (workArea.x + workArea.width === newRect.x + newRect.width ? 0 : gap / 2));
	const height = newRect.height - (2 * gap - (workArea.y === newRect.y ? 0 : gap / 2) - (workArea.y + workArea.height === newRect.y + newRect.height ? 0 : gap / 2));

	// animations
	if (MainExtension.settings.get_boolean("enable-tile-animations") && !skipAnim) {
		const wActor = window.get_compositor_private();
		const onlyMove = oldRect.width === width && oldRect.height === height;
		if (onlyMove) { // custom anim because they dont exist
			const clone = new St.Widget({
				content: Shell.util_get_content_for_window_actor(wActor, oldRect),
				x: oldRect.x, y: oldRect.y, width: oldRect.width, height: oldRect.height
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
			// hack => journalctl: error in size change accounting; SizeChange flag?
			main.wm._prepareAnimationInfo(global.window_manager, wActor, oldRect, Meta.SizeChange.MAXIMIZE);
		}
	}

	// Wayland workaround because some apps dont work properly e. g. tiling Nautilus and then choosing firefox from the popup
	Meta.is_wayland_compositor() && window.move_frame(false, x, y);
	// user_op as false needed for some apps
	window.move_resize_frame(false, x, y, width, height);

	if (maximize)
		return;

	// setup (new) tileGroup to raise tiled windows as a group
	const topTileGroup = getTopTileGroup(false);
	updateTileGroup(topTileGroup);

	openTilingPopup && tryOpeningTilingPopup();
};

function tryOpeningTilingPopup() {
	if (!MainExtension.settings.get_boolean("enable-tiling-popup"))
		return;

	const openWindows = getOpenWindows(MainExtension.settings.get_boolean("tiling-popup-current-workspace-only"));
	const topTileGroup = getTopTileGroup(false);
	topTileGroup.forEach(w => openWindows.splice(openWindows.indexOf(w), 1));
	if (!openWindows.length)
		return;

	const freeScreenSpace = getFreeScreenSpace(topTileGroup);
	if (!freeScreenSpace)
		return;

	const tilingPopup = new TilingPopup.TilingSwitcherPopup(openWindows, freeScreenSpace);
	if (!tilingPopup.show(topTileGroup))
		tilingPopup.destroy();
};

// last 2 params are used for restoring the window size via DND
function restoreWindowSize(window, restoreFullPos = true, grabXCoord = undefined, skipAnim = false) {
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
	if (!wasMaximized && !skipAnim && MainExtension.settings.get_boolean("enable-untile-animations"))
		main.wm._prepareAnimationInfo(global.window_manager, window.get_compositor_private(), window.get_frame_rect(), Meta.SizeChange.UNMAXIMIZE);

	const oldRect = window.untiledRect;
	if (restoreFullPos) { // via keybinding
		// user_op as false to restore window while keeping it fully in screen in case DND-tiling dragged it offscreen
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

	dissolveTileGroupFor(window);
	window.isTiled = false;
	window.tiledRect = null;
	window.untiledRect = null;
};

// raise tiled windows in a group:
// each window saves its own tileGroup and raises the other windows, if it's raised.
// this allows one window to be part of multiple groups
function updateTileGroup(tileGroup) {
	tileGroup.forEach(window => {
		window.tileGroup = tileGroup;
		window.groupRaiseId && window.disconnect(window.groupRaiseId);
		window.groupRaiseId = window.connect("raised", raisedWindow => {
			if (MainExtension.settings.get_boolean("enable-raise-tile-group")) {
				raisedWindow.tileGroup.forEach(w => {
					// disconnect the raise signal first, so we don't end up
					// in an infinite loop of windows raising each other
					if (w.groupRaiseId) {
						w.disconnect(w.groupRaiseId);
						w.groupRaiseId = 0;
					}
					w.raise();
				});

				// re-raise the just raised window so it may not be below other tiled window
				// otherwise when untiling via keyboard it may be below other tiled windows
				raisedWindow.raise();
			}

			// update the tileGroup (and reconnect the raised signals) to allow windows to be part of multiple tileGroups:
			// for ex.: tiling a window over another tiled window will replace the overlapped window in the old tileGroup
			// but the overlapped window will remember its old tile group to raise them as well, if it is raised
			updateTileGroup(raisedWindow.tileGroup);
		});

		window.unmanagingDissolvedId && window.disconnect(window.unmanagingDissolvedId);
		window.unmanagingDissolvedId = window.connect("unmanaging", w => dissolveTileGroupFor(w));
	});
};

// delete the tileGroup of @window for group-raising and
// remove the @window from the tileGroup of other tiled windows
function dissolveTileGroupFor(window) {
	if (window.groupRaiseId) {
		window.disconnect(window.groupRaiseId);
		window.groupRaiseId = 0;
	}

	if (window.unmanagingDissolvedId) {
		window.disconnect(window.unmanagingDissolvedId);
		window.unmanagingDissolvedId = 0;
	}

	if (!window.tileGroup)
		return;

	window.tileGroup.forEach(otherWindow => {
		const idx = otherWindow.tileGroup.indexOf(window);
		idx !== -1 && otherWindow.tileGroup.splice(idx, 1);
	});

	window.tileGroup = null;
};

function openAppTiled(app, rect, tryOpeningPopup = false) {
	if (!app.can_open_new_window())
		return;

	let sId = global.display.connect("window-created", (display, window) => {
		const disconnectWindowCreateSignal = () => {
			global.display.disconnect(sId);
			sId = 0;
		};

		const firstFrameId = window.get_compositor_private().connect("first-frame", () => {
			window.get_compositor_private().disconnect(firstFrameId);
			const openedWindowApp = Shell.WindowTracker.get_default().get_window_app(window);
			// check, if the created window is from the app and if it allows to be moved and resized
			// because (for example) Steam uses a WindowType.Normal window for their loading screen,
			// which we don't want to trigger the tiling for
			if (sId && openedWindowApp && openedWindowApp === app
					&& ((window.allows_resize() && window.allows_move()) || window.get_maximized())) {
				disconnectWindowCreateSignal();
				tileWindow(window, rect, tryOpeningPopup, true);
			}
		});

		// don't immediately disconnect the signal in case the launched window doesn't match the original app
		// since it may be a loading screen or the user started an app inbetween etc... (see above)
		// but in case the check above fails disconnect signal after 1 min at the latest
		GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60000, () => {
			sId && disconnectWindowCreateSignal();
			return GLib.SOURCE_REMOVE;
		});
	});
	app.open_new_window(-1);
};

function ___debugShowTiledRects() {
	const topTileGroup = getTopTileGroup(false);
	if (!topTileGroup.length) {
		main.notify("Tiling Assistant", "No tiled windows / tiled rects")
		return null;
	}

	const indicators = [];
	topTileGroup.forEach(w => {
		const indicator = new St.Widget({
			style_class: "tile-preview",
			opacity: 160,
			x: w.tiledRect.x, y: w.tiledRect.y,
			width: w.tiledRect.width, height: w.tiledRect.height
		});
		main.uiGroup.add_child(indicator);
		indicators.push(indicator);
	});

	return indicators;
};

function ___debugShowFreeScreenRects() {
	const topTileGroup = getTopTileGroup(false);
	const freeScreenRects = getFreeScreenRects(topTileGroup);
	const freeScreenSpace = getFreeScreenSpace(topTileGroup);
	const rects = freeScreenSpace ? [freeScreenSpace] : freeScreenRects;

	const indicators = [];
	rects.forEach(rect => {
		const indicator = new St.Widget({
			style_class: "tile-preview",
			x: rect.x, y: rect.y,
			width: rect.width, height: rect.height
		});
		main.uiGroup.add_child(indicator);
		indicators.push(indicator);
	});

	return indicators.length ? indicators : null;
};
