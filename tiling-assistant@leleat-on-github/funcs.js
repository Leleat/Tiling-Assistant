"use strict";

const {main, windowManager} = imports.ui;
const {GLib, St, Shell, Clutter, Meta} = imports.gi;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const MyExtension = Me.imports.extension

function equalApprox(value, value2, margin) {
	if (value >= value2 - margin && value <= value2 + margin)
		return true;
	return false;
};

function rectsAreAboutEqual (r1, r2) {
	if (!r1 || !r2)
		return false;

    let samePos = equalApprox(r1.x, r2.x, 15) && equalApprox(r1.y, r2.y, 15);
    let sameSize = equalApprox(r1.width, r2.width, 15) && equalApprox(r1.height, r2.height, 15);
    return samePos && sameSize;
};

function rectHasPoint(rect, point) {
	return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
};

// given rectA and rectB, calculate the rectangles which remain from rectA, 
// if rectB is substracted from it. The result is an array of 0 - 4 rects depending on rectA/B's position.
// https://en.wikibooks.org/wiki/Algorithm_Implementation/Geometry/Rectangle_difference (Java implementation)
// they implemented it in a way, which gives the top and bottom rect dimensions higher priority than the left and right rect.
// I've simplified it a bit and added the option to do it the other way around depending on the monitor orientation.
// additionally, ignore small rects since some windows (some Terminals) dont freely resize
function rectDiff (rectA, rectB, ignoreMargin = 15) {
	let resultRects = [];

	let displayRect = global.display.get_monitor_geometry(global.display.get_current_monitor());
	let wideScreen = displayRect.width > displayRect.height * .9; // put more weight on width

	// prioritize side rects
	if (wideScreen) {
		// left rect
		let leftRect_width = rectB.x - rectA.x;
		if (leftRect_width > ignoreMargin && rectA.height > ignoreMargin)
			resultRects.push(new Meta.Rectangle({x: rectA.x, y: rectA.y, width: leftRect_width, height: rectA.height}));

		// right rect
		let rectA_x2 = rectA.x + rectA.width;
		let rectB_x2 = rectB.x + rectB.width;
		let rightRect_width = rectA_x2 - rectB_x2;
		if (rightRect_width > ignoreMargin && rectA.height > ignoreMargin)
			resultRects.push(new Meta.Rectangle({x: rectB_x2, y: rectA.y, width: rightRect_width, height: rectA.height}));

		let sideRects_x = (rectB.x > rectA.x) ? rectB.x : rectA.x;
		let sideRects_x2 = (rectB_x2 < rectA_x2) ? rectB_x2 : rectA_x2;
		let sideRects_width = sideRects_x2 - sideRects_x;

		// top rect
		let topRect_height = rectB.y - rectA.y;
		if (topRect_height > ignoreMargin && sideRects_width > ignoreMargin)
			resultRects.push(new Meta.Rectangle({x: sideRects_x, y: rectA.y, width: sideRects_width, height: topRect_height}));

		// bottom rect
		let rectA_y2 = rectA.y + rectA.height;
		let rectB_y2 = rectB.y + rectB.height;
		let bottomRect_height = rectA_y2 - rectB_y2;
		if (bottomRect_height > ignoreMargin && sideRects_width > ignoreMargin)
			resultRects.push(new Meta.Rectangle({x: sideRects_x, y: rectB_y2, width: sideRects_width, height: bottomRect_height}));

	// prioritize top and bottom rect
	// mostly from the link mentioned above
	} else {
		// top rect
		let topRect_height = rectB.y - rectA.y;
		if (topRect_height > ignoreMargin && rectA.width > ignoreMargin)
			resultRects.push(new Meta.Rectangle({x: rectA.x, y: rectA.y, width: rectA.width, height: topRect_height}));
	
		// bottom rect
		let rectA_y2 = rectA.y + rectA.height;
		let rectB_y2 = rectB.y + rectB.height;
		let bottomRect_height = rectA_y2 - rectB_y2;
		if (bottomRect_height > ignoreMargin && rectA.width > ignoreMargin)
			resultRects.push(new Meta.Rectangle({x: rectA.x, y: rectB_y2, width: rectA.width, height: bottomRect_height}));
	
		let sideRects_y = (rectB.y > rectA.y) ? rectB.y : rectA.y;
		let sideRects_y2 = (rectB_y2 < rectA_y2) ? rectB_y2 : rectA_y2;
		let sideRects_height = sideRects_y2 - sideRects_y;
	
		// left rect
		let leftRect_width = rectB.x - rectA.x;
		if (leftRect_width > ignoreMargin && sideRects_height > ignoreMargin)
			resultRects.push(new Meta.Rectangle({x: rectA.x, y: sideRects_y, width: leftRect_width, height: sideRects_height}));
	
		// right rect
		let rectA_x2 = rectA.x + rectA.width;
		let rectB_x2 = rectB.x + rectB.width;
		let rightRect_width = rectA_x2 - rectB_x2;
		if (rightRect_width > ignoreMargin && sideRects_height > ignoreMargin)
			resultRects.push(new Meta.Rectangle({x: rectB_x2, y: sideRects_y, width: rightRect_width, height: sideRects_height}));	
	}

    return resultRects;
};

function getOpenWindows() {
	let activeWS = global.workspace_manager.get_active_workspace()
	return global.display.sort_windows_by_stacking(activeWS.list_windows()).reverse();
}

// get the top most tiled windows which are in a group (window list by stack order: top -> bottom)
function getTopTileGroup(openWindows = null, ignoreTopWindow = true) {
	if (openWindows == null) {
		openWindows = getOpenWindows();
	}

	let groupedWindows = []; // tiled windows which are considered in a group
	let notGroupedWindows = []; // normal and tiled windows which appear between grouped windows in the stack order
	let currMonitor = ((ignoreTopWindow) ? global.display.get_current_monitor() : openWindows[0].get_monitor()); // ignore the topmost window if DNDing, Tiling via keybinding and opening a window in a tiled state
	let groupedWindowsArea = 0;

	for (let i = (ignoreTopWindow) ? 1 : 0, len = openWindows.length; i < len; i++) {
		let window = openWindows[i];

		if (window.get_monitor() != currMonitor)
			continue;

		if (window.isTiled) {
			let workArea = window.get_work_area_current_monitor();
			let wRect = window.tiledRect;

			// window is fully maxmized, so all windows below it cant belong to this group
			if (window.get_maximized() == Meta.MaximizeFlags.BOTH || wRect.equal(workArea))
				break;

			// the grouped windows fill the entire screen, so no more new grouped windows possible
			if (groupedWindowsArea >= workArea.area())
				break;

			let notInGroup = false;

			// if a non-tiled window in a higher stack order overlaps the currently tested tiled window, 
			// the currently tested tiled window isnt part of the topmost tile group
			for (let j = 0, l = notGroupedWindows.length; j < l; j++) {
				let nW = notGroupedWindows[j];
				let nWR = (nW.isTiled) ? nW.tiledRect : nW.get_frame_rect();
				if (nWR.overlap(wRect)) {
					notInGroup = true;
					break;
				}
			}

			if (!notInGroup)
				// same for for tiled windows which are overlapped by tiled windows in a higher stack order
				for (let j = 0, ln = groupedWindows.length; j < ln; j++)
					if (groupedWindows[j].tiledRect.overlap(wRect)) {
						notInGroup = true;
						notGroupedWindows.push(window);
						break;
					}

			if (!notInGroup) {
				groupedWindows.push(window);
				groupedWindowsArea += wRect.area();
			}

		} else {
			notGroupedWindows.push(window);
		}
	}

	return groupedWindows;
};

// returns an array of rectangles which represent the free screen space. 
// Steps:
// first get the free screen space for each tiled window by itself (for each window 1 array of rects)
// the final freeScreenRects array is the intersection of all these arrays
function getFreeScreenRects(tileGroup) {
	let freeScreenRects = [];
	let entireWorkArea = (tileGroup.length) ? tileGroup[0].get_work_area_current_monitor() : global.workspace_manager.get_active_workspace().get_work_area_for_monitor(global.display.get_current_monitor());
	freeScreenRects.push(entireWorkArea);

	// get free sreen rects for each tiled window individually
	let freeScreenForWindows = [];
	tileGroup.forEach(w => {
		let diffRects = rectDiff(entireWorkArea, w.tiledRect);
		freeScreenForWindows.push(diffRects);
	});

	// get the final freeScreenRects by intersecting all individual (/for each window) free screen rects
	freeScreenForWindows.forEach(singleFreeScreenRects => {
		let intersections = [];

		for (let i = 0, l = singleFreeScreenRects.length; i < l; i++) {
			let freeRect = singleFreeScreenRects[i];

			for (let j = 0, len = freeScreenRects.length; j < len; j++) {
				let [doIntersect, intersecRec] = freeScreenRects[j].intersect(freeRect);
				if (doIntersect)
					intersections.push(intersecRec);
			}
		}

		freeScreenRects = intersections;
	});
	
	return freeScreenRects;
};

// get the tile rect for a side (screen half/quarter).
// the rect tries to fit the available free screen space 
// (i. e. if the tiling side == Left and only left quarter is free, the rect will be the standard rect for the left side).
// this is used when DNDing a window or when pressing a keyboard shortcut for tiling
function getTileRectForSide(side, workArea) {
	let width = 0;
	let height = 0;

	let freeScreenRects = getFreeScreenRects(getTopTileGroup());
	let rectCount = freeScreenRects.length;
	let rUnion;

	switch (side) {
		case Meta.Side.LEFT:
			// union for the freeScreenRects in case the right half consists of quartered windows
			rUnion = new Meta.Rectangle({x: workArea.x, y: workArea.y});
			freeScreenRects.forEach(r => {
				if (r.x == workArea.x) {
					if (r.width == workArea.width)
						r.width = rUnion.width;

					rUnion = rUnion.union(r);
				}
			});
			
			if (rUnion.x == workArea.x && rUnion.y == workArea.y && rUnion.height == workArea.height && rUnion.width != workArea.width)
				width = rUnion.width;
			
			if (width < 200)
				width = workArea.width / 2;

			return new Meta.Rectangle({
				x: workArea.x,
				y: workArea.y,
				width: width,
				height: workArea.height,
			});

		case Meta.Side.RIGHT:		
			// union for the freeScreenRects in case the left half consists of quartered windows
			rUnion = new Meta.Rectangle({x: workArea.x + workArea.width, y: workArea.y});
			freeScreenRects.forEach(r => {
				if (r.x + r.width == workArea.x + workArea.width) {
					if (r.x == workArea.x) {
						r.width = 0;
						r.x = rUnion.x;
					}

					rUnion = rUnion.union(r);
				}
			});

			if (rUnion.x + rUnion.width == workArea.x + workArea.width && rUnion.height == workArea.height && rUnion.width != workArea.width)
				width = rUnion.width;

			if (width < 200)
				width = workArea.width / 2;

			return new Meta.Rectangle({
				x: workArea.x + workArea.width - width,
				y: workArea.y,
				width: width,
				height: workArea.height,
			});

		case Meta.Side.TOP:
			// union for the freeScreenRects in case the bottom half consists of quartered windows
			rUnion = new Meta.Rectangle({x: workArea.x, y: workArea.y});
			freeScreenRects.forEach(r => {
				if (r.y == workArea.y) {
					if (r.height == workArea.height)
						r.height = rUnion.height;

					rUnion = rUnion.union(r);
				}
			});
			
			if (rUnion.x == workArea.x && rUnion.y == workArea.y && rUnion.height != workArea.height && rUnion.width == workArea.width)
				height = rUnion.height;

			if (height < 200)
				height = workArea.height / 2;

			return new Meta.Rectangle({
				x: workArea.x,
				y: workArea.y,
				width: workArea.width,
				height: height,
			});

		case Meta.Side.BOTTOM:
			// union for the freeScreenRects in case the top half consists of quartered windows
			rUnion = new Meta.Rectangle({x: workArea.x, y: workArea.y + workArea.height});
			freeScreenRects.forEach(r => {
				if (r.y + r.height == workArea.y + workArea.height) {
					if (r.y == workArea.y) {
						r.height = 0;
						r.y = rUnion.y;
					}

					rUnion = rUnion.union(r);
				}
			});
			
			if (rUnion.x == workArea.x && rUnion.y + rUnion.height == workArea.y + workArea.height && rUnion.height != workArea.height && rUnion.width == workArea.width)
				height = rUnion.height;

			if (height < 200)
				height = workArea.height / 2;

			return new Meta.Rectangle({
				x: workArea.x,
				y: workArea.y + workArea.height - height,
				width: workArea.width,
				height: height,
			});

		case Meta.Side.TOP + Meta.Side.LEFT:
			for (let i = 0; i < rectCount; i++) {
				let rect = freeScreenRects[i];

				if (rect.x == workArea.x && rect.y == workArea.y) {
					if (rect.width != workArea.width)
						width = rect.width;
					if (rect.height != workArea.height)
						height = rect.height;

					break;
				}
			}

			if (width < 200)
				width = workArea.width / 2;

			if (height < 200)
				height = workArea.height / 2;

			return new Meta.Rectangle({
				x: workArea.x,
				y: workArea.y,
				width: width,
				height: height,
			});

		case Meta.Side.TOP + Meta.Side.RIGHT:
			for (let i = 0; i < rectCount; i++) {
				let rect = freeScreenRects[i];

				if (rect.x + rect.width == workArea.x + workArea.width && rect.y == workArea.y) {
					if (rect.width != workArea.width)
						width = rect.width;
					if (rect.height != workArea.height)
						height = rect.height;
						
					break;
				}
			}

			if (width < 200)
				width = workArea.width / 2;

			if (height < 200)
				height = workArea.height / 2;

			return new Meta.Rectangle({
				x: workArea.x + workArea.width - width,
				y: workArea.y,
				width: width,
				height: height,
			});

		case Meta.Side.BOTTOM + Meta.Side.LEFT:
			for (let i = 0; i < rectCount; i++) {
				let rect = freeScreenRects[i];

				if (rect.x == workArea.x && rect.y + rect.height == workArea.y + workArea.height) {
					if (rect.width != workArea.width)
						width = rect.width;
					if (rect.height != workArea.height)
						height = rect.height;
						
					break;
				}
			}

			if (width < 200)
				width = workArea.width / 2;

			if (height < 200)
				height = workArea.height / 2;

			return new Meta.Rectangle({
				x: workArea.x,
				y: workArea.y + workArea.height - height,
				width: width,
				height: height,
			});

		case Meta.Side.BOTTOM + Meta.Side.RIGHT:
			for (let i = 0; i < rectCount; i++) {
				let rect = freeScreenRects[i];

				if (rect.x + rect.width == workArea.x + workArea.width && rect.y + rect.height == workArea.y + workArea.height) {
					if (rect.width != workArea.width)
						width = rect.width;
					if (rect.height != workArea.height)
						height = rect.height;
						
					break;
				}
			}

			if (width < 200)
				width = workArea.width / 2;

			if (height < 200)
				height = workArea.height / 2;

			return new Meta.Rectangle({
				x: workArea.x + workArea.width - width,
				y: workArea.y + workArea.height - height,
				width: width,
				height: height,
			});
	}
};

function tileWindow(window, newRect, checkToOpenDash = true) {
	if (!window)
		return;

	let wasMaximized = window.get_maximized();
	if (wasMaximized)
		window.unmaximize(window.get_maximized());

	if (!window.allows_resize() || !window.allows_move())
		return;

	// sometimes, because of the group-focusing (raising),
	// the focused window will be below another window.
	// so we raise the focused window to prevent unexpected behaviour and bugs
	window.raise();

	let oldRect = window.get_frame_rect();
	if (!window.isTiled)
		window.isTiled = oldRect;
	
	// save the actual window rect without gaps and disregarding the actual window size for more acurate operations later.
	// it helps with some terminals (or other windows) which cant be resized freely / which only resize in full rows/columns
	// or for falsely opening the Dash when the windows' min size is bigger than newRect
	window.tiledRect = newRect.copy();

	// window gaps & work on a copy
	let rect = newRect.copy();
	let gap = MyExtension.settings.get_int("window-gaps");
	if (gap) {
		rect.x += gap;
		rect.y += gap;
		rect.width -= 2 * gap;
		rect.height -= 2 * gap;
	}

	// animation
	let wActor = window.get_compositor_private();
	let onlyMove = oldRect.width == rect.width && oldRect.height == rect.height;
	if (MyExtension.settings.get_boolean("use-anim")) {
		if (onlyMove) { // custom anim because they dont exist
			let actorContent = Shell.util_get_content_for_window_actor(wActor, oldRect);
			let clone = new St.Widget({
				content: actorContent,
				x: oldRect.x,
				y: oldRect.y,
				width: oldRect.width,
				height: oldRect.height,
			});
			main.uiGroup.add_child(clone);
			wActor.hide();

			clone.ease({
				x: rect.x,
				y: rect.y,
				width: rect.width,
				height: rect.height,
				duration: windowManager.WINDOW_ANIMATION_TIME,
				mode: Clutter.AnimationMode.EASE_OUT_QUAD,
				onComplete: () => {
					wActor.show();
					clone.destroy();
				}
			});

		} else if (wasMaximized) {

		} else {
			// hack => journalctl: error in size change accounting && Old animationInfo removed from actor (second one is rare)
			main.wm._prepareAnimationInfo(global.window_manager, wActor, oldRect, Meta.SizeChange.MAXIMIZE);
		}
	}

	// setting user_op to false helps with issues on terminals
	window.move_resize_frame(false, rect.x, rect.y, rect.width, rect.height);

	if (checkToOpenDash)
		MyExtension.onWindowTiled(window);
};

function maximizeBoth(window) {
	if (!window || !window.allows_move || !window.allows_resize)
		return;
	
	removeTileGroup(window);

	// sometimes, because of the group-focusing (raising),
	// the focused window will be below another window.
	// so we raise the focused window to prevent unexpected behaviour and bugs
	window.raise();
	
	let workArea = window.get_work_area_current_monitor();
	window.tiledRect = workArea;

	// let gap = MyExtension.settings.get_int("window-gaps");
	// if (gap) {
	// 	let rect = new Meta.Rectangle({
	// 		x: workArea.x + gap,
	// 		y: workArea.y + gap,
	// 		width: workArea.width - 2 * gap,
	// 		height: workArea.height - 2 * gap,
	// 	});

	// 	let oldRect = window.get_frame_rect();

	// 	if (!window.isTiled)
	// 		window.isTiled = oldRect;

	// 	if (MyExtension.settings.get_boolean("use-anim"))
	// 		main.wm._prepareAnimationInfo(global.window_manager, window.get_compositor_private(), oldRect, Meta.SizeChange.MAXIMIZE);
			
	// 	// setting user_op to false helps with issues on terminals
	// 	window.move_resize_frame(false, rect.x, rect.y, rect.width, rect.height);

	// } else {
		window.maximize(Meta.MaximizeFlags.BOTH);
	// }
};

function restoreWindowSize(window, restoreFullPos = false) {
	if (window.get_maximized())
		window.unmaximize(window.get_maximized());

	if (!window.isTiled || !window.allows_resize() || !window.allows_move())
		return;

	let oldRect = window.isTiled;

	if (restoreFullPos) {
		// user_op as false to restore window while keeping it fully in screen in case DND-tiling dragged it offscreen
		window.move_resize_frame(false, oldRect.x, oldRect.y, oldRect.width, oldRect.height);

	} else { // scale while keeping the top at the same relative y pos (for DNDing)
		let currWindowFrame = window.get_frame_rect();
		let [mouseX] = global.get_pointer();
		let relativeMouseX = (mouseX - currWindowFrame.x) / currWindowFrame.width;
		let newPosX = mouseX - oldRect.width * relativeMouseX;
		
		// user_op with true needed to properly restore big window in the bottom half via DND
		window.move_resize_frame(true, newPosX, currWindowFrame.y, oldRect.width, oldRect.height);
	}

	removeTileGroup(window);
	window.isTiled = null;
	window.tiledRect = null;
};

// raise tiled windows in a group:
// each window saves its own tileGroup and 
// raises the other windows, if it is focused
function updateTileGroup(tileGroup) {
	tileGroup.forEach(w => {
		w.tileGroup = tileGroup;

		if (w.groupFocusSignalID)
			w.disconnect(w.groupFocusSignalID);

		w.groupFocusSignalID = w.connect("focus", () => {
			let workArea = w.get_work_area_current_monitor();
			if (!w.tileGroup || w.get_maximized() == Meta.MaximizeFlags.BOTH || (w.isTiled && rectsAreAboutEqual(w.tiledRect, workArea)))
				return;
			
			w.tileGroup.forEach(ww => {
				if (ww.isTiled && ww.get_maximized() != Meta.MaximizeFlags.BOTH && !rectsAreAboutEqual(ww.tiledRect, workArea)) {
					// update the tileGroup with the current tileGroup (in case of focusing a non-group but tiled window, which replaces a grouped window)
					ww.tileGroup = w.tileGroup;
					ww.raise();
				}
			});
		});

		w.connect("unmanaging", (src) => {
			removeTileGroup(src);
		});
	});
};

// delete the tileGroup of "window" for group-raising and
// remove the "window" from the tileGroup of other tiled windows
function removeTileGroup(window) {
	if (!window.tileGroup)
		return;

	if (window.groupFocusSignalID) {
		window.disconnect(window.groupFocusSignalID);
		window.groupFocusSignalID = 0;
	}
	
	window.tileGroup.forEach(w => {
		if (!w || !w.tileGroup)
			return;

		let idx = w.tileGroup.indexOf(window);
		if (idx != -1)
			w.tileGroup.splice(idx, 1);
	});

	window.tileGroup = null;
};

// resizing via DND:
// sameSideWindows are the windows which are on the same side as the resizedRect based on the drag direction
// e.g. if resizing the top left on the E side, the bottom left window is a sameSideWindow
// opposingWindows are the windows bordering the resized window on the grab side
function resizeComplementingWindows(resizedWindow, grabOp, gap) {
	let resizedRect = resizedWindow.get_frame_rect();
	let sameSideWindows = resizedWindow.sameSideWindows;
	let opposingWindows = resizedWindow.opposingWindows;

	switch (grabOp) {
		case Meta.GrabOp.RESIZING_N:

			sameSideWindows.forEach(w => {
				let wRect = w.get_frame_rect();
				w.move_resize_frame(false, wRect.x, resizedRect.y, wRect.width, w.preGrabY + w.preGrabHeight - resizedRect.y);
			});

			opposingWindows.forEach(w => {
				let wRect = w.get_frame_rect();
				w.move_resize_frame(false, wRect.x, wRect.y, wRect.width, resizedRect.y - wRect.y - 2 * gap);
			});
			break;

		case Meta.GrabOp.RESIZING_S:
			sameSideWindows.forEach(w => {
				let wRect = w.get_frame_rect();
				w.move_resize_frame(false, wRect.x, wRect.y, wRect.width, resizedRect.y + resizedRect.height - wRect.y);
			});

			opposingWindows.forEach(w => {
				let wRect = w.get_frame_rect();
				let _y = resizedRect.y + resizedRect.height + 2 * gap;
				w.move_resize_frame(false, wRect.x, _y, wRect.width, w.preGrabY + w.preGrabHeight - _y);
			});
			break;

		case Meta.GrabOp.RESIZING_E:
			sameSideWindows.forEach(w => {
				let wRect = w.get_frame_rect();
				w.move_resize_frame(false, wRect.x, wRect.y, resizedRect.x + resizedRect.width - wRect.x, wRect.height);
			});

			opposingWindows.forEach(w => {
				let wRect = w.get_frame_rect();
				let _x = resizedRect.x + resizedRect.width + 2 * gap;
				w.move_resize_frame(false, _x, wRect.y, w.preGrabX + w.preGrabWidth - _x, wRect.height);
			});
			break;

		case Meta.GrabOp.RESIZING_W:
			sameSideWindows.forEach(w => {
				let wRect = w.get_frame_rect();
				w.move_resize_frame(false, resizedRect.x, wRect.y, w.preGrabX + w.preGrabWidth - resizedRect.x, wRect.height);
			});

			opposingWindows.forEach(w => {
				let wRect = w.get_frame_rect();
				w.move_resize_frame(false, wRect.x, wRect.y, resizedRect.x - wRect.x - 2 * gap, wRect.height);
			});
	}
};

// called via keybinding:
// tile a window to existing layout of tiled windows below it
function replaceTiledWindow(window) {
	// get the top tile group and sort them from left -> right and top -> bottom
	// for the numbering of the labels
	let currTileGroup = getTopTileGroup().sort((w1, w2) => {
		let w1Rect = w1.get_frame_rect();
		let w2Rect = w2.get_frame_rect();

		let xPos = w1Rect.x - w2Rect.x;
		if (xPos)
			return xPos;

		return w1Rect.y - w2Rect.y;
	});
	
	let wCount = currTileGroup.length;
	if (!wCount)
		return;

	let freeScreenRects = getFreeScreenRects(currTileGroup);
	
	// to later destroy all the actors
	let actors = [];
	let rects = [];

	// dim background
	let entireWorkArea = window.get_work_area_all_monitors();
	let shadeBG = new St.Widget({
		style: ("background-color : black"),
		can_focus: true,
		reactive: true,
		x: 0, 
		y: main.panel.height,
		opacity: 0,
		width: entireWorkArea.width, 
		height: entireWorkArea.height
	});
	global.window_group.add_child(shadeBG);
	actors.push(shadeBG);

	shadeBG.ease({
		opacity: 200,
		duration: windowManager.WINDOW_ANIMATION_TIME,
		mode: Clutter.AnimationMode.EASE_OUT_QUAD,
	});

	// create rectangles and Nr labels to display over the tiled windows and freeScreenRects
	let createRect = function (rect) {
		// preview is slightly smaller than the Rect rect for visibility 
		let previewRect = new St.Widget({
			style_class: "tile-preview",
			x: rect.x + 10, 
			y: rect.y + 10,
			opacity: 0,
			width: rect.width - 2 * 10,
			height: rect.height - 2 * 10,
		});
		global.window_group.add_child(previewRect);
		rects.push(previewRect);

		previewRect.ease({
			opacity: 255,
			duration: windowManager.WINDOW_ANIMATION_TIME,
			mode: Clutter.AnimationMode.EASE_OUT_QUAD
		});

		let label = new St.Label({
			x: rect.x + rect.width / 2,
			y: rect.y + rect.height / 2,
			text: (rects.length).toString(),
			style: "font-size: 50px"
		});
		global.window_group.add_child(label);
		actors.push(label);
	};

	currTileGroup.forEach(w => createRect(w.tiledRect));
	freeScreenRects.forEach(r => createRect(r));

	// add a widget to catch the key inputs and mouse clicks
	let catcher = new St.Widget({
		x: 0, 
		y: 0,
		opacity: 0,
		width: entireWorkArea.width, 
		height: entireWorkArea.height + main.panel.height,
		can_focus: true,
		reactive: true
	});
	main.layoutManager.addChrome(catcher);
	actors.push(catcher);

	let destroyAll = function () {
		rects.forEach(r => r.destroy());
		actors.forEach(a => a.destroy());
	}

	// tile via nr keyboard input
	catcher.grab_key_focus();
	catcher.connect("key-press-event", (src, event) => {
		let key = parseInt(event.get_key_unicode());

		if (Number.isInteger(key) && key > 0) {
			if (key <= wCount)
				tileWindow(window, currTileGroup[key - 1].tiledRect);
			else if (key <= wCount + freeScreenRects.length)
				tileWindow(window, freeScreenRects[key - wCount - 1]);
		}

		destroyAll();
	});

	// tile via mouse click
	catcher.connect("button-press-event", (src, event) => {
		let [mX, mY] = event.get_coords();
		for(let i = 0; i < rects.length; i++) {
			let r = rects[i]
			if (rectHasPoint(r, {x: mX, y: mY})) {
				if (i < wCount)
					tileWindow(window, currTileGroup[i].tiledRect);
				else
					tileWindow(window, freeScreenRects[i - wCount]);
				
				break;
			}
		}
		
		destroyAll();
	});
};
