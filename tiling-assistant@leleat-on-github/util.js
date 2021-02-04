"use strict";

const {main} = imports.ui;
const {Clutter, Meta, Shell, St} = imports.gi;

const MyExtension = imports.misc.extensionUtils.getCurrentExtension().imports.extension;

function equalApprox(value, value2, margin) {
	if (value >= value2 - margin && value <= value2 + margin)
		return true;
	return false;
};

function rectsAreAboutEqual (r1, r2) {
	if (!r1 || !r2)
		return false;

	const samePos = equalApprox(r1.x, r2.x, 15) && equalApprox(r1.y, r2.y, 15);
	const sameSize = equalApprox(r1.width, r2.width, 15) && equalApprox(r1.height, r2.height, 15);
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
function rectDiff (rectA, rectB, ignoreMargin = 35, preferVertical = null) {
	const resultRects = [];
	if (!rectA || !rectB)
		return resultRects;

	const displayRect = global.display.get_monitor_geometry(global.display.get_current_monitor());
	if (preferVertical === null)
		preferVertical = displayRect.width > displayRect.height * .9; // put more weight on width

	// prioritize side rects
	if (preferVertical) {
		// left rect
		const leftRect_width = rectB.x - rectA.x;
		if (leftRect_width > ignoreMargin && rectA.height > ignoreMargin)
			resultRects.push(new Meta.Rectangle({x: rectA.x, y: rectA.y, width: leftRect_width, height: rectA.height}));

		// right rect
		const rectA_x2 = rectA.x + rectA.width;
		const rectB_x2 = rectB.x + rectB.width;
		const rightRect_width = rectA_x2 - rectB_x2;
		if (rightRect_width > ignoreMargin && rectA.height > ignoreMargin)
			resultRects.push(new Meta.Rectangle({x: rectB_x2, y: rectA.y, width: rightRect_width, height: rectA.height}));

		const sideRects_x = (rectB.x > rectA.x) ? rectB.x : rectA.x;
		const sideRects_x2 = (rectB_x2 < rectA_x2) ? rectB_x2 : rectA_x2;
		const sideRects_width = sideRects_x2 - sideRects_x;

		// top rect
		const topRect_height = rectB.y - rectA.y;
		if (topRect_height > ignoreMargin && sideRects_width > ignoreMargin)
			resultRects.push(new Meta.Rectangle({x: sideRects_x, y: rectA.y, width: sideRects_width, height: topRect_height}));

		// bottom rect
		const rectA_y2 = rectA.y + rectA.height;
		const rectB_y2 = rectB.y + rectB.height;
		const bottomRect_height = rectA_y2 - rectB_y2;
		if (bottomRect_height > ignoreMargin && sideRects_width > ignoreMargin)
			resultRects.push(new Meta.Rectangle({x: sideRects_x, y: rectB_y2, width: sideRects_width, height: bottomRect_height}));

	// prioritize top and bottom rect
	// mostly from the link mentioned above
	} else {
		// top rect
		const topRect_height = rectB.y - rectA.y;
		if (topRect_height > ignoreMargin && rectA.width > ignoreMargin)
			resultRects.push(new Meta.Rectangle({x: rectA.x, y: rectA.y, width: rectA.width, height: topRect_height}));

		// bottom rect
		const rectA_y2 = rectA.y + rectA.height;
		const rectB_y2 = rectB.y + rectB.height;
		const bottomRect_height = rectA_y2 - rectB_y2;
		if (bottomRect_height > ignoreMargin && rectA.width > ignoreMargin)
			resultRects.push(new Meta.Rectangle({x: rectA.x, y: rectB_y2, width: rectA.width, height: bottomRect_height}));

		const sideRects_y = (rectB.y > rectA.y) ? rectB.y : rectA.y;
		const sideRects_y2 = (rectB_y2 < rectA_y2) ? rectB_y2 : rectA_y2;
		const sideRects_height = sideRects_y2 - sideRects_y;

		// left rect
		const leftRect_width = rectB.x - rectA.x;
		if (leftRect_width > ignoreMargin && sideRects_height > ignoreMargin)
			resultRects.push(new Meta.Rectangle({x: rectA.x, y: sideRects_y, width: leftRect_width, height: sideRects_height}));

		// right rect
		const rectA_x2 = rectA.x + rectA.width;
		const rectB_x2 = rectB.x + rectB.width;
		const rightRect_width = rectA_x2 - rectB_x2;
		if (rightRect_width > ignoreMargin && sideRects_height > ignoreMargin)
			resultRects.push(new Meta.Rectangle({x: rectB_x2, y: sideRects_y, width: rightRect_width, height: sideRects_height}));
	}

	return resultRects;
};

function getOpenWindows() {
	const openWindows = global.workspace_manager.get_active_workspace().list_windows();
	const orderedOpenWindows = global.display.sort_windows_by_stacking(openWindows).reverse();
	return orderedOpenWindows.filter(w => w.get_window_type() === Meta.WindowType.NORMAL && !w.is_skip_taskbar() && ((w.allows_move() && w.allows_resize()) || w.get_maximized()));
}

// get the top most tiled windows which are in a group (window list by stack order: top -> bottom)
function getTopTileGroup(openWindows = null, ignoreTopWindow = true) {
	if (openWindows === null)
		openWindows = getOpenWindows();

	const groupedWindows = []; // tiled windows which are considered in a group
	const notGroupedWindows = []; // normal and tiled windows which appear between grouped windows in the stack order
	const currMonitor = ((ignoreTopWindow) ? global.display.get_current_monitor() : openWindows[0].get_monitor()); // ignore the topmost window if DNDing, Tiling via keybinding and opening a window in a tiled state
	let groupedWindowsArea = 0;

	for (let i = (ignoreTopWindow) ? 1 : 0; i < openWindows.length; i++) {
		const window = openWindows[i];

		if (window.get_monitor() !== currMonitor)
			continue;

		if (window.isTiled) {
			const workArea = window.get_work_area_current_monitor();
			const wRect = window.tiledRect;

			// window is fully maxmized, so all windows below it cant belong to this group
			if (window.get_maximized() === Meta.MaximizeFlags.BOTH || wRect.equal(workArea))
				break;

			// the grouped windows fill the entire screen, so no more new grouped windows possible
			if (groupedWindowsArea >= workArea.area())
				break;

			let notInGroup = false;

			// if a non-tiled window in a higher stack order overlaps the currently tested tiled window,
			// the currently tested tiled window isnt part of the topmost tile group
			for (const nGW of notGroupedWindows) {
				const nWR = (nGW.isTiled) ? nGW.tiledRect : nGW.get_frame_rect();
				if (nWR.overlap(wRect)) {
					notInGroup = true;
					break;
				}
			}

			if (!notInGroup)
				// same for tiled windows which are overlapped by tiled windows in a higher stack order
				for (const groupedWindow of groupedWindows)
					if (groupedWindow.tiledRect.overlap(wRect)) {
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

// returns an array of rectangles which represent the free screen space. Steps:
// 1. get the free screen space for each tiled window by itself (for each window 1 array of rects)
// 2. the final freeScreenRects array is the intersection of all these arrays
function getFreeScreenRects(tileGroup) {
	const gap = MyExtension.settings.get_int("window-gaps");
	const entireWorkArea = (tileGroup.length) ? tileGroup[0].get_work_area_current_monitor() : global.workspace_manager.get_active_workspace().get_work_area_for_monitor(global.display.get_current_monitor());

	// get freeSreenRects for each tiled window individually
	const freeRectsForWindows = tileGroup.map(w => rectDiff(entireWorkArea, w.tiledRect));
	// get the final freeScreenRects by intersecting all freeScreenRects for each individual window
	return freeRectsForWindows.reduce((freeScreenRects, windowsFreeRects) => {
		const intersections = [];
		for (const windowsFreeRect of windowsFreeRects) {
			for (const rect of freeScreenRects) {
				const [doIntersect, intersectionRect] = rect.intersect(windowsFreeRect);
				if (doIntersect && intersectionRect.width > gap && intersectionRect.height > gap)
					intersections.push(intersectionRect);
			}
		}

		return intersections;

	}, [entireWorkArea]);
};

// this function is used when DNDing a window or when pressing a keyboard shortcut for tiling.
// this tries to "adapt" the final rect size to the screenRects.
// screenRects is an array of the rectangles for the currTileGroup and the freeScreenRects around them
// i. e. together they span the entire monitor
function getTileRectForSide(side, workArea, screenRects) {
	let width = 0;
	let height = 0;

	// sort left -> right + top -> bottom
	screenRects = screenRects.sort((r1, r2) => {
		const xPos = r1.x - r2.x;
		if (xPos)
			return xPos;

		return r1.y - r2.y;
	});

	const gaps = MyExtension.settings.get_int("window-gaps");

	switch (side) {
		case Meta.Side.LEFT:
			// find the rectangles, which line up vertically
			if (screenRects.length > 1) { // 1 => maximized window or no tiled windows
				for (let i = 0; i < screenRects.length; i++) {
					const r = screenRects[i];
					const linedUpRects = [r];

					for (let j = i + 1; j < screenRects.length; j++) {
						const r2 = screenRects[j];
						if (equalApprox(r.x + r.width, r2.x + r2.width, gaps))
							linedUpRects.push(r2);
					}

					const h = linedUpRects.reduce((sumHeight, rect) => sumHeight += rect.height, 0);
					if (equalApprox(h, workArea.height, gaps)) { // rects line up and fill entire screen height
						width = r.x + r.width - workArea.x;
						break;
					}
				}
			}

			if (!width || equalApprox(width, workArea.width, gaps))
				width = workArea.width / 2;

			return new Meta.Rectangle({
				x: workArea.x,
				y: workArea.y,
				width: width,
				height: workArea.height,
			});

		case Meta.Side.RIGHT:
			// find the rectangles, which line up vertically
			if (screenRects.length > 1) { // 1 => maximized window or no tiled windows
				const scr = [...screenRects];
				scr.reverse();
				for (let i = 0; i < scr.length; i++) {
					const r = scr[i];
					const linedUpRects = [r];

					for (let j = i + 1; j < scr.length; j++) {
						const r2 = scr[j];
						if (equalApprox(r.x, r2.x, gaps))
							linedUpRects.push(r2);
					}

					const h = linedUpRects.reduce((sumHeight, rect) => sumHeight += rect.height, 0);
					if (equalApprox(h, workArea.height, gaps)) { // rects line up and fill entire screen height
						width = workArea.x + workArea.width - r.x;
						break;
					}
				}
			}

			if (!width || equalApprox(width, workArea.width, gaps))
				width = workArea.width / 2;

			return new Meta.Rectangle({
				x: workArea.x + workArea.width - width,
				y: workArea.y,
				width: width,
				height: workArea.height,
			});

		case Meta.Side.TOP:
			// find the rectangles, which line up horizontally
			if (screenRects.length > 1) { // 1 => maximized window or no tiled windows
				for (let i = 0; i < screenRects.length; i++) {
					const r = screenRects[i];
					const linedUpRects = [r];

					for (let j = i + 1; j < screenRects.length; j++) {
						const r2 = screenRects[j];
						if (equalApprox(r.y + r.height, r2.y + r2.height, gaps))
							linedUpRects.push(r2);
					}

					const w = linedUpRects.reduce((sumWidth, rect) => sumWidth += rect.width, 0);
					if (equalApprox(w, workArea.width, gaps)) { // rects line up and fill entire screen height
						height = r.y + r.height - workArea.y;
						break;
					}
				}
			}

			if (!height || equalApprox(height, workArea.height, gaps))
				height = workArea.height / 2;

			return new Meta.Rectangle({
				x: workArea.x,
				y: workArea.y,
				width: workArea.width,
				height: height,
			});

		case Meta.Side.BOTTOM:
			// find the rectangles, which line up horizontally
			const scr = [...screenRects];
			scr.reverse();
			if (scr.length > 1) { // 1 => maximized window or no tiled windows
				for (let i = 0; i < scr.length; i++) {
					const r = scr[i];
					const linedUpRects = [r];

					for (let j = i + 1; j < scr.length; j++) {
						const r2 = scr[j];
						if (equalApprox(r.y + r.height, r2.y + r2.height, gaps) && !equalApprox(r2.y + r2.height, workArea.y + workArea.height, gaps))
							linedUpRects.push(r2);
					}

					const w = linedUpRects.reduce((sumWidth, rect) => sumWidth += rect.width, 0);
					if (equalApprox(w, workArea.width, gaps)) { // rects line up and fill entire screen height
						height = workArea.y + workArea.height - (r.y + r.height);
						break;
					}
				}
			}

			if (!height || equalApprox(height, workArea.height, gaps))
				height = workArea.height / 2;

			return new Meta.Rectangle({
				x: workArea.x,
				y: workArea.y + workArea.height - height,
				width: workArea.width,
				height: height,
			});

		case Meta.Side.TOP + Meta.Side.LEFT:
			if (screenRects.length > 1) { // 1 => maximized window or no tiled windows
				for (const r of screenRects) {
					if (equalApprox(r.x, workArea.x, gaps) && equalApprox(r.y, workArea.y, gaps)) {
						width = r.width;
						height = r.height;
						break;
					}
				}
			}

			if (!width || equalApprox(width, workArea.width, gaps))
				width = workArea.width / 2;

			if (!height || equalApprox(height, workArea.height, gaps))
				height = workArea.height / 2;

			return new Meta.Rectangle({
				x: workArea.x,
				y: workArea.y,
				width: width,
				height: height,
			});

		case Meta.Side.TOP + Meta.Side.RIGHT:
			if (screenRects.length > 1) { // 1 => maximized window or no tiled windows
				for (const r of screenRects) {
					if (equalApprox(r.x + r.width, workArea.x + workArea.width, gaps) && equalApprox(r.y, workArea.y, gaps)) {
						width = r.width;
						height = r.height;
						break;
					}
				}
			}

			if (!width || equalApprox(width, workArea.width, gaps))
				width = workArea.width / 2;

			if (!height || equalApprox(height, workArea.height, gaps))
				height = workArea.height / 2;

			return new Meta.Rectangle({
				x: workArea.x + workArea.width - width,
				y: workArea.y,
				width: width,
				height: height,
			});

		case Meta.Side.BOTTOM + Meta.Side.LEFT:
			if (screenRects.length > 1) { // 1 => maximized window or no tiled windows
				for (const r of screenRects) {
					if (equalApprox(r.x, workArea.x, gaps) && equalApprox(r.y + r.height, workArea.y + workArea.height, gaps)) {
						width = r.width;
						height = r.height;
						break;
					}
				}
			}

			if (!width || equalApprox(width, workArea.width, gaps))
				width = workArea.width / 2;

			if (!height || equalApprox(height, workArea.height, gaps))
				height = workArea.height / 2;

			return new Meta.Rectangle({
				x: workArea.x,
				y: workArea.y + workArea.height - height,
				width: width,
				height: height,
			});

		case Meta.Side.BOTTOM + Meta.Side.RIGHT:
			if (screenRects.length > 1) { // 1 => maximized window or no tiled windows
				for (const r of screenRects) {
					if (equalApprox(r.x + r.width, workArea.x + workArea.width, gaps) && equalApprox(r.y + r.height, workArea.y + workArea.height, gaps)) {
						width = r.width;
						height = r.height;
						break;
					}
				}
			}

			if (!width || equalApprox(width, workArea.width, gaps))
				width = workArea.width / 2;

			if (!height || equalApprox(height, workArea.height, gaps))
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
	if (!window || window.is_skip_taskbar())
		return;

	const wasMaximized = window.get_maximized();
	if (wasMaximized)
		window.unmaximize(wasMaximized);

	if (!window.allows_resize() || !window.allows_move())
		return;

	// sometimes, because of the group-focusing (raising),
	// the focused window will be below another window.
	// so we raise the focused window to prevent unexpected behaviour
	window.raise();

	const oldRect = window.get_frame_rect();
	if (!window.isTiled)
		window.isTiled = oldRect;

	// save the actual window rect without gaps and disregarding the actual window size for more acurate operations later.
	// it helps with some terminals (or other windows) which cant be resized freely / which only resize in full rows/columns
	// or for falsely opening the Dash when the windows' min size is bigger than newRect
	window.tiledRect = newRect.copy();

	// window gaps & work on a copy
	const rect = newRect.copy();
	const gap = MyExtension.settings.get_int("window-gaps");
	if (gap) {
		rect.x += gap;
		rect.y += gap;
		rect.width -= 2 * gap;
		rect.height -= 2 * gap;
	}

	// animation
	const wActor = window.get_compositor_private();
	const onlyMove = oldRect.width === rect.width && oldRect.height === rect.height;
	if (MyExtension.settings.get_boolean("use-anim")) {
		if (onlyMove) { // custom anim because they dont exist
			const actorContent = Shell.util_get_content_for_window_actor(wActor, oldRect);
			const clone = new St.Widget({
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
				duration: 250,
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

	// Wayland workaround because some apps dont work properly (e. g. tiling Nautilius and then choosing firefox from the Dash)
	if (Meta.is_wayland_compositor())
		window.move_frame(false, rect.x, rect.y);

	// setting user_op to false helps with issues on terminals
	window.move_resize_frame(false, rect.x, rect.y, rect.width, rect.height);

	// setup tileGroup to raise tiled windows as a group
	const tileGroup = getTopTileGroup(getOpenWindows(), false);
	updateTileGroup(tileGroup);

	if (checkToOpenDash)
		MyExtension.onWindowTiled(window);
};

function maximizeBoth(window) {
	if (!window || !window.allows_move() || !window.allows_resize())
		return;

	removeTileGroup(window);

	// sometimes, because of the group-focusing (raising),
	// the focused window will be below another window.
	// so we raise the focused window to prevent unexpected behaviour and bugs
	window.raise();

	const workArea = window.get_work_area_current_monitor();
	window.tiledRect = workArea;

	// const gap = MyExtension.settings.get_int("window-gaps");
	// if (gap) {
	// 	const rect = new Meta.Rectangle({
	// 		x: workArea.x + gap,
	// 		y: workArea.y + gap,
	// 		width: workArea.width - 2 * gap,
	// 		height: workArea.height - 2 * gap,
	// 	});

	// 	const oldRect = window.get_frame_rect();

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

	const oldRect = window.isTiled;

	if (restoreFullPos) {
		// user_op as false to restore window while keeping it fully in screen in case DND-tiling dragged it offscreen
		window.move_resize_frame(false, oldRect.x, oldRect.y, oldRect.width, oldRect.height);

	} else { // scale while keeping the top at the same relative y pos (for DNDing)
		const currWindowFrame = window.get_frame_rect();
		const [mouseX] = global.get_pointer();
		const relativeMouseX = (mouseX - currWindowFrame.x) / currWindowFrame.width;
		const newPosX = mouseX - oldRect.width * relativeMouseX;

		// user_op with true to properly restore big windows via DND so they can go partly offscreen
		window.move_frame(true, newPosX, currWindowFrame.y); // Wayland workaround for DND/restore position
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
			const workArea = w.get_work_area_current_monitor();
			if (!w.tileGroup || w.get_maximized() === Meta.MaximizeFlags.BOTH || (w.isTiled && rectsAreAboutEqual(w.tiledRect, workArea)))
				return;

			w.tileGroup.forEach(ww => {
				if (ww.isTiled && ww.get_maximized() !== Meta.MaximizeFlags.BOTH && !rectsAreAboutEqual(ww.tiledRect, workArea)) {
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
		if (!w.tileGroup)
			return;

		const idx = w.tileGroup.indexOf(window);
		if (idx !== -1)
			w.tileGroup.splice(idx, 1);
	});

	window.tileGroup = null;
};

// resizing via DND:
// sameSideWindows are the windows which are on the same side as the resizedRect based on the drag direction
// e.g. if resizing the top left on the E side, the bottom left window is a sameSideWindow
// opposingWindows are the windows bordering the resized window on the grab side
function resizeComplementingWindows(resizedWindow, grabOp, gap) {
	const resizedRect = resizedWindow.get_frame_rect();
	const sameSideWindows = resizedWindow.sameSideWindows;
	const opposingWindows = resizedWindow.opposingWindows;

	switch (grabOp) {
		case Meta.GrabOp.RESIZING_N:

			sameSideWindows.forEach(w => {
				const wRect = w.get_frame_rect();
				w.move_resize_frame(false, wRect.x, resizedRect.y, wRect.width, w.preGrabRect.y + w.preGrabRect.height - resizedRect.y);
			});

			opposingWindows.forEach(w => {
				const wRect = w.get_frame_rect();
				w.move_resize_frame(false, wRect.x, wRect.y, wRect.width, resizedRect.y - wRect.y - 2 * gap);
			});
			break;

		case Meta.GrabOp.RESIZING_S:
			sameSideWindows.forEach(w => {
				const wRect = w.get_frame_rect();
				w.move_resize_frame(false, wRect.x, wRect.y, wRect.width, resizedRect.y + resizedRect.height - wRect.y);
			});

			opposingWindows.forEach(w => {
				const wRect = w.get_frame_rect();
				const y = resizedRect.y + resizedRect.height + 2 * gap;
				w.move_resize_frame(false, wRect.x, y, wRect.width, w.preGrabRect.y + w.preGrabRect.height - y);
			});
			break;

		case Meta.GrabOp.RESIZING_E:
			sameSideWindows.forEach(w => {
				const wRect = w.get_frame_rect();
				w.move_resize_frame(false, wRect.x, wRect.y, resizedRect.x + resizedRect.width - wRect.x, wRect.height);
			});

			opposingWindows.forEach(w => {
				const wRect = w.get_frame_rect();
				const x = resizedRect.x + resizedRect.width + 2 * gap;
				w.move_resize_frame(false, x, wRect.y, w.preGrabRect.x + w.preGrabRect.width - x, wRect.height);
			});
			break;

		case Meta.GrabOp.RESIZING_W:
			sameSideWindows.forEach(w => {
				const wRect = w.get_frame_rect();
				w.move_resize_frame(false, resizedRect.x, wRect.y, w.preGrabRect.x + w.preGrabRect.width - resizedRect.x, wRect.height);
			});

			opposingWindows.forEach(w => {
				const wRect = w.get_frame_rect();
				w.move_resize_frame(false, wRect.x, wRect.y, resizedRect.x - wRect.x - 2 * gap, wRect.height);
			});
	}
};

// open app in a tiled state:
// 1. via holding shift or alt when activating an appIcon with appDisplay.AppIcon or
// 2. via defined layouts (last few) in the settings page of this extension
function openAppTiled(app, rect, appsForLayouting = [], rectsForLayouting = []) {
	if (!app) // when layouting
		return main.notify("Tiling Assistant Extension", "App-to-tile isn't installed.");

	if (!app.can_open_new_window())
		return main.notify("Tiling Assistant Extension", `${app.get_name()} can't open a new window.`);

	const wCreatedId = global.display.connect("window-created", (src, window) => {
		// here we try to ignore loading screens; different apps use different windows for loading screens:
		// For ex.: Krita's and GIMP's loading screen returns true for is_skip_taskbar()
		// Steam's loading screen is a normal window, which doesn't skip the taskbar but doesn't allow_resize()
		if (window.get_window_type() !== Meta.WindowType.NORMAL || window.is_skip_taskbar() || !window.allows_move() || !window.allows_resize())
			return;

		global.display.disconnect(wCreatedId);

		// in case window detection above didn't work properly, we will return here so that no unintended windows suddenly get tiled
		// this breaks, if the current to-be-tiled app loads (-> load screen) and the user opens another window
		// ... acceptable downside for me
		const winTracker = Shell.WindowTracker.get_default();
		const openedApp = winTracker.get_window_app(window);
		if (openedApp !== app)
			return;

		const wActor = window.get_compositor_private();
		const firstFrameID = wActor.connect("first-frame", () => {
			wActor.disconnect(firstFrameID);

			const isLayouting = appsForLayouting.length && rectsForLayouting.length;
			tileWindow(window, rect, !isLayouting);
			if (isLayouting)
				openAppTiled(appsForLayouting.shift(), rectsForLayouting.shift(), appsForLayouting, rectsForLayouting);
		});
	});

	app.open_new_window(-1);
};
