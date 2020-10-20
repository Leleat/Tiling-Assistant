const Lang = imports.lang;
const {main, iconGrid} = imports.ui;
const {GObject, GLib, St, Shell, Clutter, Meta, Graphene} = imports.gi;

let openWindowsDash = null;
let oldWindowPos = {}; // {windowID : frameRect} // also used as a list of tiled windows, closed windows wont be removed though (no harm because of that)
let windowGrabSignals = {}; // {windowID : signalID}

let ICON_SIZE;
let ICON_MARGIN;
let SHOW_LABEL;

function init() {
}

function enable() {
	ICON_SIZE = 75;
	ICON_MARGIN = 20;
	SHOW_LABEL = false;
	
	// signal connections
	this.windowGrabBegin = global.display.connect('grab-op-begin', onGrabBegin.bind(this) );
	this.windowGrabEnd = global.display.connect("grab-op-end", onGrabEnd.bind(this));
	this.shortcutPressed = global.window_manager.connect( "filter-keybinding", onShortcutPressed.bind(this));
	this.maximizedStateChanged = global.window_manager.connect("size-change", onSizeChanged.bind(this));

	openWindowsDash = new OpenWindowsDash();
}

function disable() {
	// disconnect signals
	global.display.disconnect(this.windowGrabBegin);
	global.display.disconnect(this.windowGrabEnd);
	global.window_manager.disconnect(this.shortcutPressed);
	global.window_manager.disconnect(this.maximizedStateChanged);

	openWindowsDash._destroy();
	ICON_SIZE = null;
	ICON_MARGIN = null;
	SHOW_LABEL = null;
}

function tileWindow(window, side) {
	if (!window)
		return;

	if (window.get_maximized())
		window.unmaximize(window.get_maximized());
		
	if (window.allows_resize() && window.allows_move()) {
		oldWindowPos[window.get_id()] = window.get_frame_rect();

		// only tile vertically full-sized (like GNOME)
		let workArea = window.get_work_area_current_monitor();
		let x;
		let y = workArea.y;
		let height = workArea.height;
		let width = workArea.width / 2;

		switch (side) {
			case Meta.Side.LEFT:
				x = workArea.x;
				break;

			case Meta.Side.RIGHT:
				x = workArea.x + width;
		}

		window.move_resize_frame(true, x, y, width, height);
		window.maximize(Meta.MaximizeFlags.VERTICAL);
		window.focus(global.get_current_time());
	}
};

// called whenever the maximize state of a window is changed (and maybe at other times as well?)
function onSizeChanged(shellwm, actor, whichChange, oldFrameRect, _oldBufferRect) {
	// timer to get the correct new window pos and size
	let sourceID = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
		let window = global.display.focus_window;
		if (window && window.get_maximized() == Meta.MaximizeFlags.VERTICAL && !openWindowsDash.isVisible()) {
			let openWindows = global.workspace_manager.get_active_workspace().list_windows();
			let complementingWindow = getComplementingWindow(window);

			if ( openWindows.length > 1 && !complementingWindow )
				openWindowsDash.open(openWindows, window);
		}

		GLib.source_remove(sourceID);
	});
};

// restore windows which were tiled with this extension and tiling keyboard shortcut pressed
function onShortcutPressed(shellWM, keyBinding) {
	if (openWindowsDash.isVisible()) {
		openWindowsDash.close();
		return;
	}
	
	let window = global.display.focus_window;
	if (!window)
		return;

	let workArea = window.get_work_area_current_monitor();
	let sourceID = 0;

	switch(keyBinding.get_name()) {
		case "toggle-tiled-left":
			if ( (window.get_frame_rect().x - workArea.x < 5) ) // window is on the left on the current monitor (with a margin)
				if (window.get_id() in oldWindowPos)
					sourceID = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => { // timer needed because first the split view will be entered
						restoreWindowSize(window, true);
						GLib.source_remove(sourceID);
					});
			break;

		case "toggle-tiled-right":
			if ( (window.get_frame_rect().x - workArea.x > 5) ) // window is on the right on the current monitor (with a margin)
				if (window.get_id() in oldWindowPos)
					sourceID = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => { // timer needed because first the split view will be entered
						restoreWindowSize(window, true);
						GLib.source_remove(sourceID);
					});
			break;
	}
};

// calls either restoreWindowSize() or resizeComplementingWindows() depending on where the drag began on the window
function onGrabBegin(_metaDisplay, metaDisplay, window, grabOp) {
	if (!window)
		return;

	switch (grabOp) {
		case Meta.GrabOp.MOVING:
			restoreWindowSize(window);
			break;
		
		case Meta.GrabOp.RESIZING_E:
		case Meta.GrabOp.RESIZING_W:
			let complementingWindow = getComplementingWindow(window);
			if ( complementingWindow && (complementingWindow.get_id() in oldWindowPos || window.get_id() in oldWindowPos) )
				windowGrabSignals[window.get_id()] = window.connect("size-changed", resizeComplementingWindows.bind(this, window, complementingWindow));
	}
};

function onGrabEnd(_metaDisplay, metaDisplay, window, grabOp) {
	if ( window && windowGrabSignals[window.get_id()] )
		window.disconnect( windowGrabSignals[window.get_id()] );
};

// Known Issue: 
// calculation for newPosX seems correct. But it only works when starting the drag in the Topbar AND not moving. After that the window will teleport to a different pos. Same if moving via the window titlebar.
function restoreWindowSize(window, restoreFullPos = false) {
	if (window && !(window.get_id() in oldWindowPos) )
		return;

	if (window.get_maximized())
		window.unmaximize(window.get_maximized());

	if (window.allows_resize() && window.allows_move()) {
		let windowID = window.get_id();
		let currWindowFrame = window.get_frame_rect();
		let [mouseX] = global.get_pointer();
		let relativeMouseX = (mouseX - currWindowFrame.x) / currWindowFrame.width; // percentage (in decimal) where the mouse.x is in the current window size
		let newPosX = mouseX - oldWindowPos[windowID].width * relativeMouseX; // position the window after scaling, so that the mouse is at the same relative position.x e.g. mouse was at 50% of the old window and will be at 50% of the new one

		if (restoreFullPos)
			window.move_resize_frame(true, oldWindowPos[windowID].x, oldWindowPos[windowID].y, oldWindowPos[windowID].width, oldWindowPos[windowID].height);

		else // scale while keeping the top at the same y pos
			window.move_resize_frame(true, newPosX, currWindowFrame.y, oldWindowPos[windowID].width, oldWindowPos[windowID].height);

		delete oldWindowPos[windowID];
	}
};

// get the complementing window to w; i.e. the window which - together with w - fills (close to) the entire monitor
function getComplementingWindow(w) {
	let workArea = w.get_work_area_for_monitor(w.get_monitor());
	let resizeRect = w.get_frame_rect();
	let openWindows = global.workspace_manager.get_active_workspace().list_windows();
	openWindows = global.display.sort_windows_by_stacking(openWindows);
	
	let equalApprox = function(value, target, margin) {
		if (value >= target - margin && value <= target + margin)
			return true;
		return false;
	};

	for (let i = Math.max(0, openWindows.length - 2); i < openWindows.length; i++) { // only check last 2 windows (i. e. the 2 top most stacked windows)
		if (openWindows[i].get_id() == w.get_id() || !openWindows[i].maximized_vertically)
			continue;
		
		let otherRect = openWindows[i].get_frame_rect();
		// (1: windows width = 1/2 monitor width && 2: both windows are distanced at different positions... sorta)
		if (equalApprox(resizeRect.width + otherRect.width, workArea.width, 15) && Math.abs(resizeRect.x - otherRect.x) > 15)
			return openWindows[i];
	}

	return null;
};

function resizeComplementingWindows(resizedWindow, complementingWindow) {
	let workArea = resizedWindow.get_work_area_current_monitor(); 
	let complementingFrame = complementingWindow.get_frame_rect();
	let resizedFrame = resizedWindow.get_frame_rect();	

	// complementingWindow.move_resize_frame() doesn't work if one window is tiled with this extension (A) and the other one with GNOME's tiling feature (B) AND the one being resized is (A).
	// If (B) is being resized, it works again... resizedWindow and complementingWindow seem to be correctly passed to this function... so I dont know why it doesnt work.
	// thats why I tile (B) with this extension
	if (!(complementingWindow.get_id() in oldWindowPos)) {
		let side = (resizedFrame.x > complementingFrame.x) ? Meta.Side.RIGHT : Meta.Side.LEFT;
		tileWindow(complementingWindow, side);
	}

	complementingWindow.move_resize_frame(true, (complementingFrame.x < resizedFrame.x) ? complementingFrame.x : workArea.x + resizedFrame.width, complementingFrame.y, workArea.width - resizedFrame.width, complementingFrame.height);
};

var OpenWindowsDash = GObject.registerClass(
	class OpenWindowsDash extends St.Widget {
		_init() {
			super._init();

			// for move direction of the Dash
			this.animationDir = 1;

			// darken BG to easily focus this Dash
			this.darkenBG = new St.Widget({
				style: ("background-color : black"),
				x: 0,
				y: 0,
				opacity: 0
			});
			global.window_group.add_child(this.darkenBG);
			this.darkenBG.hide();

			// hide Dash on mouse clicks
			this.mouseCatcher = new St.Widget({
				reactive: true,
				x: 0,
				y: 0,
			});
			main.layoutManager.addChrome(this.mouseCatcher);
			this.mouseCatcher.hide();
			this.onMouseCaught = this.mouseCatcher.connect("button-press-event", () => {
				if (this.isVisible()) 
					this.close();
			});

			// visual BG for the Dash
			this.bgGrid = new St.Widget({
				height: ICON_SIZE + 16 + ICON_MARGIN + ((SHOW_LABEL) ? 28 : 0), // magicNr are margins/paddings from the icon to the full-sized highlighted button
				style_class: "my-open-windows-dash",
			});
			main.layoutManager.addChrome(this.bgGrid);
			this.bgGrid.hide();

			// container for apps, centered in bgGrid
			this.appContainer = new St.Widget();
			this.appContainer.focusItemAtIndex = this.focusItemAtIndex;
			this.bgGrid.add_child(this.appContainer);
		}

		_destroy() {
			this.darkenBG.destroy();
			this.mouseCatcher.disconnect(this.onMouseCaught);
			this.mouseCatcher.destroy();
			this.bgGrid.destroy();
			this.destroy();
		}

		open(openWindows, tiledWindow) {
			this.appContainer.destroy_all_children();
			let workArea = tiledWindow.get_work_area_current_monitor();
			let entireWorkArea = tiledWindow.get_work_area_all_monitors();

			// fill appContainer
			let winTracker = Shell.WindowTracker.get_default();
			let side = (tiledWindow.get_frame_rect().x == workArea.x) ? Meta.Side.RIGHT : Meta.Side.LEFT;
			this.appContainer.appCount = 0;
			let pos = 0;

			openWindows.forEach(w => {
				if (w.get_id() != tiledWindow.get_id()) {
					let app = new OpenAppIcon(winTracker.get_window_app(w), w, this.appContainer.appCount++, side, tiledWindow.get_monitor(), {showLabel: SHOW_LABEL});
					this.appContainer.add_child(app);
					app.set_position(pos, 0);
					pos += ICON_SIZE + 16 + ICON_MARGIN + ((SHOW_LABEL) ? 28 : 0); // magicNr are margins/paddings from the icon to the full-sized highlighted button
				}
			});

			// timer needed to correctly calculate the center position because the app.height isnt correct without a timer
			let sourceID = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1, () => {
				this.appContainer.get_children().forEach(app => {
					app.set_position(app.get_position()[0], this.bgGrid.height / 2 - app.height / 2);
				});

				GLib.source_remove(sourceID);
			});

			// setup bgGrid
			this.bgGrid.show();
			this.bgGrid.set_width(pos);
			this.bgGrid.set_position((tiledWindow.get_frame_rect().x != workArea.x) // tiledWindow is on right (or not)
					? workArea.x + workArea.width / 4 - this.bgGrid.width / 2 // Dash will be centered on the left half
					: workArea.width * 3/4 - this.bgGrid.width / 2 // Dash will be centered on the right half
					, workArea.height / 2 - this.bgGrid.height / 2);
			
			// setup appContainer
			this.appContainer.set_position(this.bgGrid.width / 2 - this.appContainer.width / 2, this.appContainer.y);
			this.appContainer.get_child_at_index(0).grab_key_focus();

			// move bgContainer FROM final pos to animate (move) to final pos
			let _finalX = this.bgGrid.x;
			this.animationDir = (tiledWindow.get_frame_rect().x != workArea.x) ? 1 : -1;
			this.bgGrid.set_position(_finalX + 100 * this.animationDir, this.bgGrid.y);
			this.bgGrid.ease({
				x: _finalX,
				opacity: 255,
				duration: 150,
				mode: Clutter.AnimationMode.EASE_OUT_QUINT,
			});

			// setup darkenBG
			let windowActor = tiledWindow.get_compositor_private();
			if (windowActor)
				global.window_group.set_child_below_sibling(this.darkenBG, windowActor);

			this.darkenBG.set_size(entireWorkArea.width, entireWorkArea.height);
			this.darkenBG.show();
			this.darkenBG.ease({
				opacity: 180,
				duration: 150,
				mode: Clutter.AnimationMode.EASE_OUT_QUINT,
			});

			// setup mouseCatcher
			this.mouseCatcher.show();
			this.mouseCatcher.set_size(entireWorkArea.width, entireWorkArea.height);
		}

		close() {
			this.mouseCatcher.hide();

			let finalX = this.bgGrid.x + 100 * this.animationDir;
			this.bgGrid.ease({
				x: finalX,
				opacity: 0,
				duration: 150,
				mode: Clutter.AnimationMode.EASE_OUT_QUINT,
				onComplete: () => this.bgGrid.hide()
			});

			this.darkenBG.ease({
				opacity: 0,
				duration: 150,
				mode: Clutter.AnimationMode.EASE_OUT_QUINT,
				onComplete: () => this.darkenBG.hide()
			});
		}

		// called with this.appContainer as this
		focusItemAtIndex(index) {
			// wrap around
			index = (index < 0) ? this.appCount - 1 : index;
			index = (index >= this.appCount) ? 0 : index;

			this.get_child_at_index(index).grab_key_focus();
		}
		
		isVisible() {
			return this.bgGrid.visible;
		}
	}
);

// mostly copied and trimmed from appDisplay.js
var OpenAppIcon = GObject.registerClass( 
	class OpenAppIcon extends St.Button {
		_init(app, win, idx, side, moveToMonitorNr, iconParams = {}) {
			super._init({
				style_class: 'app-well-app',
				pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 }),
				reactive: true,
				button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO,
				can_focus: true,
			});

			this.index = idx;
			this.window = win;
			this.side = side;
			this.moveToMonitorNr = moveToMonitorNr;
	
			this.iconContainer = new St.Widget({ layout_manager: new Clutter.BinLayout(),
												  x_expand: true, y_expand: true });
	
			this.set_child(this.iconContainer);
	
			iconParams['createIcon'] = this._createIcon.bind(this, app, ICON_SIZE);
			iconParams['setSizeManually'] = true;
			this.icon = new iconGrid.BaseIcon(app.get_name(), iconParams);
			this.iconContainer.add_child(this.icon);
		}

		vfunc_key_press_event(keyEvent) {
			switch (keyEvent.keyval) {
				case Clutter.KEY_Right:
					this.get_parent().focusItemAtIndex(this.index + 1);
					return Clutter.EVENT_STOP;

				case Clutter.KEY_Left:
					this.get_parent().focusItemAtIndex(this.index - 1);
					return Clutter.EVENT_STOP;

				case Clutter.KEY_Return:
				case Clutter.KEY_space:
					this.activate();
					return Clutter.EVENT_STOP;
			}
			
			// close the Dash on all other key inputs
			if (openWindowsDash.isVisible())
				openWindowsDash.close();

			return Clutter.EVENT_PROPAGATE;
		}

		_createIcon(app, iconSize) {
			return app.create_icon_texture(iconSize);
		}

		vfunc_clicked(button) {
			this.activate(button);
		}

		activate(button) {
			if (openWindowsDash.isVisible()) {
				openWindowsDash.close();
				
				this.icon.animateZoomOut();

				this.window.move_to_monitor(this.moveToMonitorNr);
				this.window.activate(global.get_current_time());
				tileWindow(this.window, this.side);
			}
		}
	}
);