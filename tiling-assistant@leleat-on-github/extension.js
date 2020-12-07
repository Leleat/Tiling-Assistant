const Lang = imports.lang;
const {main, iconGrid, appDisplay, panel, altTab, switcherPopup, windowManager} = imports.ui;
const {GObject, GLib, St, Shell, Clutter, Meta, Graphene} = imports.gi;
const ExtensionUtils = imports.misc.extensionUtils;

let appDash = null;
let tilePreview = null;
let tiledWindows = {}; // {windowID : oldFrameRect}
let windowGrabSignals = {}; // {windowID : [signalIDs]}
let newWindowsToTile = {}; // to open apps directly in tiled state -> {app.name: Meta.Side.X}
let TERMINALS_TO_WORKAROUND = [ // some apps (some terminals?) need to have openDash be delayed after their maximize call to function properly
	"Terminal",
	"MATE Terminal",
	"XTerm",
	"Roxterm", // delay doesnt seem work for Roxterm
];

let settings = null;

// 2 entry points "into this extension".
// 1. tiled with keyboard shortcut (of this extension) => calls onMyTilingShortcutPressed()
// 2. tiled via DND => signal calls onGrabBegin()

function init() {
};

function enable() {
	settings = ExtensionUtils.getSettings("org.gnome.shell.extensions.tiling-assistant");

	// signal connections
	this.windowGrabBegin = global.display.connect('grab-op-begin', onGrabBegin.bind(this));
	this.windowGrabEnd = global.display.connect("grab-op-end", onGrabEnd.bind(this));
	this.overviewShown = main.overview.connect("showing", () => { if (appDash.shown) appDash.close(); });
	this.windowCreated = global.display.connect("window-created", onWindowCreated.bind(this));

	appDash = new TilingAppDash();
	tilePreview = new TilingTilePreview();

	// disable native tiling
	// taken from ShellTile@emasab.it - https://extensions.gnome.org/extension/657/shelltile/
	// dont know why gnome_shell_settings tiling is disabled...
	this.gnome_mutter_settings = ExtensionUtils.getSettings("org.gnome.mutter");
	this.gnome_mutter_settings.set_boolean("edge-tiling", false);
	this.gnome_shell_settings = ExtensionUtils.getSettings("org.gnome.shell.overrides");
	this.gnome_shell_settings.set_boolean("edge-tiling", false);

	// tiling keybindings
	this.keyBindings = ["tile-right-half", "tile-left-half", "tile-top-half", "tile-bottom-half", "tile-bottomleft-quarter", "tile-bottomright-quarter", "tile-topright-quarter", "tile-topleft-quarter"];
	this.keyBindings.forEach(key => {
		main.wm.addKeybinding(
			key,
			settings,
			Meta.KeyBindingFlags.NONE,
			Shell.ActionMode.NORMAL,
			onMyTilingShortcutPressed.bind(this, key)
		);
	});

	// change appDisplay.AppIcon.activate function
	this.oldAppActivateFunc = appDisplay.AppIcon.prototype.activate;
	appDisplay.AppIcon.prototype.activate = newAppActivate;

	// change main.panel._getDraggableWindowForPosition to also include windows tiled with this extension
	this.oldGetDraggableWindowForPosition = main.panel._getDraggableWindowForPosition;
	main.panel._getDraggableWindowForPosition = newGetDraggableWindowForPosition;
};

function disable() {
	// disconnect signals
	global.display.disconnect(this.windowGrabBegin);
	global.display.disconnect(this.windowGrabEnd);
	main.overview.disconnect(this.overviewShown);
	global.display.disconnect(this.windowCreated);

	tilePreview.destroy();
	appDash._destroy();

	// re-enable native tiling
	this.gnome_mutter_settings.reset("edge-tiling");
	this.gnome_shell_settings.reset("edge-tiling");

	// remove keybindings
	this.keyBindings.forEach(key => {
		main.wm.removeKeybinding(key);
	});

	// restore old function
	appDisplay.AppIcon.prototype.activate = this.oldAppActivateFunc;
	main.panel._getDraggableWindowForPosition = this.oldGetDraggableWindowForPosition;

	settings.run_dispose();
	settings = null;
};

// allow to directly open an app in a tiled state
// via holding Alt or Shift when activating the icon
function newAppActivate(button) {
	let event = Clutter.get_current_event();
	let modifiers = event ? event.get_state() : 0;
	let isAltPressed = modifiers & Clutter.ModifierType.MOD1_MASK;
	let isShiftPressed = modifiers & Clutter.ModifierType.SHIFT_MASK;
	let isMiddleButton = button && button == Clutter.BUTTON_MIDDLE;
	let isCtrlPressed = (modifiers & Clutter.ModifierType.CONTROL_MASK) != 0;
	let openNewWindow = this.app.can_open_new_window() &&
			this.app.state == Shell.AppState.RUNNING &&
			(isCtrlPressed || isMiddleButton);

	if (this.app.state == Shell.AppState.STOPPED || openNewWindow || isShiftPressed || isAltPressed)
		this.animateLaunch();

	if (openNewWindow) {
		this.app.open_new_window(-1);

	} else if (isShiftPressed && this.app.can_open_new_window()) {
		newWindowsToTile[this.app.get_name()] = Meta.Side.LEFT;
		this.app.open_new_window(-1);

	} else if (isAltPressed && this.app.can_open_new_window()) {
		newWindowsToTile[this.app.get_name()] = Meta.Side.RIGHT;
		this.app.open_new_window(-1);

	} else {
		this.app.activate();
	}

	main.overview.hide();
};

// allow the DND of quartered windows (which touch the panel) from the panel
function newGetDraggableWindowForPosition(stageX) {
	let workspaceManager = global.workspace_manager;
	const windows = workspaceManager.get_active_workspace().list_windows();
	const allWindowsByStacking = global.display.sort_windows_by_stacking(windows).reverse();

	return allWindowsByStacking.find(metaWindow => {
		let rect = metaWindow.get_frame_rect();
		let workArea = metaWindow.get_work_area_current_monitor();

		return metaWindow.is_on_primary_monitor() &&
			metaWindow.showing_on_its_workspace() &&
			metaWindow.get_window_type() != Meta.WindowType.DESKTOP &&
			(metaWindow.maximized_vertically || (metaWindow.get_id() in tiledWindows && rect.y == workArea.y)) &&
			stageX > rect.x && stageX < rect.x + rect.width;
	});
};

// to tile a window after it has been created via holding alt/shift on an icon
function onWindowCreated(src, w) {
	let app = Shell.WindowTracker.get_default().get_window_app(w);
	if (!app)
		return;

	let tileSide = newWindowsToTile[app.get_name()];
	if (tileSide && w.get_window_type() == Meta.WindowType.NORMAL && w.allows_move() && w.allows_resize()) {
		let sourceID = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => { // timer needed because window won't be sized correctly on the window-created signal yet
			let rect = getTileRectFor(tileSide, w.get_work_area_current_monitor());
			tileWindow(w, rect);

			delete newWindowsToTile[app.get_name()];
			GLib.source_remove(sourceID);
		});
	}
};

function tileWindow(window, newRect) {
	if (!window)
		return;

	let wasMaximized = window.get_maximized();
	if (wasMaximized)
		window.unmaximize(window.get_maximized());

	if (!window.allows_resize() || !window.allows_move())
		return;

	let oldRect = window.get_frame_rect();
	let workArea = window.get_work_area_current_monitor();

	if (!(window.get_id() in tiledWindows)) {
		tiledWindows[window.get_id()] = window.get_frame_rect();
		tiledWindows[window.get_id()].win = window;
	}

	let wActor = window.get_compositor_private();
	wActor.connect("destroy", () => {
		if (tiledWindows[window.get_id()])
			delete tiledWindows[window.get_id()];
	});

	let onlyMove = oldRect.width == newRect.width && oldRect.height == newRect.height;
	if (settings.get_boolean("use-anim")) {
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
				x: newRect.x,
				y: newRect.y,
				width: newRect.width,
				height: newRect.height,
				duration: windowManager.WINDOW_ANIMATION_TIME,
				mode: Clutter.AnimationMode.EASE_OUT_QUAD,
				onComplete: () => {
					wActor.show();
					clone.destroy();
				}
			});

		} else if (wasMaximized) {

		} else {
			// hack => journalctl: error in size change accounting && Old animationInfo removed from actor
			main.wm._prepareAnimationInfo(global.window_manager, wActor, oldRect, Meta.SizeChange.MAXIMIZE); // Meta.SizeChange.MAXIMIZE works even for quartering
		}
	}

	let willMaximizeBoth = newRect.height == workArea.height && newRect.width == workArea.width;

	// some terminals seem to not work with this extension
	// delaying some stuff after the maximize() call seems to be a workaround
	let winTracker = Shell.WindowTracker.get_default();
	let appName = winTracker.get_window_app(window).get_name();
	let terminalWorkaround = TERMINALS_TO_WORKAROUND.indexOf(appName) != -1;

	if (!willMaximizeBoth) { // moving frame is unnecessary when maximizing both
		if (terminalWorkaround) // animation workaround. Better animation when setting user_op in move_resize_frame() to false; But I dont know the aftereffects, so I wont use that...
			window.move_frame(true, newRect.x, newRect.y);

		window.move_resize_frame(true, newRect.x, newRect.y, newRect.width, newRect.height);
	}

	if (settings.get_boolean("use-anim") && !willMaximizeBoth) { // wait for anim to be done before maximize(); otherwise maximize() will skip anim
		let sourceID = GLib.timeout_add(GLib.PRIORITY_DEFAULT, windowManager.WINDOW_ANIMATION_TIME, () => {
			if (newRect.height >= workArea.height - 2)
				window.maximize(Meta.MaximizeFlags.VERTICAL);

			else if (newRect.width >= workArea.width - 2)
				window.maximize(Meta.MaximizeFlags.HORIZONTAL);

			GLib.source_remove(sourceID);
		});

	} else {
		if (willMaximizeBoth)
			window.maximize(Meta.MaximizeFlags.BOTH);

		else if (newRect.height >= workArea.height - 2)
			window.maximize(Meta.MaximizeFlags.VERTICAL);

		else if (newRect.width >= workArea.width - 2)
			window.maximize(Meta.MaximizeFlags.HORIZONTAL);
	}

	// timer needed to correctly shade the BG of multi-step activation (i.e. via holding shift/alt when tiling)
	let sID = GLib.timeout_add(GLib.PRIORITY_DEFAULT, (settings.get_boolean("use-anim") && terminalWorkaround) ? windowManager.WINDOW_ANIMATION_TIME : 50, () => {
		openDash(window);
		GLib.source_remove(sID);
	});
};

function onMyTilingShortcutPressed(shortcutName) {
	let window = global.display.focus_window;
	if (!window)
		return;

	let rect;
	let workArea = window.get_work_area_current_monitor();
	switch (shortcutName) {
		case "tile-top-half":
			rect = getTileRectFor(Meta.Side.TOP, workArea);
			break;

		case "tile-left-half":
			rect = getTileRectFor(Meta.Side.LEFT, workArea);
			break;

		case "tile-right-half":
			rect = getTileRectFor(Meta.Side.RIGHT, workArea);
			break;

		case "tile-bottom-half":
			rect = getTileRectFor(Meta.Side.BOTTOM, workArea);
			break;

		case "tile-topleft-quarter":
			rect = getTileRectFor(Meta.Side.TOP + Meta.Side.LEFT, workArea);
			break;

		case "tile-topright-quarter":
			rect = getTileRectFor(Meta.Side.TOP + Meta.Side.RIGHT, workArea);
			break;

		case "tile-bottomleft-quarter":
			rect = getTileRectFor(Meta.Side.BOTTOM + Meta.Side.LEFT, workArea);
			break;

		case "tile-bottomright-quarter":
			rect = getTileRectFor(Meta.Side.BOTTOM + Meta.Side.RIGHT, workArea);
	}

	// TERMINALS_TO_WORKAROUND seem to cause problems when using Meta.Rectangle.equal because there are slight differences
	let rectsAreAboutEqual = (r1, r2) => {
		let samePos = Math.abs(r1.x - r2.x) < 10 && Math.abs(r1.y - r2.y) < 10;
		let sameSize = Math.abs(r1.width - r2.width) < 10 && Math.abs(r1.height - r2.height) < 10;
		return samePos && sameSize;
	};

	if (window.get_id() in tiledWindows && rectsAreAboutEqual(rect, window.get_frame_rect()))
		restoreWindowSize(window, true);
	else
		tileWindow(window, rect);
};

// get the top most tiled windows which are in a group (looped through window list by stack order: top -> bottom)
function getTileGroup(openWindows, ignoreTopWindow = false) {
	// maximization state is checked via their size rather than via get_maximized()
	// because tileWindow() will delay the maximize(), if animations are enabled

	let groupedWindows = []; // tiled windows which are considered in a group
	let notGroupedWindows = []; // normal and tiled windows which appear between grouped windows in the stack order

	for (let i = (ignoreTopWindow) ? 1 : 0; i < openWindows.length; i++) { // ignore the topmost window if DNDing, Tiling via keybinding and opening a window in a tiled state
		let window = openWindows[i];

		if (window.get_monitor() != ((ignoreTopWindow) ? global.display.get_current_monitor() : openWindows[0].get_monitor()))
			continue;

		if (window.get_id() in tiledWindows) {
			let workArea = window.get_work_area_current_monitor();
			let wRect = window.get_frame_rect();
			if (wRect.width == workArea.width && wRect.height == workArea.height)
				break;

			let notInGroup = false;

			// if a non-tiled window overlaps the currently tested tiled window, 
			// the currently tested tiled window isnt part of the topmost tile group
			for (let j = 0; j < notGroupedWindows.length; j++)
				if (notGroupedWindows[j].get_frame_rect().overlap(window.get_frame_rect())) {
					notInGroup = true;
					break;
				}

			if (!notInGroup)
				// same for for tiled windows which are overlapped by tiled windows in a higher stack order
				for (let j = 0; j < groupedWindows.length; j++)
					if (groupedWindows[j].get_frame_rect().overlap(window.get_frame_rect())) {
						notInGroup = true;
						notGroupedWindows.push(window);
						break;
					}

			if (!notInGroup)
				groupedWindows.push(window);

		} else {
			notGroupedWindows.push(window);
		}
	}

	let currTileGroup = {
		TOP_LEFT: null,
		TOP_RIGHT: null,
		BOTTOM_LEFT: null,
		BOTTOM_RIGHT: null
	};

	if (!groupedWindows.length)
		return currTileGroup;

	let workArea = groupedWindows[0].get_work_area_current_monitor();
	groupedWindows.forEach(tiledWindow => {
		let wRect = tiledWindow.get_frame_rect();

		// origin: top left
		if (wRect.x == workArea.x && wRect.y == workArea.y) {
			currTileGroup.TOP_LEFT = tiledWindow;

			if (wRect.width == workArea.width)
				currTileGroup.TOP_RIGHT = tiledWindow;

			if (wRect.height == workArea.height)
				currTileGroup.BOTTOM_LEFT = tiledWindow;
		}

		// origin: top right
		if (wRect.x != workArea.x && wRect.y == workArea.y) {
			currTileGroup.TOP_RIGHT = tiledWindow;

			if (wRect.height == workArea.height)
				currTileGroup.BOTTOM_RIGHT = tiledWindow;
		}

		// origin: bottom left
		if (wRect.x == workArea.x && wRect.y != workArea.y) {
			currTileGroup.BOTTOM_LEFT = tiledWindow;

			if (wRect.width == workArea.width)
				currTileGroup.BOTTOM_RIGHT = tiledWindow;
		}

		// origin: bottom right
		if (wRect.x != workArea.x && wRect.y != workArea.y)
			currTileGroup.BOTTOM_RIGHT = tiledWindow;
	});

	return currTileGroup;
};

// called when a window is tiled
// decides wether the Dash should be opened. If yes, the dash will be opened.
function openDash(tiledWindow) {
	if (appDash.shown)
		return;

	let workArea = tiledWindow.get_work_area_current_monitor();

	// window was maximized - dont check via get_maximized() since tileWindow() delays the maximize() call if anim are enabled
	if (tiledWindow.get_frame_rect().width == workArea.width && tiledWindow.get_frame_rect().height == workArea.height)
		return;

	let activeWS = global.workspace_manager.get_active_workspace()
	let openWindows = global.display.sort_windows_by_stacking(activeWS.list_windows()).reverse();

	let currTileGroup = getTileGroup(openWindows);

	// assume all 4 quads are free
	// remove a quad for each window in currTileGroup
	let freeQuadCount = 4;
	for (let pos in currTileGroup) {
		if (currTileGroup[pos] == null)
			continue;

		// focus tiled windows in a group
		let w = currTileGroup[pos];
		w.tileGroup = currTileGroup;
		w.connect("focus", () => {
			for (let pos in w.tileGroup) {
				let window = w.tileGroup[pos];
				if (!window)
					continue;

				window.tileGroup = w.tileGroup; // update the tileGroup with the current tileGroup
				window.raise();
			}

			w.raise();
		});

		// remove the tiled windows from openWindows to populate the Dash
		let idx = openWindows.indexOf(currTileGroup[pos]);
		if (idx != -1)
			openWindows.splice(idx, 1);

		freeQuadCount--;
	}

	if (freeQuadCount == 0 || freeQuadCount == 3)
		return;

	if (openWindows.length == 0)
		return;

	// filter the openWindows array, so that no duplicate apps are shown
	let winTracker = Shell.WindowTracker.get_default();
	let openApps = [];
	openWindows.forEach(w => openApps.push(winTracker.get_window_app(w)));
	openWindows = openWindows.filter((w, pos) => openApps.indexOf(winTracker.get_window_app(w)) == pos);

	let freeScreenRect = null;

	// only 1 quad is free
	if (freeQuadCount == 1) {
		if (currTileGroup.TOP_LEFT == null)
			freeScreenRect = getTileRectFor(Meta.Side.TOP + Meta.Side.LEFT, workArea);

		else if (currTileGroup.TOP_RIGHT == null)
			freeScreenRect = getTileRectFor(Meta.Side.TOP + Meta.Side.RIGHT, workArea);

		else if (currTileGroup.BOTTOM_LEFT == null)
			freeScreenRect = getTileRectFor(Meta.Side.BOTTOM + Meta.Side.LEFT, workArea);

		else if (currTileGroup.BOTTOM_RIGHT == null)
			freeScreenRect = getTileRectFor(Meta.Side.BOTTOM + Meta.Side.RIGHT, workArea);

	// free screen space consists of 2 quads
	} else if (freeQuadCount == 2) {
		// dont open the dash if the free space consists of diagonal quads
		if ((currTileGroup.TOP_LEFT == null && currTileGroup.BOTTOM_RIGHT == null)
			|| (currTileGroup.TOP_RIGHT == null && currTileGroup.BOTTOM_LEFT == null))
			return;

		if (currTileGroup.TOP_LEFT == null && currTileGroup.TOP_RIGHT == null)
			freeScreenRect = getTileRectFor(Meta.Side.TOP, workArea);

		else if (currTileGroup.TOP_RIGHT == null && currTileGroup.BOTTOM_RIGHT == null)
			freeScreenRect = getTileRectFor(Meta.Side.RIGHT, workArea);

		else if (currTileGroup.BOTTOM_RIGHT == null && currTileGroup.BOTTOM_LEFT == null)
			freeScreenRect = getTileRectFor(Meta.Side.BOTTOM, workArea);

		else if (currTileGroup.BOTTOM_LEFT == null && currTileGroup.TOP_LEFT == null)
			freeScreenRect = getTileRectFor(Meta.Side.LEFT, workArea);
	}

	appDash.open(openWindows, tiledWindow, freeScreenRect);
};

// calls either restoreWindowSize(), onWindowMoving() or resizeComplementingWindows() depending on where the drag began on the window
function onGrabBegin(_metaDisplay, metaDisplay, grabbedWindow, grabOp) {
	if (!grabbedWindow)
		return;

	if (!windowGrabSignals[grabbedWindow.get_id()])
		windowGrabSignals[grabbedWindow.get_id()] = [];

	// for resizing op
	// sameSideWindow is the window which is on the same side relative to where the grab began
	// e.g. if resizing the top left on the E side, the bottom left window is the sameSideWindow
	// opposingWindows are the remaining windows
	let sameSideWindow = null;
	let opposingWindows = [];
	let grabbedRect = grabbedWindow.get_frame_rect();

	let activeWS = global.workspace_manager.get_active_workspace()
	let openWindows = global.display.sort_windows_by_stacking(activeWS.list_windows()).reverse();
	openWindows.splice(openWindows.indexOf(grabbedWindow), 1);

	switch (grabOp) {
		case Meta.GrabOp.MOVING:
			let [x, y] = global.get_pointer();
			windowGrabSignals[grabbedWindow.get_id()].push(grabbedWindow.connect("position-changed", onWindowMoving.bind(this, grabbedWindow, [x, y])));
			break;

		case Meta.GrabOp.RESIZING_N:
			for (let i = 0; i < openWindows.length; i++) {
				if (!(openWindows[i].get_id() in tiledWindows)) {
					if (grabbedRect.contains_rect(openWindows[i].get_frame_rect()))
						continue;
					break;
				}

				let otherRect = openWindows[i].get_frame_rect();
				if (equalApprox(otherRect.y, grabbedRect.y, 2) && equalApprox(otherRect.height, grabbedRect.height, 2))
					sameSideWindow = openWindows[i];

				else if (equalApprox(otherRect.y + otherRect.height, grabbedRect.y, 2))
					opposingWindows.push(openWindows[i]);
			}

			windowGrabSignals[grabbedWindow.get_id()].push(grabbedWindow.connect("size-changed", resizeComplementingWindows.bind(this, grabbedWindow, sameSideWindow, opposingWindows, grabOp)));
			break;

		case Meta.GrabOp.RESIZING_S:
			for (let i = 0; i < openWindows.length; i++) {
				if (!(openWindows[i].get_id() in tiledWindows)) {
					if (grabbedRect.contains_rect(openWindows[i].get_frame_rect()))
						continue;
					break;
				}

				let otherRect = openWindows[i].get_frame_rect();
				if (equalApprox(otherRect.y, grabbedRect.y, 2) && equalApprox(otherRect.height, grabbedRect.height, 2))
					sameSideWindow = openWindows[i];

				else if (equalApprox(otherRect.y, grabbedRect.y + grabbedRect.height, 2))
					opposingWindows.push(openWindows[i]);
			}

			windowGrabSignals[grabbedWindow.get_id()].push(grabbedWindow.connect("size-changed", resizeComplementingWindows.bind(this, grabbedWindow, sameSideWindow, opposingWindows, grabOp)));
			break;

		case Meta.GrabOp.RESIZING_E:
			for (let i = 0; i < openWindows.length; i++) {
				if (!(openWindows[i].get_id() in tiledWindows)) {
					if (grabbedRect.contains_rect(openWindows[i].get_frame_rect()))
						continue;
					break;
				}

				let otherRect = openWindows[i].get_frame_rect();
				if (equalApprox(otherRect.x, grabbedRect.x, 2) && equalApprox(otherRect.width, grabbedRect.width, 2))
					sameSideWindow = openWindows[i];

				else if (equalApprox(otherRect.x, grabbedRect.x + grabbedRect.width, 2))
					opposingWindows.push(openWindows[i]);
			}

			windowGrabSignals[grabbedWindow.get_id()].push(grabbedWindow.connect("size-changed", resizeComplementingWindows.bind(this, grabbedWindow, sameSideWindow, opposingWindows, grabOp)));
			break;

		case Meta.GrabOp.RESIZING_W:
			for (let i = 0; i < openWindows.length; i++) {
				if (!(openWindows[i].get_id() in tiledWindows)) {
					if (grabbedRect.contains_rect(openWindows[i].get_frame_rect()))
						continue;
					break;
				}

				let otherRect = openWindows[i].get_frame_rect();
				if (equalApprox(otherRect.x, grabbedRect.x, 2) && equalApprox(otherRect.width, grabbedRect.width, 2))
					sameSideWindow = openWindows[i];

				else if (equalApprox(otherRect.x + otherRect.width, grabbedRect.x, 2))
					opposingWindows.push(openWindows[i]);
			}

			windowGrabSignals[grabbedWindow.get_id()].push(grabbedWindow.connect("size-changed", resizeComplementingWindows.bind(this, grabbedWindow, sameSideWindow, opposingWindows, grabOp)));
	}
};

function onGrabEnd(_metaDisplay, metaDisplay, window, grabOp) {
	// disconnect the signals
	if (window && windowGrabSignals[window.get_id()])
		for (let i = windowGrabSignals[window.get_id()].length - 1; i >= 0; i--) {
			window.disconnect(windowGrabSignals[window.get_id()][i]);
			windowGrabSignals[window.get_id()].splice(i, 1);
		}

	if (tilePreview.showing) {
		tileWindow(window, tilePreview.rect);
		tilePreview.close();
	}
};

function restoreWindowSize(window, restoreFullPos = false) {
	if (!(window.get_id() in tiledWindows))
		return;

	let windowIsQuartered = !window.get_maximized();
	if (window.get_maximized())
		window.unmaximize(window.get_maximized());

	if (window.allows_resize() && window.allows_move()) {
		if (windowIsQuartered) { // custom restore anim since GNOME doesnt have one for this case
			let oldFrameRect = window.get_frame_rect();
			let actorContent = Shell.util_get_content_for_window_actor(window.get_compositor_private(), oldFrameRect);
			let actorClone = new St.Widget({
				content: actorContent,
				x: oldFrameRect.x,
				y: oldFrameRect.y,
				width: oldFrameRect.width,
				height: oldFrameRect.height,
			});
			main.uiGroup.add_child(actorClone);

			actorClone.ease({
				opacity: 0,
				duration: 250,
				mode: Clutter.AnimationMode.EASE_OUT_QUAD,
				onComplete: () => actorClone.destroy()
			});
		}

		let oldRect = tiledWindows[window.get_id()];
		let currWindowFrame = window.get_frame_rect();
		let [mouseX] = global.get_pointer();
		let relativeMouseX = (mouseX - currWindowFrame.x) / currWindowFrame.width; // percentage (in decimal) where the mouse.x is in the current window size
		let newPosX = mouseX - oldRect.width * relativeMouseX; // position the window after scaling, so that the mouse is at the same relative position.x e.g. mouse was at 50% of the old window and will be at 50% of the new one

		if (restoreFullPos)
			window.move_resize_frame(true, oldRect.x, oldRect.y, oldRect.width, oldRect.height);

		else // scale while keeping the top at the same y pos -> for example when DND
			window.move_resize_frame(true, newPosX, currWindowFrame.y, oldRect.width, oldRect.height);

		// remove the tileGroup to prevent wrongly raising each other
		// first find the correct tiling pos of the restored window
		// then loop through the other tiled windows checking that pos in their .tileGroup and setting it to null
		for (let pos in window.tileGroup) {
			if (window.tileGroup[pos] == window) {
				for (let id in tiledWindows) {
					let otherWindow = tiledWindows[id].win;
					if (otherWindow == window)
						continue;

					if (otherWindow.tileGroup && otherWindow.tileGroup[pos] == window)
						otherWindow.tileGroup[pos] = null;
				}
			}
		}
		window.tileGroup = null;

		delete tiledWindows[window.get_id()];
	}
};

// tile previewing via DND
function onWindowMoving(window, grabStartPos) {
	let [mouseX, mouseY] = global.get_pointer();

	// restore the window size of tiled windows after DND distance of at least 1px.
	// prevents restoring the window after just clicking on the title/top bar
	if (window.get_id() in tiledWindows) {
		let moveVec = [grabStartPos[0] - mouseX, grabStartPos[1] - mouseY];
		let moveDist = Math.sqrt(moveVec[0] * moveVec[0] + moveVec[1] * moveVec[1]);

		if (moveDist <= 0)
			return;

		global.display.end_grab_op(global.get_current_time());

		// timer needed because for some apps the grab will overwrite/ignore the size changes of restoreWindowSize()
		// so far I only noticed this behaviour with firefox
		let sourceID = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1, () => {
			restoreWindowSize(window);

			global.display.begin_grab_op(
				window,
				Meta.GrabOp.MOVING,
				true, // pointer already grabbed
				true, // frame action
				-1, // button
				0, // modifier
				global.get_current_time(),
				mouseX, Math.max(grabStartPos[1], window.get_frame_rect().y)
			);

			GLib.source_remove(sourceID);
		});

		return;
	}

	let monitorNr = global.display.get_current_monitor();
	let workArea = window.get_work_area_for_monitor(monitorNr);
	let wRect = window.get_frame_rect();

	let onTop = wRect.y < main.panel.height + 15; // mouseY alone is unreliable, so windowRect's y will also be used
	let onBottom = workArea.height - wRect.y < 75 || mouseY > workArea.height - 25; // mitigation for wrong grabPos when grabbing from topbar, see github issue #2; seems app dependant as well (especially GNOME/GTK apps cause problems)
	let onLeft = mouseX <= workArea.x + 25;
	let onRight = mouseX >= workArea.x + workArea.width - 25;

	let tileTopLeftQuarter = onTop && onLeft;
	let tileTopRightQuarter = onTop && onRight;
	let tileBottomLeftQuarter = onLeft && onBottom;
	let tileBottomRightQuarter = onRight && onBottom;

	// tile to top half on the most left and on the most right side of the topbar
	let tileTopHalf = onTop && ((mouseX > 25 && mouseX < workArea.width / 4) || (mouseX < workArea.y + workArea.width - 25 && mouseX > workArea.y + workArea.width - workArea.width / 4));
	let tileRightHalf = onRight
	let tileLeftHalf = onLeft;
	let tileMaximized = onTop;
	let tileBottomHalf = onBottom;

	let pos = 0;

	// prioritize quarter over other tiling
	if (tileTopLeftQuarter) {
		pos = Meta.Side.TOP + Meta.Side.LEFT;
		if (tilePreview.currPos == pos)
			return;

		tilePreview.open(window, pos, getTileRectFor(pos, workArea), monitorNr);

	} else if (tileTopRightQuarter) {
		pos = Meta.Side.TOP + Meta.Side.RIGHT;
		if (tilePreview.currPos == pos)
			return;

		tilePreview.open(window, pos, getTileRectFor(pos, workArea), monitorNr);

	} else if (tileBottomLeftQuarter) {
		pos = Meta.Side.BOTTOM + Meta.Side.LEFT;
		if (tilePreview.currPos == pos)
			return;

		tilePreview.open(window, pos, getTileRectFor(pos, workArea), monitorNr);

	} else if (tileBottomRightQuarter) {
		pos = Meta.Side.BOTTOM + Meta.Side.RIGHT;
		if (tilePreview.currPos == pos)
			return;

		tilePreview.open(window, pos, getTileRectFor(pos, workArea), monitorNr);

	} else if (tileRightHalf) {
		pos = Meta.Side.RIGHT;
		if (tilePreview.currPos == pos)
			return;

		tilePreview.open(window, pos, getTileRectFor(pos, workArea), monitorNr);

	} else if (tileLeftHalf) {
		pos = Meta.Side.LEFT;
		if (tilePreview.currPos == pos)
			return;

		tilePreview.open(window, pos, getTileRectFor(pos, workArea), monitorNr);

	} else if (tileTopHalf) {
		pos = Meta.Side.TOP;
		if (tilePreview.currPos == pos)
			return;

		tilePreview.open(window, pos, getTileRectFor(pos, workArea), monitorNr);

	} else if (tileBottomHalf) {
		pos = Meta.Side.BOTTOM;
		if (tilePreview.currPos == pos)
			return;

		tilePreview.open(window, pos, getTileRectFor(pos, workArea), monitorNr);

	} else if (tileMaximized) {
		pos = Meta.Side.TOP + Meta.Side.BOTTOM + Meta.Side.LEFT + Meta.Side.RIGHT;
		if (tilePreview.currPos == pos)
			return;

		tilePreview.open(window, pos, new Meta.Rectangle({
			x: workArea.x,
			y: workArea.y,
			width: workArea.width,
			height: workArea.height,
		}), monitorNr);

	} else {
		tilePreview.close();
	}
};

// sameSideWindow is the window which is on the same side as the resizedRect based on the drag direction
// e.g. if resizing the top left on the E side, the bottom left window is the sameSideWindow
// opposingWindows is the rest
function resizeComplementingWindows(resizedWindow, sameSideWindow, opposingWindows, grabOp) {
	if (!(resizedWindow.get_id() in tiledWindows))
		return;

	let resizedRect = resizedWindow.get_frame_rect();
	let workArea = resizedWindow.get_work_area_current_monitor();

	switch (grabOp) {
		case Meta.GrabOp.RESIZING_N:
			if (sameSideWindow) {
				let sameSideRect = sameSideWindow.get_frame_rect();
				sameSideWindow.move_resize_frame(true, sameSideRect.x, resizedRect.y, sameSideRect.width, resizedRect.height);
			}

			opposingWindows.forEach(w => {
				let wRect = w.get_frame_rect();
				w.move_resize_frame(true, wRect.x, wRect.y, wRect.width, workArea.height - resizedRect.height);
			});
			break;

		case Meta.GrabOp.RESIZING_S:
			if (sameSideWindow) {
				let sameSideRect = sameSideWindow.get_frame_rect();
				sameSideWindow.move_resize_frame(true, sameSideRect.x, sameSideRect.y, sameSideRect.width, resizedRect.height);
			}

			opposingWindows.forEach(w => {
				let wRect = w.get_frame_rect();
				w.move_resize_frame(true, wRect.x, resizedRect.y + resizedRect.height, wRect.width, workArea.height - resizedRect.height);
			});
			break;

		case Meta.GrabOp.RESIZING_E:
			if (sameSideWindow) {
				let sameSideRect = sameSideWindow.get_frame_rect();
				sameSideWindow.move_resize_frame(true, sameSideRect.x, sameSideRect.y, resizedRect.width, sameSideRect.height);
			}

			opposingWindows.forEach(w => {
				let wRect = w.get_frame_rect();
				w.move_resize_frame(true, resizedRect.x + resizedRect.width, wRect.y, workArea.width - resizedRect.width, wRect.height);
			});
			break;

		case Meta.GrabOp.RESIZING_W:
			if (sameSideWindow) {
				let sameSideRect = sameSideWindow.get_frame_rect();
				sameSideWindow.move_resize_frame(true, resizedRect.x, sameSideRect.y, resizedRect.width, sameSideRect.height);
			}

			opposingWindows.forEach(w => {
				let wRect = w.get_frame_rect();
				w.move_resize_frame(true, wRect.x, wRect.y, workArea.width - resizedRect.width, wRect.height);
			});
	}
};

function equalApprox(value, value2, margin) {
	if (value >= value2 - margin && value <= value2 + margin)
		return true;
	return false;
};

// called when DNDing, tiling via keybinding and opening an app in a tiled state
// that's why getTileGroup() will ignore the topmost window when called in this function
function getTileRectFor(side, workArea) {
	let activeWS = global.workspace_manager.get_active_workspace()
	let openWindows = global.display.sort_windows_by_stacking(activeWS.list_windows()).reverse();

	let currTileGroup = getTileGroup(openWindows, true);
	// if a window is maximized, 2 rects can be the same rect
	// e.g. a window vertically maxmized on the left will set topLeftRect and bottomLeftRect to its rect
	let topLeftRect = (currTileGroup.TOP_LEFT) ? currTileGroup.TOP_LEFT.get_frame_rect() : null;
	let topRightRect = (currTileGroup.TOP_RIGHT) ? currTileGroup.TOP_RIGHT.get_frame_rect() : null;
	let bottomLeftRect = (currTileGroup.BOTTOM_LEFT) ? currTileGroup.BOTTOM_LEFT.get_frame_rect() : null;
	let bottomRightRect = (currTileGroup.BOTTOM_RIGHT) ? currTileGroup.BOTTOM_RIGHT.get_frame_rect() : null;

	let width = 0;
	let height = 0;

	switch (side) {
		case Meta.Side.LEFT:
			[width, height] = getRectDimensions(workArea, bottomRightRect, topRightRect, bottomLeftRect);

			return new Meta.Rectangle({
				x: workArea.x,
				y: workArea.y,
				width: width,
				height: workArea.height,
			});

		case Meta.Side.RIGHT:
			[width, height] = getRectDimensions(workArea, bottomLeftRect, topLeftRect, bottomRightRect);

			return new Meta.Rectangle({
				x: workArea.x + workArea.width - width,
				y: workArea.y,
				width: width,
				height: workArea.height,
			});

		case Meta.Side.TOP:
			[width, height] = getRectDimensions(workArea, bottomRightRect, topRightRect, bottomLeftRect);

			return new Meta.Rectangle({
				x: workArea.x,
				y: workArea.y,
				width: workArea.width,
				height: height,
			});

		case Meta.Side.BOTTOM:
			[width, height] = getRectDimensions(workArea, topRightRect, bottomRightRect, topLeftRect);

			return new Meta.Rectangle({
				x: workArea.x,
				y: workArea.y + workArea.height - height,
				width: workArea.width,
				height: height,
			});

		case Meta.Side.TOP + Meta.Side.LEFT:
			[width, height] = getRectDimensions(workArea, bottomRightRect, topRightRect, bottomLeftRect);

			return new Meta.Rectangle({
				x: workArea.x,
				y: workArea.y,
				width: width,
				height: height,
			});

		case Meta.Side.TOP + Meta.Side.RIGHT:
			[width, height] = getRectDimensions(workArea, bottomLeftRect, topLeftRect, bottomRightRect);

			return new Meta.Rectangle({
				x: workArea.x + workArea.width - width,
				y: workArea.y,
				width: width,
				height: height,
			});

		case Meta.Side.BOTTOM + Meta.Side.LEFT:
			[width, height] = getRectDimensions(workArea, topRightRect, bottomRightRect, topLeftRect);

			return new Meta.Rectangle({
				x: workArea.x,
				y: workArea.y + workArea.height - height,
				width: width,
				height: height,
			});

		case Meta.Side.BOTTOM + Meta.Side.RIGHT:
			[width, height] = getRectDimensions(workArea, topLeftRect, bottomLeftRect, topRightRect);

			return new Meta.Rectangle({
				x: workArea.x + workArea.width - width,
				y: workArea.y + workArea.height - height,
				width: width,
				height: height,
			});
	}
}

// diagonalRect is the rect which is in the diagonal quad to the space we try to get the rect for
// for example: if we try to get the free space for the top left quad, the diagonal rect is at the bottom right
// if a window is maximized, 2 rects can be equal. E. g. possible: vertToDiaRect == diagonalRect.
// vertToDiaRect/horiToDiaRect are the quads in relation to the diagonal quad
function getRectDimensions(workArea, diagonalRect, vertToDiaRect, horiToDiaRect) {
	let width = 0;
	let height = 0;

	// 0 other tiled windows; default size
	if (!diagonalRect && !vertToDiaRect && !horiToDiaRect) {
		[width, height] = [workArea.width / 2, workArea.height / 2];

	// 1 (quartered) tiled window
	} else if (diagonalRect && !vertToDiaRect && !horiToDiaRect) {
		[width, height] = [workArea.width - diagonalRect.width, workArea.height - diagonalRect.height];

	} else if (!diagonalRect && vertToDiaRect && !horiToDiaRect) {
		[width, height] = [workArea.width - vertToDiaRect.width, vertToDiaRect.height];

	} else if (!diagonalRect && !vertToDiaRect && horiToDiaRect) {
		[width, height] = [horiToDiaRect.width, workArea.height - horiToDiaRect.height];

	// 2 quads taken by tiled window(s)
	} else if (diagonalRect && vertToDiaRect && !horiToDiaRect) {
		[width, height] = [workArea.width - vertToDiaRect.width, (diagonalRect.equal(vertToDiaRect)) ? workArea.height / 2 : vertToDiaRect.height];

	} else if (diagonalRect && !vertToDiaRect && horiToDiaRect) {
		[width, height] = [(diagonalRect.equal(horiToDiaRect)) ? workArea.width / 2 : horiToDiaRect.width, workArea.height - horiToDiaRect.height];

	} else if (!diagonalRect && vertToDiaRect && horiToDiaRect) {
		[width, height] = [horiToDiaRect.width, vertToDiaRect.height];

	// 3 quads taken by tiled window(s)
	} else {
		// if there are 3 differently sized windows, there are (at least?) 2 possible rects
		// one, where the height is limited by the union between the diagonalRect and the horiToDiaRect and the width is limited by vertToDiaRect
		// and the other one, where the height is limited by the horiToDiaRect and the width is limited by the union between the diagonalRect and the vertToDiaRect
		let vertUnion = (!diagonalRect.equal(horiToDiaRect)) ? diagonalRect.union(vertToDiaRect) : vertToDiaRect;
		let horiUnion = (!diagonalRect.equal(vertToDiaRect)) ? diagonalRect.union(horiToDiaRect) : horiToDiaRect;

		let r1 = [workArea.width - vertUnion.width, workArea.height - horiToDiaRect.height];
		let r1area = r1[0] * r1[1];

		let r2 = [workArea.width - vertToDiaRect.width, workArea.height - horiUnion.height];
		let r2area = r2[0] * r2[1];

		[width, height] = (r1area > r2area) ? r1 : r2;
	}

	if (!width)
		width = workArea.width / 2;
	if (!height)
		height = workArea.height / 2;

	return [width, height];
};

var TilingAppDash = GObject.registerClass(
	class TilingAppDash extends St.Widget {
		_init() {
			super._init();

			this.shown = false;

			// for animation move direction of the Dash (the Dash will move from the tiled window pos to the center of the remaining free space)
			this.animationDir = { x: 0, y: 0 };

			// shade BG when the Dash is open for easier visibility
			this.shadeBG = new St.Widget({
				style: ("background-color : black"),
				x: 0, y: 0,
				opacity: 0
			});
			global.window_group.add_child(this.shadeBG);
			this.shadeBG.hide();

			this.windowClones = []; // clones to show above the shadeBG (which is just below the tiledWindow)

			// hide Dash on mouse clicks
			this.mouseCatcher = new St.Widget({
				reactive: true,
				x: 0, y: 0,
			});
			main.layoutManager.addChrome(this.mouseCatcher);
			this.mouseCatcher.hide();
			this.onMouseCaught = this.mouseCatcher.connect("button-press-event", () => {
				if (this.shown)
					this.close();
			});

			// visual BG for the Dash if an app has multiple open windows
			this.windowDash = new St.Widget({
				style_class: "my-open-windows-dash",
				pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 }),
			});
			main.layoutManager.addChrome(this.windowDash);
			this.windowDash.focusItemAtIndex = this.focusItemAtIndex;
			this.windowDash.set_opacity(0);
			this.windowDash.hide();

			// visual BG for the Dash of open appIcons
			this.dashBG = new St.Widget({
				style_class: "my-open-windows-dash",
				pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 })
			});
			main.layoutManager.addChrome(this.dashBG);
			this.dashBG.hide();

			// container for appIcons, centered in dashBG
			this.appContainer = new St.Widget({
				pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 })
			});
			this.appContainer.focusItemAtIndex = this.focusItemAtIndex;
			this.dashBG.add_child(this.appContainer);
		}

		_destroy() {
			this.shadeBG.destroy();
			this.mouseCatcher.disconnect(this.onMouseCaught);
			this.mouseCatcher.destroy();
			this.dashBG.destroy();
			this.windowDash.destroy();
			this.destroy();
		}

		open(openWindows, tiledWindow, freeScreenRect) {
			this.shown = true;
			this.appContainer.destroy_all_children();

			this.freeScreenRect = freeScreenRect;
			this.monitor = tiledWindow.get_monitor();

			let entireWorkArea = tiledWindow.get_work_area_all_monitors();
			let monitorScale = global.display.get_monitor_scale(tiledWindow.get_monitor());

			// fill appContainer; Dash -> 1 row only
			// magicNr are margins/paddings from the icon to the full-sized highlighted button
			let buttonSize = monitorScale * (settings.get_int("icon-size") + 16 + settings.get_int("icon-margin") + ((settings.get_boolean("show-label")) ? 28 : 0));
			let dashWidth = openWindows.length * buttonSize;
			this.dashBG.set_size(dashWidth, buttonSize);
			this.appContainer.set_size(dashWidth, buttonSize);

			for (let idx = 0, posX = 0; idx < openWindows.length; idx++, posX += buttonSize) {
				let appIcon = new TilingAppIcon(openWindows[idx], idx, { showLabel: settings.get_boolean("show-label") });
				this.appContainer.add_child(appIcon);
				appIcon.set_position(posX, 0);
			}

			// setup dashBG; scale it to fit the freeScreenRect
			this.dashBG.set_scale(1, 1);
			if (this.dashBG.width > freeScreenRect.width * .95) {
				let scale = freeScreenRect.width * .95 / this.dashBG.width;
				this.dashBG.set_scale(scale, scale);
			}
			this.dashBG.show();
			this.dashBG.set_position(freeScreenRect.x + freeScreenRect.width / 2 - this.dashBG.width / 2
				, freeScreenRect.y + freeScreenRect.height / 2 - this.dashBG.height / 2);

			// setup appContainer
			this.appContainer.set_position(settings.get_int("icon-margin") / 2 * monitorScale, settings.get_int("icon-margin") / 2 * monitorScale);
			let firstIcon = this.appContainer.get_child_at_index(0);
			firstIcon.grab_key_focus();

			// some apps grab focus away from the appIcon (only when trying to open an app directly tiled)
			// Timer needed for visual focus style (actual key focus seems to be grabbed even without the timer)
			// for ex.: Newsflash
			firstIcon.focusWorkaroundSignal = firstIcon.connect("key-focus-out", () => {
				let sID = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1, () => {
					firstIcon.grab_key_focus();
					GLib.source_remove(sID);
				});
			});

			firstIcon.keyPressSignal = firstIcon.connect("key-press-event", (keyEvent) => {
				if (firstIcon.focusWorkaroundSignal) {
					firstIcon.disconnect(firstIcon.focusWorkaroundSignal);
					firstIcon.disconnect(firstIcon.keyPressSignal);
					firstIcon.focusWorkaroundSignal = 0;
				}
				return false;
			});

			// move bgContainer FROM final pos to animate (move) to final pos
			let finalX = this.dashBG.x;
			let finalY = this.dashBG.y;
			this.animationDir.x = Math.sign(tiledWindow.get_frame_rect().x - freeScreenRect.x);
			this.animationDir.y = Math.sign(tiledWindow.get_frame_rect().y - freeScreenRect.y);
			this.dashBG.set_position(finalX + 200 * this.animationDir.x, this.dashBG.y + 200 * this.animationDir.y);
			this.dashBG.ease({
				x: finalX,
				y: finalY,
				opacity: 255,
				duration: windowManager.WINDOW_ANIMATION_TIME,
				mode: Clutter.AnimationMode.EASE_OUT_QUINT,
			});

			// setup shadeBG
			this.windowClones = [];
			for (let pos in tiledWindow.tileGroup)
				if (tiledWindow.tileGroup[pos]) {
					if (tiledWindow.tileGroup[pos] == tiledWindow)
						continue;

					let wA = tiledWindow.tileGroup[pos].get_compositor_private();
					let clone = new Clutter.Clone({
						source: wA,
						x: wA.x,
						y: wA.y
					});
					wA.hide();
					main.uiGroup.add_child(clone);
					this.windowClones.push(clone);
				}

			let windowActor = tiledWindow.get_compositor_private();
			if (windowActor)
				global.window_group.set_child_below_sibling(this.shadeBG, windowActor);

			this.shadeBG.set_size(entireWorkArea.width, entireWorkArea.height + main.panel.height);
			this.shadeBG.show();
			this.shadeBG.ease({
				opacity: 180,
				duration: windowManager.WINDOW_ANIMATION_TIME,
				mode: Clutter.AnimationMode.EASE_OUT_QUINT,
			});

			// setup mouseCatcher
			this.mouseCatcher.show();
			this.mouseCatcher.set_size(entireWorkArea.width, entireWorkArea.height + main.panel.height);
		}

		close() {
			this.shown = false;
			this.mouseCatcher.hide();

			// in case the dash was closed via mouse
			let firstIcon = this.appContainer.get_child_at_index(0);
			if (firstIcon.focusWorkaroundSignal) {
				firstIcon.disconnect(firstIcon.focusWorkaroundSignal);
				firstIcon.disconnect(firstIcon.keyPressSignal);
				firstIcon.focusWorkaroundSignal = 0;
			}

			this.windowClones.forEach(clone => {
				clone.source.show();
				clone.destroy();
			});

			let finalX = this.dashBG.x + 200 * this.animationDir.x;
			let finalY = this.dashBG.y + 200 * this.animationDir.y;
			this.dashBG.ease({
				x: finalX,
				y: finalY,
				opacity: 0,
				duration: windowManager.MINIMIZE_WINDOW_ANIMATION_TIME,
				mode: Clutter.AnimationMode.EASE_OUT_QUINT,
				onComplete: () => this.dashBG.hide()
			});

			let finalX2 = this.windowDash.x + 200 * this.animationDir.x;
			let finalY2 = this.windowDash.y + 200 * this.animationDir.y;
			this.windowDash.ease({
				x: finalX2,
				y: finalY2,
				opacity: 0,
				duration: windowManager.MINIMIZE_WINDOW_ANIMATION_TIME,
				mode: Clutter.AnimationMode.EASE_OUT_QUINT,
				onComplete: () => this.windowDash.hide()
			});

			this.shadeBG.ease({
				opacity: 0,
				duration: windowManager.MINIMIZE_WINDOW_ANIMATION_TIME,
				mode: Clutter.AnimationMode.EASE_OUT_QUINT,
				onComplete: () => {
					this.shadeBG.hide();
				}
			});
		}

		// called with this.appContainer or this.windowDash as this
		focusItemAtIndex(index, maxCount) {
			index = (index < 0) ? maxCount - 1 : index;
			index = (index >= maxCount) ? 0 : index;
			this.get_child_at_index(index).grab_key_focus();
		}

		getAppCount() {
			return this.appContainer.get_n_children();
		}

		openWindowPreview(appIcon) {
			if (!appIcon.hasMultipleWindows())
				return;

			this.windowDash.destroy_all_children();
			this.windowDash.focusedWindow = null;
			this.windowDash.show();
			this.windowDash.set_scale(1, 1);
			this.windowDash.previewedAppIcon = appIcon;

			let windows = appIcon.windows;

			let monitorRect = global.display.get_monitor_geometry(windows[0].get_monitor());
			let size = Math.round(200 * monitorRect.height / 1000); // might need a more consistent way to get a good button size

			// create window previews
			for (let idx = 0, posX = 0; idx < windows.length; idx++) {
				let preview = new TilingWindowPreview(windows[idx], idx, size);
				this.windowDash.add_child(preview);
				preview.set_position(posX, 0);
				posX += preview.width;
			}

			// 30 = margin from stylesheet
			this.windowDash.set_size(windows.length * (size + 30), size + 30);

			// animate opening
			let finalWidth = this.windowDash.width;
			let finalHeight = this.windowDash.height;
			let finalScale = (finalWidth > monitorRect.width * .95) ? monitorRect.width * .95 / finalWidth : 1; // scale to fit screen if its too big
			let finalX = appIcon.get_transformed_position()[0] + appIcon.width / 2 - this.windowDash.width / 2;
			let finalY = this.dashBG.y + ((appIcon.arrowIsAbove) ? - 20 - finalHeight : this.dashBG.height + 20);

			if (finalX + finalWidth > monitorRect.width)
				finalX = monitorRect.width - 20 - finalWidth;
			else if (finalX < monitorRect.x)
				finalX = monitorRect.x + 20;

			this.windowDash.set_position(appIcon.get_transformed_position()[0] - this.windowDash.width / 2 + appIcon.width / 2, appIcon.get_transformed_position()[1] - this.windowDash.height / 2 + appIcon.height / 2);
			this.windowDash.set_scale(0, 0);
			this.windowDash.ease({
				x: (finalScale != 1) ? monitorRect.x + monitorRect.width / 2 - finalWidth / 2 : finalX, // center to screen if scale < 1 else center around appIcon
				y: finalY + ((appIcon.arrowIsAbove) ? 1 : -1) * (finalHeight - finalHeight * finalScale) / 2, // position 20 px above or below Dash respecting the finalScale
				scale_x: finalScale,
				scale_y: finalScale,
				width: finalWidth,
				height: finalHeight,
				opacity: 255,
				duration: 250,
				mode: Clutter.AnimationMode.EASE_OUT_QUINT,
			});

			this.windowDash.get_child_at_index(0).grab_key_focus();
		}

		closeWindowPreview() {
			let currAppIcon = this.windowDash.previewedAppIcon;
			currAppIcon.grab_key_focus();
			this.windowDash.previewedAppIcon = null;

			// scale in to the appIcon
			let finalX = currAppIcon.get_transformed_position()[0] - this.windowDash.width / 2 + currAppIcon.width / 2;
			let finalY = currAppIcon.get_transformed_position()[1] - this.windowDash.height / 2 + currAppIcon.height / 2
			this.windowDash.ease({
				x: finalX,
				y: finalY,
				scale_x: 0,
				scale_y: 0,
				opacity: 0,
				duration: 250,
				mode: Clutter.AnimationMode.EASE_OUT_QUINT,
				onComplete: () => this.windowDash.hide()
			});
		}
	}
);

// pretty much copied from windowManager.js
// only moved the position in the window group above the dragged window because otherwise quarter-sized previews arent visible
var TilingTilePreview = GObject.registerClass(
	class TilingTilePreview extends St.Widget {
		_init() {
			super._init();
			global.window_group.add_actor(this);

			this.reset();
			this.showing = false;
			this.currPos = 0; // Meta.Side
		}

		open(window, pos, tileRect, monitorIndex) {
			let windowActor = window.get_compositor_private();
			if (!windowActor)
				return;

			global.window_group.set_child_above_sibling(this, windowActor);

			if (this.rect && this.rect.equal(tileRect))
				return;

			let changeMonitor = this.monitorIndex == -1 ||
				this.monitorIndex != monitorIndex;

			this.monitorIndex = monitorIndex;
			this.rect = tileRect;
			this.currPos = pos;

			let monitor = main.layoutManager.monitors[monitorIndex];

			// update style class
			let styles = ['tile-preview'];
			if (this.monitorIndex == main.layoutManager.primaryIndex)
				styles.push('on-primary');
			if (this.rect.x == monitor.x)
				styles.push('tile-preview-left');
			if (this.rect.x + this.rect.width == monitor.x + monitor.width)
				styles.push('tile-preview-right');
			this.style_class = styles.join(' ');

			if (!this.showing || changeMonitor) {
				let monitorRect = new Meta.Rectangle({
					x: monitor.x,
					y: monitor.y,
					width: monitor.width,
					height: monitor.height
				});
				let [, rect] = window.get_frame_rect().intersect(monitorRect);
				this.set_size(rect.width, rect.height);
				this.set_position(rect.x, rect.y);
				this.opacity = 0;
			}

			this.showing = true;
			this.show();
			this.ease({
				x: tileRect.x,
				y: tileRect.y,
				width: tileRect.width,
				height: tileRect.height,
				opacity: 255,
				duration: 200,
				mode: Clutter.AnimationMode.EASE_OUT_QUAD,
			});
		}

		close() {
			if (!this.showing)
				return;

			this.showing = false;
			this.currPos = 0;
			this.ease({
				opacity: 0,
				duration: 200,
				mode: Clutter.AnimationMode.EASE_OUT_QUAD,
				onComplete: () => this.reset(),
			});
		}

		reset() {
			this.hide();
			this.rect = null;
			this.monitorIndex = -1;
		}
	}
);

// a lot copied from appDisplay.js
var TilingAppIcon = GObject.registerClass(
	class TilingAppIcon extends St.Button {
		_init(window, idx, iconParams = {}) {
			super._init({
				style_class: 'app-well-app',
				pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 }),
				reactive: true,
				button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO,
				can_focus: true,
			});

			this.index = idx;
			this.window = window;

			this.iconContainer = new St.Widget({
				layout_manager: new Clutter.BinLayout(),
				x_expand: true,
				y_expand: true
			});
			this.set_child(this.iconContainer);

			let winTracker = Shell.WindowTracker.get_default();
			let app = winTracker.get_window_app(window);

			iconParams['createIcon'] = () => app.create_icon_texture(settings.get_int("icon-size"));
			iconParams['setSizeManually'] = true;
			this.icon = new iconGrid.BaseIcon(app.get_name(), iconParams);
			this.iconContainer.add_child(this.icon);

			let tmpWindows = app.get_windows();
			if (tmpWindows.length <= 1)
				return;

			// show arrow indicator if app has multiple windows; ignore the focused window (i. e. the just-tiled window) if its the same app
			let activeWS = global.workspace_manager.get_active_workspace();
			let tiledWindow = global.display.sort_windows_by_stacking(activeWS.list_windows()).reverse()[0];
			this.windows = [];

			for (let i = 0; i < tmpWindows.length; i++) {
				if (!tmpWindows[i].located_on_workspace(activeWS))
					break;

				// dont add the windows to the preview, if they are part of the current tileGroup
				if (tiledWindow.tileGroup) {
					let _continue = false;
					for (let pos in tiledWindow.tileGroup)
						if (tiledWindow.tileGroup[pos] == tmpWindows[i]) {
							_continue = true;
							break;
						}

					if (_continue)
						continue;
				}

				this.windows.push(tmpWindows[i]);
			}

			if (this.windows.length > 1) {
				let workArea = window.get_work_area_current_monitor();
				this.arrowIsAbove = appDash.freeScreenRect.y != workArea.y; // arrow above == true, if free quad is either the bottom left or bottom right quad
				this.arrowContainer = new St.BoxLayout({
					x_expand: true,
					y_expand: true,
					x_align: Clutter.ActorAlign.CENTER,
					y_align: (this.arrowIsAbove) ? Clutter.ActorAlign.START : Clutter.ActorAlign.END,
				});
				this.iconContainer.add_child(this.arrowContainer);

				let arrow = new St.DrawingArea({
					width: 8,
					height: 4,
					style: (this.arrowIsAbove) ? 'margin-top: 2px' : 'margin-bottom: 2px'
				});
				arrow.connect('repaint', () => switcherPopup.drawArrow(arrow, (this.arrowIsAbove) ? St.Side.TOP : St.Side.BOTTOM));
				this.arrowContainer.add_child(arrow);
			}

			this.connect("enter-event", () => {
				this.isHovered = true;

				if (appDash.windowDash.visible && appDash.windowDash.previewedAppIcon != this)
					appDash.closeWindowPreview()

				let sourceID = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
					if (this.isHovered && appDash.shown && appDash.windowDash.previewedAppIcon != this)
						appDash.openWindowPreview(this);
					GLib.source_remove(sourceID);
				});
			});

			this.connect("leave-event", () => {
				this.isHovered = false;
			});
		}

		hasMultipleWindows() {
			return (this.arrowContainer) ? true : false;
		}

		vfunc_key_press_event(keyEvent) {
			switch (keyEvent.keyval) {
				case Clutter.KEY_Right:
					appDash.appContainer.focusItemAtIndex(this.index + 1, appDash.getAppCount());
					return Clutter.EVENT_STOP;

				case Clutter.KEY_Left:
					appDash.appContainer.focusItemAtIndex(this.index - 1, appDash.getAppCount());
					return Clutter.EVENT_STOP;

				case Clutter.KEY_Up:
				case Clutter.KEY_Down:
					appDash.openWindowPreview(this);
					return Clutter.EVENT_STOP;

				case Clutter.KEY_Return:
				case Clutter.KEY_space:
					this.activate();
					return Clutter.EVENT_STOP;

				case Clutter.KEY_Shift_L:
				case Clutter.KEY_Shift_R:
				case 65513: // LAlt
				case 65027: // RAlt
					return Clutter.EVENT_STOP;
			}

			// close the Dash on all other key inputs
			if (appDash.shown)
				appDash.close();

			return Clutter.EVENT_PROPAGATE;
		}

		vfunc_clicked(button) {
			this.activate();
		}

		activate() {
			if (appDash.shown) {
				appDash.close();

				this.icon.animateZoomOut();

				this.window.move_to_monitor(appDash.monitor);
				this.window.activate(global.get_current_time());

				let event = Clutter.get_current_event();
				let modifiers = event ? event.get_state() : 0;
				let isAltPressed = modifiers & Clutter.ModifierType.MOD1_MASK;
				let isShiftPressed = modifiers & Clutter.ModifierType.SHIFT_MASK;
				let workArea = this.window.get_work_area_current_monitor();

				if (isAltPressed) {
					// tile to right if free screen = 2 horizontal quadrants
					if (appDash.freeScreenRect.width == workArea.width) {
						appDash.freeScreenRect.width = workArea.width / 2;
						appDash.freeScreenRect.x = workArea.x + workArea.width / 2;
					// tile to bottom if free screen = 2 vertical quadrants
					} else if (appDash.freeScreenRect.height == workArea.height) {
						appDash.freeScreenRect.height = workArea.height / 2;
						appDash.freeScreenRect.y = workArea.y + workArea.height / 2;
					}

				} else if (isShiftPressed) {
					// tile to left if free screen = 2 horizontal quadrants
					if (appDash.freeScreenRect.width == workArea.width) {
						appDash.freeScreenRect.width = workArea.width / 2;
						appDash.freeScreenRect.x = workArea.x;
					// tile to top if free screen = 2 vertical quadrants
					} else if (appDash.freeScreenRect.height == workArea.height) {
						appDash.freeScreenRect.height = workArea.height / 2;
						appDash.freeScreenRect.y = workArea.y;
					}
				}

				tileWindow(this.window, appDash.freeScreenRect);
			}
		}
	}
);

// copied and trimmed from altTab.WindowIcon
// changed from St.BoxLayout to St.Button
var TilingWindowPreview = GObject.registerClass(
	class TilingWindowPreview extends St.Button {
		_init(window, index, fullSize) {
			super._init({
				style_class: 'tiling-window-unfocused',
				reactive: true,
				button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO,
				can_focus: true,
			});

			this.window = window;
			this.index = index;

			this.iconContainer = new St.Widget({
				layout_manager: new Clutter.BinLayout(),
				x_expand: true,
				y_expand: true,
				width: fullSize,
				height: fullSize,
			});
			this.set_child(this.iconContainer);

			this.icon = altTab._createWindowClone(window.get_compositor_private(), fullSize - 20); // 20 = small gap from preview size to actual window preview
			this.iconContainer.add_child(this.icon);

			this.connect("enter-event", () => {
				if (this.get_style_class_name() != "tiling-window-focused")
					this.set_style_class_name('tiling-window-hovered');
			});

			this.connect("leave-event", () => {
				if (this.get_style_class_name() != "tiling-window-focused")
					this.set_style_class_name('tiling-window-unfocused');
			});
		}

		vfunc_clicked(button) {
			this.activate();
		}

		vfunc_key_focus_in() {
			if (appDash.windowDash.focusedWindow)
				appDash.windowDash.focusedWindow.set_style_class_name("tiling-window-unfocused");
			appDash.windowDash.focusedWindow = this;
			this.set_style_class_name('tiling-window-focused');
		}

		vfunc_key_press_event(keyEvent) {
			switch (keyEvent.keyval) {
				case Clutter.KEY_Right:
					appDash.windowDash.focusItemAtIndex(this.index + 1, appDash.windowDash.previewedAppIcon.windows.length);
					return Clutter.EVENT_STOP;

				case Clutter.KEY_Left:
					appDash.windowDash.focusItemAtIndex(this.index - 1, appDash.windowDash.previewedAppIcon.windows.length);
					return Clutter.EVENT_STOP;

				case Clutter.KEY_Up:
				case Clutter.KEY_Down:
					appDash.closeWindowPreview();
					return Clutter.EVENT_STOP;

				case Clutter.KEY_Return:
				case Clutter.KEY_space:
					this.activate();
					return Clutter.EVENT_STOP;

				case Clutter.KEY_Shift_L:
				case Clutter.KEY_Shift_R:
				case 65513: // LAlt
				case 65027: // RAlt
					return Clutter.EVENT_STOP;
			}

			// close the Dash on all other key inputs
			if (appDash.shown)
				appDash.close();

			return Clutter.EVENT_PROPAGATE;
		}

		activate() {
			if (appDash.shown) {
				appDash.close();

				this.window.move_to_monitor(appDash.monitor);
				this.window.activate(global.get_current_time());

				let event = Clutter.get_current_event();
				let modifiers = event ? event.get_state() : 0;
				let isAltPressed = modifiers & Clutter.ModifierType.MOD1_MASK;
				let isShiftPressed = modifiers & Clutter.ModifierType.SHIFT_MASK;
				let workArea = this.window.get_work_area_current_monitor();

				if (isAltPressed) {
					// tile to right if free screen = 2 horizontal quadrants
					if (appDash.freeScreenRect.width == workArea.width) {
						appDash.freeScreenRect.width = workArea.width / 2;
						appDash.freeScreenRect.x = workArea.x + workArea.width / 2;
						
					// tile to bottom if free screen = 2 vertical quadrants
					} else if (appDash.freeScreenRect.height == workArea.height) {
						appDash.freeScreenRect.height = workArea.height / 2;
						appDash.freeScreenRect.y = workArea.y + workArea.height / 2;
					}

				} else if (isShiftPressed) {
					// tile to left if free screen = 2 horizontal quadrants
					if (appDash.freeScreenRect.width == workArea.width) {
						appDash.freeScreenRect.width = workArea.width / 2;
						appDash.freeScreenRect.x = workArea.x;

					// tile to top if free screen = 2 vertical quadrants
					} else if (appDash.freeScreenRect.height == workArea.height) {
						appDash.freeScreenRect.height = workArea.height / 2;
						appDash.freeScreenRect.y = workArea.y;
					}
				}

				tileWindow(this.window, appDash.freeScreenRect);
			}
		}
	}
);