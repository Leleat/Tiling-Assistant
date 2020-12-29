'use strict';

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
    let samePos = equalApprox(r1.x, r2.x, 15) && equalApprox(r1.y, r2.y, 15);
    let sameSize = equalApprox(r1.width, r2.width, 15) && equalApprox(r1.height, r2.height, 15);
    return samePos && sameSize;
};

// given rectA and rectB, calculate the rectangles which remain from rectA, 
// if rectB is substracted from it. The result is an array of 0 - 4 rects depending on rectA/Bs position.
// ignore small rects since some windows (e. g. some Terminals) dont freely resize
// https://en.wikibooks.org/wiki/Algorithm_Implementation/Geometry/Rectangle_difference
function rectDiff (rectA, rectB, ignoreMargin = 15) {
    let resultRects = [];

    // top rect
    let topRect_height = rectB.y - rectA.y;
	if (topRect_height > ignoreMargin && rectA.width > ignoreMargin)
		resultRects.push(new Meta.Rectangle({x: rectA.x, y: rectA.y, width: rectA.width, height: topRect_height}));

    // bottom rect
    let rectB_y2 = rectB.y + rectB.height;
    let bottomRect_height = rectA.height - (rectB_y2 - rectA.y);
    if (bottomRect_height > ignoreMargin && rectB_y2 < rectA.y + rectA.height && rectA.width > ignoreMargin)
		resultRects.push(new Meta.Rectangle({x: rectA.x, y: rectB_y2, width: rectA.width, height: bottomRect_height}));

    let rectA_y2 = rectA.y + rectA.height;
    let sideRects_y = (rectB.y > rectA.y) ? rectB.y : rectA.y;
    let sideRects_y2 = (rectB_y2 < rectA_y2) ? rectB_y2 : rectA_y2;
    let sideRects_height = sideRects_y2 - sideRects_y;

    // left rect
    let leftRect_width = rectB.x - rectA.x;
    if (leftRect_width > ignoreMargin && sideRects_height > ignoreMargin)
		resultRects.push(new Meta.Rectangle({x: rectA.x, y: sideRects_y, width: leftRect_width, height: sideRects_height}));

    // right rect
    let rectB_x2 = rectB.x + rectB.width;
    let rightRect_width = rectA.width - (rectB_x2 - rectA.x);
    if (rightRect_width > ignoreMargin && sideRects_height > ignoreMargin)
		resultRects.push(new Meta.Rectangle({x: rectB_x2, y: sideRects_y, width: rightRect_width, height: sideRects_height}));

    return resultRects;
};

// get the top most tiled windows which are in a group (window list by stack order: top -> bottom)
function getTopTileGroup(openWindows = null, ignoreTopWindow = true) {
	if (openWindows == null) {
		let activeWS = global.workspace_manager.get_active_workspace()
		openWindows = global.display.sort_windows_by_stacking(activeWS.list_windows()).reverse();
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
	
	removeFromTileGroup(window);

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
			
		// setting user_op to false helps with issues on terminals
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

	removeFromTileGroup(window);
	window.isTiled = null;
	window.tiledRect = null;
};

// raise tiled windows in a group:
// each window saves its own tileGroup and 
// raises the other windows, if it is focused
function updateTileGroup(tileGroup) {
	tileGroup.forEach(w => {
		if (w.groupFocusSignalID)
			w.disconnect(w.groupFocusSignalID);

		w.tileGroup = tileGroup;

		w.groupFocusSignalID = w.connect("focus", () => {
			if (!w.tileGroup || w.get_maximized() == Meta.MaximizeFlags.BOTH || (w.isTiled && w.tiledRect.equal(w.get_work_area_current_monitor())))
				return;
			
			w.tileGroup.forEach(ww => {
				if (ww && ww.isTiled && ww.get_maximized() != Meta.MaximizeFlags.BOTH && !ww.tiledRect.equal(ww.get_work_area_current_monitor())) {
					// update the tileGroup with the current tileGroup (in case of focusing a non-group but tiled window, which replaces a grouped window)
					ww.tileGroup = w.tileGroup;
					ww.raise();
				}
			});
		});
	});
};

// delete the tileGroup of "window" for group-raising and
// remove the "window" from the tileGroup of other tiled windows
function removeFromTileGroup(window) {
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
	let resizeHeightDiff = resizedWindow.preGrabHeight - resizedRect.height;
	let resizeWidthDiff = resizedWindow.preGrabWidth - resizedRect.width;
	let sameSideWindows = resizedWindow.sameSideWindows;
	let opposingWindows = resizedWindow.opposingWindows;

	switch (grabOp) {
		case Meta.GrabOp.RESIZING_N:

			sameSideWindows.forEach(w => {
				let wRect = w.get_frame_rect();
				w.move_resize_frame(false, wRect.x, resizedRect.y, wRect.width, w.preGrabHeight - resizeHeightDiff);
			});

			opposingWindows.forEach(w => {
				let wRect = w.get_frame_rect();
				w.move_resize_frame(false, wRect.x, wRect.y, wRect.width, w.preGrabHeight + resizeHeightDiff - 2 * 2 * gap);
			});
			break;

		case Meta.GrabOp.RESIZING_S:
			sameSideWindows.forEach(w => {
				let wRect = w.get_frame_rect();
				w.move_resize_frame(false, wRect.x, wRect.y, wRect.width, w.preGrabHeight - resizeHeightDiff);
			});

			opposingWindows.forEach(w => {
				let wRect = w.get_frame_rect();
				w.move_resize_frame(false, wRect.x, resizedRect.y + resizedRect.height + 2 * gap, wRect.width, w.preGrabHeight + resizeHeightDiff - 2 * 2 * gap);
			});
			break;

		case Meta.GrabOp.RESIZING_E:
			sameSideWindows.forEach(w => {
				let wRect = w.get_frame_rect();
				w.move_resize_frame(false, wRect.x, wRect.y, w.preGrabWidth - resizeWidthDiff, wRect.height);
			});

			opposingWindows.forEach(w => {
				let wRect = w.get_frame_rect();
				w.move_resize_frame(false, resizedRect.x + resizedRect.width + 2 * gap, wRect.y, w.preGrabWidth + resizeWidthDiff - 2 * 2 * gap, wRect.height);
			});
			break;

		case Meta.GrabOp.RESIZING_W:
			sameSideWindows.forEach(w => {
				let wRect = w.get_frame_rect();
				w.move_resize_frame(false, resizedRect.x, wRect.y, w.preGrabWidth - resizeWidthDiff, wRect.height);
			});

			opposingWindows.forEach(w => {
				let wRect = w.get_frame_rect();
				w.move_resize_frame(false, wRect.x, wRect.y, w.preGrabWidth + resizedWindow.preGrabWidth - resizedRect.width - 2 * 2 * gap, wRect.height);
			});
	}
};

// called via keybinding:
// tile a window over an existing tiled window
function replaceTiledWindow(window) {
	// get the top tile group and sort them from left -> right and top -> bottom (for the numbering)
	let currTileGroup = getTopTileGroup().sort((w1, w2) => {
		let w1Rect = w1.get_frame_rect();
		let w2Rect = w2.get_frame_rect();

		let xPos = w1Rect.x - w2Rect.x;
		if (xPos)
			return xPos;

		return w1Rect.y - w2Rect.y;
	});
	
	if (!currTileGroup.length)
		return;
	
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

	// create rectangles and Nr labels to display over the tiled windows
	for (let i = 0; i < currTileGroup.length; i++) {
		let wRect = currTileGroup[i].tiledRect;

		let rect = new St.Widget({
			style_class: 'tile-preview',
			x: wRect.x + 10, 
			y: wRect.y + 10,
			opacity: 0,
			width: wRect.width - 2 * 10,
			height: wRect.height - 2 * 10,
		});
		global.window_group.add_child(rect);
		rects.push(rect);
		rect.idx = i;

		rect.ease({
			opacity: 255,
			duration: windowManager.WINDOW_ANIMATION_TIME,
			mode: Clutter.AnimationMode.EASE_OUT_QUAD
		});

		let label = new St.Label({
			x: wRect.x + wRect.width / 2,
			y: wRect.y + wRect.height / 2,
			text: (i + 1).toString(),
			style: 'font-size: 50px'
		});
		global.window_group.add_child(label);
		actors.push(label);
	}

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
	let sID = catcher.connect("key-press-event", (src, event) => {
		catcher.disconnect(sID);
		
		let nrKey = parseInt(event.get_key_unicode());

		if (Number.isInteger(nrKey) && nrKey <= currTileGroup.length)
			tileWindow(window, currTileGroup[nrKey - 1].tiledRect);

		destroyAll();
	});

	// tile via mouse click
	let signalID = catcher.connect("button-press-event", (src, event) => {
		catcher.disconnect(signalID);
		
		let [mX, mY] = event.get_coords();
		for(let i = 0; i < rects.length; i++) {
			let r = rects[i]
			if (mX > r.x && mX < r.x + r.width && mY > r.y && mY < r.y + r.height) {
				tileWindow(window, currTileGroup[r.idx].tiledRect);
				break;
			}
		}
		
		destroyAll();
	});
};
