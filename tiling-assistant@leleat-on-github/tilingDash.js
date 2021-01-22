"use strict";

const {altTab, main, switcherPopup} = imports.ui;
const {Clutter, GLib, GObject, Graphene, Meta, Shell, St} = imports.gi;

const Me = imports.misc.extensionUtils.getCurrentExtension();
const MyExtension = Me.imports.extension;
const Util = Me.imports.util;

function openDash(openWindows, tiledWindow, monitorNr, freeScreenSpace) {
	if (openWindows.length == 0)
		return;

	new MyTilingDashManager(openWindows, tiledWindow, monitorNr, freeScreenSpace);
}

var MyTilingDashManager = GObject.registerClass(
	class MyTilingDashManager extends St.Widget {
		_init(openWindows, tiledWindow, monitorNr, freeScreenRect) {
			super._init({reactive: true});

			main.uiGroup.add_child(this);
			if (!main.pushModal(this)) {
				this.destroy();
				return;
			}

			this.systemModalOpenedId = main.layoutManager.connect('system-modal-opened', () => this._destroy(true));

			this.highlightedApp = -1;
			this.highlightedWindow = -1;
			this.animationDir = {x: 0, y: 0};
			this.thumbnailsAreFocused = false;
			this.windowPreviewSize = 256;
			
			this.tiledWindow = tiledWindow;
			this.monitorNr = monitorNr;
			this.freeScreenRect = freeScreenRect;
			this.openWindows = [];

			this.appDash = null;
			this.windowDash = null;

			// filter the openWindows array, so that no duplicate apps are shown
			let winTracker = Shell.WindowTracker.get_default();
			let openApps = [];
			openWindows.forEach(w => openApps.push(winTracker.get_window_app(w)));
			this.openWindows = openWindows.filter((w, pos) => openApps.indexOf(winTracker.get_window_app(w)) == pos);

			let activeWS = global.workspace_manager.get_active_workspace();
			let entireWorkArea = activeWS.get_work_area_all_monitors();

			this.set_size(entireWorkArea.width, entireWorkArea.height + main.panel.height);

			// shade background for easier visibility
			this.shadeBackground(tiledWindow, entireWorkArea);

			// create appDash
			this.appDash = new MyTilingDash(this, openApps.filter((val, idx) => openApps.indexOf(val) == idx), MyTilingAppIcon);
			this.add_child(this.appDash);
			// scale Dash, if it's too big to fit the free screen space
			let finalScale = (this.appDash.width > freeScreenRect.width - 50) ? (freeScreenRect.width - 50) / this.appDash.width : 1;
			this.appDash.set_scale(finalScale, finalScale);
			this.appDash.set_position(freeScreenRect.x + freeScreenRect.width / 2 - this.appDash.width * finalScale / 2, 
					freeScreenRect.y + freeScreenRect.height / 2 - this.appDash.height * finalScale / 2);
			
			// animate opening of appDash
			let finalX = this.appDash.x;
			let finalY = this.appDash.y;
			this.animationDir.x = Math.sign(((tiledWindow) ? tiledWindow.tiledRect.x : 0) - this.freeScreenRect.x);
			this.animationDir.y = Math.sign(((tiledWindow) ? tiledWindow.tiledRect.y : 0) - this.freeScreenRect.y);
			this.appDash.set_position(finalX + 400 * this.animationDir.x, this.appDash.y + 400 * this.animationDir.y);
			this.appDash.ease({
				x: finalX,
				y: finalY,
				opacity: 255,
				duration: 250,
				mode: Clutter.AnimationMode.EASE_OUT_QUINT,
			});

			this.highlightItem(0);
		}

		_destroy(cancelTilingWithLayout = false) {
			main.popModal(this);
			main.layoutManager.disconnect(this.systemModalOpenedId);

			this.windowClones.forEach(clone => {
				clone.source.show();
				clone.destroy();
			});

			if (cancelTilingWithLayout)
				MyExtension.tilingLayoutManager.endTilingViaLayout();

			this.shadeBG.ease({
				opacity: 0,
				duration: 200,
				mode: Clutter.AnimationMode.EASE_OUT_QUINT,
				onComplete: () => this.shadeBG.destroy()
			});

			if (this.thumbnailsAreFocused) {
				let finalX = this.windowDash.x + 200 * this.animationDir.x;
				let finalY = this.windowDash.y + 200 * this.animationDir.y;
				this.windowDash.ease({
					x: finalX,
					y: finalY,
					opacity: 0,
					duration: 200,
					mode: Clutter.AnimationMode.EASE_OUT_QUINT,
				});
			}

			let finalX2 = this.appDash.x + 200 * this.animationDir.x;
			let finalY2 = this.appDash.y + 200 * this.animationDir.y;
			this.appDash.ease({
				x: finalX2,
				y: finalY2,
				opacity: 0,
				duration: 200,
				mode: Clutter.AnimationMode.EASE_OUT_QUINT,
				onComplete: () => this.destroy()
			});
		}

		// shade BG when the Dash is open for easier visibility
		shadeBackground(tiledWindow, entireWorkArea) {
			// clones to show above the shadeBG (which is just below the tiledWindow)
			this.windowClones = [];
			this.shadeBG = new St.Widget({
				style: "background-color : black",
				width: entireWorkArea.width,
				height: entireWorkArea.height + main.panel.height,
				opacity: 180,
			});

			if (tiledWindow) {
				for (let w of tiledWindow.tileGroup) {
					// tiling via layout ignores tilegroup and only checks if it was tiled via the layout
					if (MyExtension.tilingLayoutManager.isTilingViaLayout && MyExtension.tilingLayoutManager.cachedOpenWindows.includes(w))
						continue;

					if (w != tiledWindow) {
						let wA = w.get_compositor_private();
						let clone = new Clutter.Clone({
							source: wA,
							x: wA.x, y: wA.y
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
					global.window_group.insert_child_below(this.shadeBG, tiledWindowActor);
					tiledWindowActor.disconnect(sID);
				});

			// no tiledWindow on first rect when using layouts
			} else {
				global.window_group.add_child(this.shadeBG);
			}
		}

		highlightItem(idx, forceAppFocus = false) {
			let focusWindows = this.thumbnailsAreFocused && !forceAppFocus;
			let items = focusWindows ? this.windowDash.get_children() : this.appDash.get_children();
			let oldIdx = focusWindows ? this.highlightedWindow : this.highlightedApp;
			idx = (idx + items.length) % items.length;
			items[Math.max(0, oldIdx)].setHighlight(false);
			items[idx].setHighlight(true);

			if (focusWindows) {
				this.highlightedWindow = idx;
			} else {
				this.highlightedApp = idx;
				GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
					if (idx == this.highlightedApp && items[idx].cachedWindows.length > 1)
						this.openWindowDash();

					return GLib.SOURCE_REMOVE;
				});
			}
		}

		openWindowDash() {
			if (this.thumbnailsAreFocused || this.highlightedApp == -1)
				return;

			this.thumbnailsAreFocused = true;

			let appIcon = this.appDash.get_children()[this.highlightedApp];
			if (appIcon.cachedWindows.length == 1)
				appIcon.setArrowVisibility(true);

			this.windowDash = new MyTilingDash(this, appIcon.cachedWindows, MyTilingWindowIcon);
			this.add_child(this.windowDash);

			// center under/above the highlighted appIcon
			let x = appIcon.get_transformed_position()[0] + appIcon.width / 2 - this.windowDash.width / 2;
			let y = (appIcon.arrowIsAbove) ? this.appDash.y - this.windowDash.height - 25 : this.appDash.y + this.appDash.height + 25;

			// move windowDash into the monitor (with a 20px margin), if it's (partly) outside
			let monitorRect = global.display.get_monitor_geometry(this.monitorNr);
			if (x + this.windowDash.width + 20 > monitorRect.width)
				x = monitorRect.width - 20 - this.windowDash.width;
			if (x + 20 < monitorRect.x)
				x = monitorRect.x + 20;

			this.windowDash.set_position(x, y);
			this.highlightItem(0);

			// animate opening
			this.windowDash.set_opacity(0);
			this.windowDash.ease({
				opacity: 255,
				duration: 250,
				mode: Clutter.AnimationMode.EASE_OUT_QUINT,
			});
		}

		closeWindowDash() {
			if (!this.thumbnailsAreFocused)
				return;

			this.thumbnailsAreFocused = false;

			let appIcon = this.appDash.get_children()[this.highlightedApp];
			if (appIcon.cachedWindows.length == 1)
				appIcon.setArrowVisibility(false);

			// animate closing
			// windowDash will only be closed (destroyed) after anim is finished!
			this.windowDash.ease({
				opacity: 0,
				duration: 150,
				mode: Clutter.AnimationMode.EASE_OUT_QUINT,
				onComplete: () => {
					this.highlightedWindow = -1;
					this.windowDash.destroy();
					this.windowDash = null;
				}
			});
		}
		
		activate(window) {
			window.move_to_monitor(this.monitorNr);
			window.activate(global.get_current_time());

			const isTilingViaLayout = MyExtension.tilingLayoutManager.isTilingViaLayout;

			// halve the freeScreenRect when holding Shift or Alt
			if (!isTilingViaLayout) {
				let event = Clutter.get_current_event();
				let modifiers = event ? event.get_state() : 0;
				let isAltPressed = modifiers & Clutter.ModifierType.MOD1_MASK;
				let isShiftPressed = modifiers & Clutter.ModifierType.SHIFT_MASK;

				if (isAltPressed) {
					if (this.freeScreenRect.width >= this.freeScreenRect.height * 1.25) { // prefer vertical tiling more (because of horizontal screen orientation)
						this.freeScreenRect.x = this.freeScreenRect.x + this.freeScreenRect.width / 2;
						this.freeScreenRect.width = this.freeScreenRect.width / 2;

					} else {
						this.freeScreenRect.y = this.freeScreenRect.y + this.freeScreenRect.height / 2;
						this.freeScreenRect.height = this.freeScreenRect.height / 2;
					}

				} else if (isShiftPressed) {
					if (this.freeScreenRect.width >= this.freeScreenRect.height * 1.25) // prefer vertical tiling more (because of horizontal screen orientation)
						this.freeScreenRect.width = this.freeScreenRect.width / 2;

					else
						this.freeScreenRect.height = this.freeScreenRect.height / 2;
				}
			}

			Util.tileWindow(window, this.freeScreenRect, !isTilingViaLayout);
			MyExtension.tilingLayoutManager.onWindowTiled(window);
			
			this._destroy();
        }
		
		vfunc_key_press_event(keyEvent) {
			switch (keyEvent.keyval) {
				case Clutter.KEY_Right:
				case Clutter.KEY_d:
				case Clutter.KEY_D:
					this.highlightItem((this.thumbnailsAreFocused ? this.highlightedWindow : this.highlightedApp) + 1);
					return Clutter.EVENT_STOP;

				case Clutter.KEY_Left:
				case Clutter.KEY_a:
				case Clutter.KEY_A:
					this.highlightItem((this.thumbnailsAreFocused ? this.highlightedWindow : this.highlightedApp) - 1);
					return Clutter.EVENT_STOP;

				case Clutter.KEY_Up:
				case Clutter.KEY_w:
				case Clutter.KEY_W:
					this.thumbnailsAreFocused ? this.closeWindowDash() : this.openWindowDash();
					return Clutter.EVENT_STOP;

				case Clutter.KEY_Down:
				case Clutter.KEY_s:
				case Clutter.KEY_S:
					this.thumbnailsAreFocused ? this.closeWindowDash() : this.openWindowDash();
					return Clutter.EVENT_STOP;

				case Clutter.KEY_Return:
				case Clutter.KEY_space:
					let appIcon = this.appDash.get_children()[this.highlightedApp];
					this.activate(appIcon.cachedWindows[this.thumbnailsAreFocused ? this.highlightedWindow : 0]);
					return Clutter.EVENT_STOP;

				case Clutter.KEY_Shift_L:
				case Clutter.KEY_Shift_R:
				case Clutter.KEY_Alt_L:
				case Clutter.KEY_Alt_R:
					return Clutter.EVENT_STOP;
			}

			// destroy on all other key inputs
			this._destroy(true);

			return Clutter.EVENT_STOP;
        }

        vfunc_button_press_event(buttonEvent) {
            if (buttonEvent.button == Clutter.BUTTON_MIDDLE) {
                let appIcon = this.appDash.get_children()[this.highlightedApp];
                this.activate(appIcon.cachedWindows[this.thumbnailsAreFocused ? this.highlightedWindow : 0]);
            } else {
                this._destroy(true);
            }
        }

        vfunc_scroll_event(scrollEvent) {
            let direction = scrollEvent.direction;
            if (direction == Clutter.ScrollDirection.UP || direction == Clutter.ScrollDirection.LEFT)
                this.highlightItem((this.thumbnailsAreFocused ? this.highlightedWindow : this.highlightedApp) - 1);
            else if (direction == Clutter.ScrollDirection.DOWN || direction == Clutter.ScrollDirection.RIGHT)
                this.highlightItem((this.thumbnailsAreFocused ? this.highlightedWindow : this.highlightedApp) + 1);
        }
	}
);

var MyTilingDash = GObject.registerClass(
	class MyTilingDash extends St.BoxLayout {
		_init(dashManager, allItems, itemIconConstructor) {
			super._init({
				style_class: "switcher-list",
				pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 })
			});

			this.get_layout_manager().homogeneous = true;
			this.dashManager = dashManager;
			
			allItems.forEach((item, idx) => {
				let itemIcon = new itemIconConstructor(this, item, idx);
				this.add_child(itemIcon);
			});
		}
	}
);

var MyTilingAppIcon = GObject.registerClass(
	class MyTilingAppIcon extends St.BoxLayout {
		_init(dash, app, idx) {
			super._init({
                style_class: "alt-tab-app",
                style: "padding: 4px",
				vertical: true,
				reactive: true
			});

			this.dash = dash;
			this.app = app;
			this.idx = idx;
			this.cachedWindows = [];
			this.arrowIsAbove = false;
			this.isHovered = false;
			
			this.connect("button-press-event", () => this.dash.dashManager.activate(this.cachedWindows[0]));
			this.connect("enter-event", this.onItemEnter.bind(this));
			this.connect("leave-event", () => this.isHovered = false);

			let allWindows = altTab.getWindows(global.workspace_manager.get_active_workspace());
			let appWindows = allWindows.filter(w => Shell.WindowTracker.get_default().get_window_app(w) == app);
			let tiledWindow = this.dash.dashManager.tiledWindow;
			this.cachedWindows = appWindows.filter(w => {
				if (MyExtension.tilingLayoutManager.isTilingViaLayout) {
					if (!MyExtension.tilingLayoutManager.cachedOpenWindows.includes(w))
						return false;
				} else {
					if (tiledWindow && tiledWindow.tileGroup.includes(w))
						return false;
				}

				return true;
			});
			
			let buttonSize = MyExtension.settings.get_int("icon-size") + MyExtension.settings.get_int("icon-margin");		
			this.set_size(buttonSize, buttonSize);

			let monitorRect = global.display.get_monitor_geometry(this.dash.dashManager.monitorNr);
			let previewSize = this.dash.dashManager.windowPreviewSize;
			let freeScreenRect = this.dash.dashManager.freeScreenRect;
			this.arrowIsAbove = freeScreenRect.y + freeScreenRect.height / 2 + previewSize >= monitorRect.height - previewSize;
			
			// add a top and bottom arrow to the appIcon.
			// one of them will be shown depending on the Dash pos
			//////////////////////
			// top arrow
			let topContainer = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER});
			this.topArrow = new St.DrawingArea({
				style: "color: white",
				width: 8, height: 4,
			});
			this.topArrow.set_opacity(0);
			this.topArrow.connect("repaint", () => switcherPopup.drawArrow(this.topArrow, St.Side.TOP));
			topContainer.add_child(this.topArrow);
			this.add_child(topContainer);

			// app icon
            this.iconBin = new St.Bin({y_expand: true});
			this.icon = app.create_icon_texture(MyExtension.settings.get_int("icon-size"));
			this.add_child(this.iconBin);
			this.iconBin.set_child(this.icon);

			// bottom arrow
			let bottomContainer = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER});
			this.bottomArrow = new St.DrawingArea({
				style: "color: white",
				width: 8, height: 4,
			});
			this.bottomArrow.set_opacity(0);
			this.bottomArrow.connect("repaint", () => switcherPopup.drawArrow(this.bottomArrow, St.Side.BOTTOM));
			bottomContainer.add_child(this.bottomArrow);
			this.add_child(bottomContainer);

			if (this.cachedWindows.length > 1)
				this.setArrowVisibility(true);
		}

		setArrowVisibility(visible) {
			let arrow = this.arrowIsAbove ? this.topArrow : this.bottomArrow;
			arrow.set_opacity(visible ? 255 : 0);
		}

		setHighlight(highlight) {
			if (highlight)
				this.set_style_class_name("tiling-highlighted-appicon");
			else
				this.remove_style_class_name("tiling-highlighted-appicon");
		}
		
		onItemEnter() {
			this.isHovered = true;
			let dashManager = this.dash.dashManager;
			let prevHighlighted = dashManager.highlightedApp;

			if (dashManager.thumbnailsAreFocused)
				GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
					if (prevHighlighted == this.idx || !this.isHovered)
						return GLib.SOURCE_REMOVE;
	
					dashManager.closeWindowDash();
					dashManager.highlightItem(this.idx, true);

					return GLib.SOURCE_REMOVE;
				});
			else
				dashManager.highlightItem(this.idx);
		}
	}
);

var MyTilingWindowIcon = GObject.registerClass(
	class MyTilingWindowIcon extends St.BoxLayout {
		_init(dash, window, idx) {
			super._init({
				style_class: "alt-tab-app",
				style: "padding: 8px",
				reactive: true
			});
	
			this.dash = dash;
			this.window = window;
			this.idx = idx;

			this.connect("button-press-event", () => this.dash.dashManager.activate(this.window));
			this.connect("enter-event", () => this.dash.dashManager.highlightItem(this.idx));
	
			let previewSize = this.dash.dashManager.windowPreviewSize;
			this.icon = new St.Widget({layout_manager: new Clutter.BinLayout()});
			this.icon.add_actor(altTab._createWindowClone(this.window.get_compositor_private(), previewSize));
			this.icon.set_size(previewSize, previewSize);
			this.add_child(this.icon);
		}

		setHighlight(highlight) {
			if (highlight)
				this.set_style_class_name("tiling-highlighted-appicon");
			else
				this.remove_style_class_name("tiling-highlighted-appicon");
		}
	}
);