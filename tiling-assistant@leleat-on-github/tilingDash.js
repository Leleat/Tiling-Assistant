const {altTab, appDisplay, iconGrid, main, panel, switcherPopup, windowManager} = imports.ui;
const {Clutter, GLib, GObject, Graphene, Shell, St} = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const MyExtension = Me.imports.extension
const Funcs = Me.imports.funcs;

// the Dash which contains the TilingAppIcons to auto-fill the empty screen space
var TilingAppSwitcherPopup = GObject.registerClass(
	class TilingAppSwitcherPopup extends St.Widget {
		_init(iconSize, iconMargin, showIconLabel) {
			super._init();

            this.iconSize = iconSize;
            this.iconMargin = iconMargin;
            this.showIconLabel = showIconLabel;
			this.shown = false;

			// for animation move direction of the Dash.
			// Dash will move from the tiled window dir to the center of the free screen space
			this.animationDir = { x: 0, y: 0 };

			// shade BG when the Dash is open for easier visibility
			this.shadeBG = new St.Widget({
				style: ("background-color : black"),
				x: 0, y: 0,
				opacity: 0
			});
			global.window_group.add_child(this.shadeBG);
			this.shadeBG.hide();

			// clones to show above the shadeBG (which is just below the tiledWindow)
			this.windowClones = [];

			// hide Dash on mouse clicks
			this.mouseCatcher = new St.Widget({
				reactive: true,
				x: 0, y: 0,
			});
			main.layoutManager.addChrome(this.mouseCatcher);
			this.mouseCatcher.hide();
			this.mouseCatcher.connect("button-press-event", () => {
				if (this.shown)
					this.close(true);
			});

			// visual BG for the windows if an app has multiple open windows
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
			this.mouseCatcher.destroy();
			this.dashBG.destroy();
			this.windowDash.destroy();
			this.destroy();
		}

		// open when a window is tiled and when there is screen space available
		open(openWindows, tiledWindow, monitorNr, freeScreenRect, layout = null) {
			this.shown = true;
            this.appContainer.destroy_all_children();
            
			this.freeScreenRect = freeScreenRect;
			this.tilingLayout = layout;
			this.openWindows = openWindows;
			this.monitor = monitorNr;
			let monitorScale = global.display.get_monitor_scale(monitorNr);
			let buttonSize = monitorScale * (this.iconSize + 16 + this.iconMargin + ((this.showIconLabel) ? 28 : 0));

			this._setupAppContainer(buttonSize, monitorScale);
			this._setupDashBg(buttonSize, tiledWindow);
			this._shadeBackground(tiledWindow);
			this._setupMouseCatcher();

			if (Array.isArray(layout)) {
				this.layoutPreview = new St.Widget({
					style_class: "tile-preview",
					x: freeScreenRect.x + freeScreenRect.width / 2,
					y: freeScreenRect.y + freeScreenRect.height / 2,
				});
				global.window_group.add_child(this.layoutPreview);

				this.layoutPreview.ease({
					x: freeScreenRect.x,
					y: freeScreenRect.y,
					width: freeScreenRect.width,
					height: freeScreenRect.height,
					duration: windowManager.MINIMIZE_WINDOW_ANIMATION_TIME,
					mode: Clutter.AnimationMode.EASE_OUT_QUAD,
				});
			}
		}

		close(clearTilingLayout = false) {
			this.shown = false;
			this.mouseCatcher.hide();
			this.shadeBG.hide();

			if (clearTilingLayout) {
				this.tilingLayout = [];
				this.openWindows = [];
			}
			if (this.layoutPreview) {
				this.layoutPreview.destroy();
				this.layoutPreview = null;
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
				onComplete: () => {
					this.dashBG.hide();
				}
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
		}

		_setupAppContainer(buttonSize, monitorScale) {
			let windowCount = this.openWindows.length;
			this.appContainer.set_size(windowCount * buttonSize, buttonSize);
			this.appContainer.set_position(this.iconMargin / 2 * monitorScale, this.iconMargin / 2 * monitorScale);

			for (let idx = 0, posX = 0; idx < windowCount; idx++, posX += buttonSize) {
				let appIcon = new TilingAppIcon(this.iconSize, this.openWindows[idx], idx, { showLabel: this.showIconLabel });
				this.appContainer.add_child(appIcon);
				appIcon.set_position(posX, 0);
			}
		}

		_setupDashBg(buttonSize, tiledWindow) {
			this.dashBG.set_size(this.openWindows.length * buttonSize, buttonSize);
			this.dashBG.set_scale(1, 1);

			// scale Dash to fit the freeScreenRect
			if (this.dashBG.width > this.freeScreenRect.width * .95) {
				let scale = this.freeScreenRect.width * .95 / this.dashBG.width;
				this.dashBG.set_scale(scale, scale);
			}

			this.dashBG.show();
			this.dashBG.set_position(this.freeScreenRect.x + this.freeScreenRect.width / 2 - this.dashBG.width / 2
					, this.freeScreenRect.y + this.freeScreenRect.height / 2 - this.dashBG.height / 2);

			// move bgContainer FROM final pos to animate TO final pos
			let finalX = this.dashBG.x;
			let finalY = this.dashBG.y;
			this.animationDir.x = Math.sign(((tiledWindow) ? tiledWindow.tiledRect.x : 0) - this.freeScreenRect.x); // tiledWindow = null on first tiling of layout
			this.animationDir.y = Math.sign(((tiledWindow) ? tiledWindow.tiledRect.y : 0) - this.freeScreenRect.y);
			this.dashBG.set_position(finalX + 400 * this.animationDir.x, this.dashBG.y + 400 * this.animationDir.y);
			this.dashBG.ease({
				x: finalX,
				y: finalY,
				opacity: 255,
				duration: windowManager.WINDOW_ANIMATION_TIME,
				mode: Clutter.AnimationMode.EASE_OUT_QUINT,
			});
		}

		_shadeBackground(tiledWindow) {
			this.windowClones = [];

			if (tiledWindow) {
                // create clones to show above the shade (only when not using layouts)
                for (let w of tiledWindow.tileGroup) {
                    // tiling via layout ignores tilegroup and only checks if it was tiled via the layout
                    if (this.tilingLayout && this.tilingLayout.length > 0 && this.tiledViaLayout && !this.tiledViaLayout.includes(w))
                        continue;

                    if (w && w != tiledWindow) {
                        let wA = w.get_compositor_private();
                        let clone = new Clutter.Clone({
                            source: wA,
                            x: wA.x,
                            y: wA.y
                        });
                        wA.hide();
                        global.window_group.add_child(clone);
                        this.windowClones.push(clone);
                    }
                }
	
				// shadeBG wont be set properly on consecutive tiling (i. e. holding shift/alt when tiling).
				// signal used as a workaround; not sure if this is the right/best signal to use
				let tiledWindowActor = tiledWindow.get_compositor_private();
				let sID = tiledWindowActor.connect("queue-redraw", () => {
					global.window_group.set_child_below_sibling(this.shadeBG, tiledWindowActor);
					this.windowClones.forEach(clone => global.window_group.set_child_below_sibling(clone, tiledWindowActor));
	
					// first icon grabs key focus
					// here to prevent focus issues on consecutive tiling
					this.appContainer.get_child_at_index(0).grab_key_focus();
	
					tiledWindowActor.disconnect(sID);
				});

			// no tiledWindow on first rect when using layouts
			} else {
				global.window_group.remove_child(this.shadeBG);
				global.window_group.add_child(this.shadeBG);
				this.appContainer.get_child_at_index(0).grab_key_focus();
			}

			let entireWorkArea = global.workspace_manager.get_active_workspace().get_work_area_all_monitors();
			this.shadeBG.set_size(entireWorkArea.width, entireWorkArea.height + main.panel.height);
			this.shadeBG.set_position(entireWorkArea.x, entireWorkArea.y);
			this.shadeBG.show();
			this.shadeBG.ease({
				opacity: 180,
				duration: windowManager.WINDOW_ANIMATION_TIME,
				mode: Clutter.AnimationMode.EASE_OUT_QUINT,
			});
		}

		_setupMouseCatcher() {
			this.mouseCatcher.show();
			let monitorRect = global.display.get_monitor_geometry(this.monitor);
			this.mouseCatcher.set_size(monitorRect.width, monitorRect.height);
			this.mouseCatcher.set_position(0, 0);
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
			let windowCount = windows.length;

			let monitorRect = global.display.get_monitor_geometry(windows[0].get_monitor());
			let size = Math.round(200 * monitorRect.height / 1000); // might need a more consistent way to get a good button size

			// create window previews
			for (let idx = 0, posX = 0; idx < windowCount; idx++) {
				let preview = new TilingWindowPreview(appIcon, windows[idx], idx, size);
				this.windowDash.add_child(preview);
				preview.set_position(posX, 0);
				posX += preview.width;
			}

			// 30 = margin from stylesheet
			this.windowDash.set_size(windowCount * (size + 30), size + 30);

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
				onComplete: () => {
					this.windowDash.hide();
					this.windowDash.destroy_all_children();
				}
			});
		}
	}
);

// some stuff from appDisplay.js
// app icons which populate TilingDash
var TilingAppIcon = GObject.registerClass(
	class TilingAppIcon extends St.Button {
		_init(iconSize, window, idx, iconParams = {}) {
			super._init({
				style_class: "app-well-app",
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
			this.app = winTracker.get_window_app(window);

			iconParams["createIcon"] = () => this.app.create_icon_texture(iconSize);
			iconParams["setSizeManually"] = true;
			this.icon = new iconGrid.BaseIcon(this.app.get_name(), iconParams);
			this.iconContainer.add_child(this.icon);

			let tmpWindows = this.app.get_windows();
			let windowCount = tmpWindows.length
			if (windowCount <= 1)
				return;

			// show arrow indicator if app has multiple windows; ignore the focused window (i. e. the just-tiled window) if its the same app
			let activeWS = global.workspace_manager.get_active_workspace();
			let tiledWindow = global.display.sort_windows_by_stacking(activeWS.list_windows()).reverse()[0];
			this.windows = [];

			for (let i = 0; i < windowCount; i++) {
                let w = tmpWindows[i];
				if (!w.located_on_workspace(activeWS))
                    break;
                
                // tiling via layout
                if (MyExtension.appDash.tilingLayout && MyExtension.appDash.tilingLayout.length > 0 && MyExtension.appDash.tiledViaLayout) {
                    // dont add window if it is tiled via layouts
                    if (MyExtension.appDash.tiledViaLayout.includes(w))
                        continue;
                    
                } else {
                    // dont add the windows to the preview, if they are part of the current tileGroup
                    if (tiledWindow.tileGroup) {
                        let _continue = false;
                        for (let pos in tiledWindow.tileGroup)
                            if (tiledWindow.tileGroup[pos] == w) {
                                _continue = true;
                                break;
                            }
    
                        if (_continue)
                            continue;
                    }

				}

				this.windows.push(w);
			}

			if (this.windows.length > 1) {
				let workArea = window.get_work_area_current_monitor();
				this.arrowIsAbove = MyExtension.appDash.freeScreenRect.y != workArea.y; // arrow above == true, if free quad is either the bottom left or bottom right quad
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
					style: (this.arrowIsAbove) ? "margin-top: 2px; color: white" : "margin-bottom: 2px; color: white"
				});
				arrow.connect("repaint", () => switcherPopup.drawArrow(arrow, (this.arrowIsAbove) ? St.Side.TOP : St.Side.BOTTOM));
				this.arrowContainer.add_child(arrow);
			}

			this.connect("enter-event", () => {
				this.isHovered = true;

				if (MyExtension.appDash.windowDash.visible && MyExtension.appDash.windowDash.previewedAppIcon != this)
					MyExtension.appDash.closeWindowPreview()

				GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
					if (this.isHovered && MyExtension.appDash.shown && MyExtension.appDash.windowDash.previewedAppIcon != this)
						MyExtension.appDash.openWindowPreview(this);
					
					return GLib.SOURCE_REMOVE;
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
					MyExtension.appDash.appContainer.focusItemAtIndex(this.index + 1, MyExtension.appDash.getAppCount());
					return Clutter.EVENT_STOP;

				case Clutter.KEY_Left:
					MyExtension.appDash.appContainer.focusItemAtIndex(this.index - 1, MyExtension.appDash.getAppCount());
					return Clutter.EVENT_STOP;

				case Clutter.KEY_Up:
				case Clutter.KEY_Down:
					MyExtension.appDash.openWindowPreview(this);
					return Clutter.EVENT_STOP;

				case Clutter.KEY_Return:
				case Clutter.KEY_space:
					this.activate(this.window);
					return Clutter.EVENT_STOP;

				case Clutter.KEY_Shift_L:
				case Clutter.KEY_Shift_R:
				case 65513: // LAlt
				case 65027: // RAlt
					return Clutter.EVENT_STOP;
			}

			// close the Dash on all other key inputs
			if (MyExtension.appDash.shown)
				MyExtension.appDash.close(true);

			return Clutter.EVENT_PROPAGATE;
		}

		vfunc_clicked(button) {
			this.activate(this.window);
		}

		activate(window) {
			if (MyExtension.appDash.shown) {
				MyExtension.appDash.close();

				this.icon.animateZoomOut();

				window.move_to_monitor(MyExtension.appDash.monitor);
				window.activate(global.get_current_time());

				let event = Clutter.get_current_event();
				let modifiers = event ? event.get_state() : 0;
				let isAltPressed = modifiers & Clutter.ModifierType.MOD1_MASK;
				let isShiftPressed = modifiers & Clutter.ModifierType.SHIFT_MASK;

				let tileInLayout = MyExtension.appDash.tilingLayout && MyExtension.appDash.tilingLayout.length > 0;

				if (!tileInLayout) {
					if (isAltPressed) {
						if (MyExtension.appDash.freeScreenRect.width >= MyExtension.appDash.freeScreenRect.height * 1.25) { // prefer vertical tiling more (because of horizontal screen orientation)
							MyExtension.appDash.freeScreenRect.x = MyExtension.appDash.freeScreenRect.x + MyExtension.appDash.freeScreenRect.width / 2;
							MyExtension.appDash.freeScreenRect.width = MyExtension.appDash.freeScreenRect.width / 2;
	
						} else {
							MyExtension.appDash.freeScreenRect.y = MyExtension.appDash.freeScreenRect.y + MyExtension.appDash.freeScreenRect.height / 2;
							MyExtension.appDash.freeScreenRect.height = MyExtension.appDash.freeScreenRect.height / 2;
						}
	
					} else if (isShiftPressed) {
						if (MyExtension.appDash.freeScreenRect.width >= MyExtension.appDash.freeScreenRect.height * 1.25) // prefer vertical tiling more (because of horizontal screen orientation)
							MyExtension.appDash.freeScreenRect.width = MyExtension.appDash.freeScreenRect.width / 2;
	
						else
							MyExtension.appDash.freeScreenRect.height = MyExtension.appDash.freeScreenRect.height / 2;
					}
				}

				Funcs.tileWindow(window, MyExtension.appDash.freeScreenRect, !tileInLayout);

				if (tileInLayout) {
					// save the windows which were tiled as part of a layout to remove them from the openWindows.
					// cant use tileGroup here
					if (!MyExtension.appDash.tiledViaLayout)
						MyExtension.appDash.tiledViaLayout = [];
					
					MyExtension.appDash.tiledViaLayout.push(window);

					// remove windows from openWindows, if they were tiled with the current layout
					let allWindowsTiledInLayout = true;
					let idx = MyExtension.appDash.openWindows.indexOf(window);
					let appWindows = this.app.get_windows().filter(w => w.located_on_workspace(global.workspace_manager.get_active_workspace()));
					for (let i = 0; i < appWindows.length; i++) {
						let w = appWindows[i];
						if (MyExtension.appDash.tiledViaLayout.includes(w))
							continue;

						allWindowsTiledInLayout = false;
						MyExtension.appDash.openWindows[idx] = w;
						break;
					}

					if (allWindowsTiledInLayout)
						MyExtension.appDash.openWindows.splice(idx, 1);

					if (!MyExtension.appDash.openWindows.length) {
						MyExtension.appDash.tiledViaLayout = [];
						return;
					}

					let freeScreenRect = MyExtension.appDash.tilingLayout.shift();
					if (!MyExtension.appDash.tilingLayout.length)
						MyExtension.appDash.tiledViaLayout = [];

					MyExtension.appDash.open(MyExtension.appDash.openWindows, window, window.get_monitor(), freeScreenRect, MyExtension.appDash.tilingLayout)
				}
			}
		}
	}
);

// some stuff from altTab.WindowIcon
// the window preview, if a TilingAppIcon has multiple windows open on the current workspace
var TilingWindowPreview = GObject.registerClass(
	class TilingWindowPreview extends St.Button {
		_init(appIcon, window, index, fullSize) {
			super._init({
				style_class: "tiling-window-unfocused",
				reactive: true,
				button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO,
				can_focus: true,
			});

			this.appIcon = appIcon;
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
					this.set_style_class_name("tiling-window-hovered");
			});

			this.connect("leave-event", () => {
				if (this.get_style_class_name() != "tiling-window-focused")
					this.set_style_class_name("tiling-window-unfocused");
			});
		}

		vfunc_clicked(button) {
			this.appIcon.activate(this.window);
		}

		vfunc_key_focus_in() {
			if (MyExtension.appDash.windowDash.focusedWindow)
				MyExtension.appDash.windowDash.focusedWindow.set_style_class_name("tiling-window-unfocused");
			MyExtension.appDash.windowDash.focusedWindow = this;
			this.set_style_class_name("tiling-window-focused");
		}

		vfunc_key_press_event(keyEvent) {
			switch (keyEvent.keyval) {
				case Clutter.KEY_Right:
					MyExtension.appDash.windowDash.focusItemAtIndex(this.index + 1, MyExtension.appDash.windowDash.previewedAppIcon.windows.length);
					return Clutter.EVENT_STOP;

				case Clutter.KEY_Left:
					MyExtension.appDash.windowDash.focusItemAtIndex(this.index - 1, MyExtension.appDash.windowDash.previewedAppIcon.windows.length);
					return Clutter.EVENT_STOP;

				case Clutter.KEY_Up:
				case Clutter.KEY_Down:
					MyExtension.appDash.closeWindowPreview();
					return Clutter.EVENT_STOP;

				case Clutter.KEY_Return:
				case Clutter.KEY_space:
					this.appIcon.activate(this.window);
					return Clutter.EVENT_STOP;

				case Clutter.KEY_Shift_L:
				case Clutter.KEY_Shift_R:
				case 65513: // LAlt
				case 65027: // RAlt
					return Clutter.EVENT_STOP;
			}

			// close the Dash on all other key inputs
			if (MyExtension.appDash.shown)
				MyExtension.appDash.close();

			return Clutter.EVENT_PROPAGATE;
		}
	}
);