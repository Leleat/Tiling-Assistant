"use strict";

const {altTab, main, switcherPopup} = imports.ui;
const {Clutter, GLib, GObject, Graphene, Meta, Shell, St} = imports.gi;

const Me = imports.misc.extensionUtils.getCurrentExtension();
const MyExtension = Me.imports.extension;
const Util = Me.imports.util;

function openDash(openWindows, tiledWindow, monitorNr, freeScreenSpace) {
	if (!openWindows.length || (tiledWindow && !tiledWindow.tileGroup) || !(freeScreenSpace instanceof Meta.Rectangle))
		return;

	new MyTilingDashManager(openWindows, tiledWindow, monitorNr, freeScreenSpace);
}

const MyTilingDashManager = GObject.registerClass(
	class MyTilingDashManager extends St.Widget {
		_init(openWindows, tiledWindow, monitorNr, freeScreenRect) {
			const activeWS = global.workspace_manager.get_active_workspace();
			const entireWorkArea = activeWS.get_work_area_all_monitors();

			super._init({
				reactive: true,
				x: entireWorkArea.x,
				y: entireWorkArea.y - main.panel.height,
				width: entireWorkArea.width,
				height: entireWorkArea.height + main.panel.height
			});

			main.uiGroup.add_child(this);
			if (!main.pushModal(this))
				return this.destroy();

			this.systemModalOpenedId = main.layoutManager.connect("system-modal-opened", () => this.destroy(true));

			this.tiledWindow = tiledWindow;
			this.monitorNr = monitorNr;
			this.monitorScale = global.display.get_monitor_scale(monitorNr);
			this.freeScreenRect = freeScreenRect;
			this.openWindows = [];
			this.windowClones = [];
			this.windowDashAlreadyDestroyed = false;
			this.appArrows = [];
			this.arrowIsAbove = false;

			this.highlightedApp = -1;
			this.highlightedWindow = -1;
			this.animationDir = {x: 0, y: 0};
			this.thumbnailsAreFocused = false;
			this.windowPreviewSize = 256 * this.monitorScale;

			this.appDash = null;
			this.windowDash = null;

			// filter the openWindows array, so that no duplicate apps are shown
			const winTracker = Shell.WindowTracker.get_default();
			const openApps = openWindows.map(w => winTracker.get_window_app(w));
			this.openWindows = openWindows.filter((w, pos) => openApps.indexOf(winTracker.get_window_app(w)) === pos);

			// shade background for easier visibility
			this.shadeBackground(tiledWindow, entireWorkArea);

			// create appDash
			this.appDash = new MyTilingDash(this, openApps.filter((val, idx) => openApps.indexOf(val) === idx), MyTilingAppIcon);
			this.add_child(this.appDash);
			// scale Dash, if it's too big to fit the free screen space
			const finalScale = (this.appDash.width > freeScreenRect.width - 50) ? (freeScreenRect.width - 50) / this.appDash.width : 1;
			this.appDash.set_scale(finalScale, finalScale);
			this.appDash.set_position(freeScreenRect.x + freeScreenRect.width / 2 - this.appDash.width * finalScale / 2
					, freeScreenRect.y + freeScreenRect.height / 2 - this.appDash.height * finalScale / 2);

			// put arrows below appIcons (hide, if the app doesnt have multiple windows)
			const monitorRect = global.display.get_monitor_geometry(this.monitorNr);
			this.arrowIsAbove = freeScreenRect.y + freeScreenRect.height / 2 + this.windowPreviewSize >= monitorRect.height - this.windowPreviewSize;
			this.drawArrows();

			// animate opening of appDash
			const finalX = this.appDash.x;
			const finalY = this.appDash.y;
			this.animationDir.x = Math.sign((tiledWindow ? tiledWindow.tiledRect.x : 0) - this.freeScreenRect.x);
			this.animationDir.y = Math.sign((tiledWindow ? tiledWindow.tiledRect.y : 0) - this.freeScreenRect.y);
			this.appDash.set_position(finalX + 400 * this.animationDir.x, this.appDash.y + 400 * this.animationDir.y);
			this.appDash.set_opacity(0);
			this.appDash.ease({
				x: finalX,
				y: finalY,
				opacity: 255,
				duration: 250,
				mode: Clutter.AnimationMode.EASE_OUT_QUINT,
			});

			// animate arrows to move along the appDash
			this.appArrows.forEach(arrow => {
				const x = arrow.x;
				const y = arrow.y;
				arrow.set_opacity(0);
				arrow.set_position(x + 400 * this.animationDir.x, y + 400 * this.animationDir.y);
				arrow.ease ({
					x: x,
					y: y,
					opacity: 255,
					duration: 250,
					mode: Clutter.AnimationMode.EASE_OUT_QUINT
				});
			});

			this.highlightItem(0, false, true);
		}

		destroy(cancelTilingWithLayout = false) {
			if (this.alreadyDestroyed)
				return;

			this.alreadyDestroyed = true;

			main.layoutManager.disconnect(this.systemModalOpenedId);
			main.popModal(this);

			this.appArrows.forEach(arrow => arrow.destroy());

			if (cancelTilingWithLayout)
				MyExtension.tilingLayoutManager.endTilingViaLayout();

			this.shadeBG.ease({
				opacity: 0,
				duration: 200,
				mode: Clutter.AnimationMode.EASE_OUT_QUINT,
				onComplete: () => {
					this.shadeBG.destroy();
					this.windowClones.forEach(clone => {
						clone.source.show();
						clone.destroy();
					});
				}
			});

			if (this.thumbnailsAreFocused) {
				const finalX = this.windowDash.x + 200 * this.animationDir.x;
				const finalY = this.windowDash.y + 200 * this.animationDir.y;
				this.windowDash.ease({
					x: finalX,
					y: finalY,
					opacity: 0,
					duration: 200,
					mode: Clutter.AnimationMode.EASE_OUT_QUINT,
				});
			}

			const finalX2 = this.appDash.x + 200 * this.animationDir.x;
			const finalY2 = this.appDash.y + 200 * this.animationDir.y;
			this.appDash.ease({
				x: finalX2,
				y: finalY2,
				opacity: 0,
				duration: 200,
				mode: Clutter.AnimationMode.EASE_OUT_QUINT,
				onComplete: () => super.destroy()
			});
		}

		// shade BG when the Dash is open for easier visibility
		shadeBackground(tiledWindow, entireWorkArea) {
			this.shadeBG = new St.Widget({
				style: "background-color : black",
				width: entireWorkArea.width,
				height: entireWorkArea.height + main.panel.height,
				opacity: 0
			});
			global.window_group.add_child(this.shadeBG);

			// tiledWindow == null, on intial tiling with layout
			const tileGroup = Util.getTopTileGroup(null, false);
			if (tiledWindow) {
				for (const w of tileGroup) {
					// tiling via layout ignores tilegroup and only checks if it was tiled via the layout
					if (MyExtension.tilingLayoutManager.isTilingViaLayout && MyExtension.tilingLayoutManager.cachedOpenWindows.includes(w))
						continue;

					if (w !== tiledWindow) {
						const wA = w.get_compositor_private();
						const clone = new Clutter.Clone({
							source: wA,
							x: wA.x, y: wA.y
						});
						wA.hide();
						global.window_group.add_child(clone);
						this.windowClones.push(clone);
					}
				}

				const tiledWindowActor = tiledWindow.get_compositor_private();
				global.window_group.set_child_above_sibling(tiledWindowActor, this.shadeBG);
			}

			this.shadeBG.ease({
				opacity: 180,
				duration: 200,
				mode: Clutter.AnimationMode.EASE_OUT_QUINT,
			});
		}

		drawArrows() {
			const activeWS = global.workspace_manager.get_active_workspace();
			const workArea = activeWS.get_work_area_for_monitor(this.monitorNr);
			const appIcons = this.appDash.get_children();
			appIcons.forEach((icon, idx) => {
				const arrow = new St.DrawingArea({
					style: "color: white",
					x: workArea.x + this.appDash.x + (icon.width * idx) + icon.width / 2 + 8 - ((idx === 0) ? 0 : 4), // MagicNrs.: margins/paddings of appIcons
					y: (this.arrowIsAbove) ? this.appDash.y + 5 * this.monitorScale : this.appDash.y + this.appDash.height - 4 * this.monitorScale - 5 * this.monitorScale,
					width: 8 * this.monitorScale,
					height: 4 * this.monitorScale,
				});
				main.uiGroup.add_child(arrow);
				this.appArrows.push(arrow);
				arrow.connect("repaint", () => switcherPopup.drawArrow(arrow, (this.arrowIsAbove) ? St.Side.TOP : St.Side.BOTTOM));

				if (icon.cachedWindows.length === 1)
					arrow.hide();
			});
		}

		highlightItem(idx, forceAppFocus = false, focusViaHover = false) {
			if (this.thumbnailsAreFocused && forceAppFocus)
				this.closeWindowDash();

			const items = (this.thumbnailsAreFocused) ? this.windowDash.get_children() : this.appDash.get_children();
			const oldIdx = (this.thumbnailsAreFocused) ? this.highlightedWindow : this.highlightedApp;
			idx = (idx + items.length) % items.length;
			items[Math.max(0, oldIdx)].setHighlight(false);
			items[idx].setHighlight(true);

			if (this.thumbnailsAreFocused) {
				this.highlightedWindow = idx;

			} else {
				this.highlightedApp = idx;

				if (focusViaHover)
					GLib.timeout_add(GLib.PRIORITY_DEFAULT, 650, () => {
						if (idx === this.highlightedApp && items[idx].cachedWindows.length > 1 && !this.alreadyDestroyed)
							this.openWindowDash();

						return GLib.SOURCE_REMOVE;
					});
			}
		}

		setArrowVisibility(visible) {
			(visible) ? this.appArrows[this.highlightedApp].show() : this.appArrows[this.highlightedApp].hide();
		}

		openWindowDash(focusBackwards = false) {
			const icons = this.appDash.get_children();
			if (this.thumbnailsAreFocused || this.highlightedApp === -1 || this.highlightedApp >= icons.length)
				return;

			if (this.windowDash) {
				this.windowDash.destroy();
				this.highlightedWindow = -1;
				this.windowDashAlreadyDestroyed = true;
			}

			this.thumbnailsAreFocused = true;

			const appIcon = icons[this.highlightedApp];
			if (appIcon.cachedWindows.length === 1)
				this.setArrowVisibility(true);

			this.windowDash = new MyTilingDash(this, appIcon.cachedWindows, MyTilingWindowIcon);
			this.add_child(this.windowDash);

			// center under/above the highlighted appIcon
			let x = this.appDash.x + appIcon.x + appIcon.width / 2 - this.windowDash.width / 2;
			const y = (this.arrowIsAbove) ? this.appDash.y - this.windowDash.height - 25 : this.appDash.y + this.appDash.height + 25;

			// move windowDash into the monitor (with a 20px margin), if it's (partly) outside
			const monitorRect = global.display.get_monitor_geometry(this.monitorNr);
			if (x + this.windowDash.width + 20 > monitorRect.x + monitorRect.width)
				x = monitorRect.x + monitorRect.width - 20 - this.windowDash.width;

			if (x + 20 < monitorRect.x)
				x = monitorRect.x + 20;

			this.windowDash.set_position(x, y);
			this.highlightItem((focusBackwards) ? appIcon.cachedWindows.length - 1 : 0);

			// animate opening
			this.windowDash.set_opacity(0);
			this.windowDash.ease({
				opacity: 255,
				duration: 250,
				mode: Clutter.AnimationMode.EASE_OUT_QUINT,
			});
		}

		closeWindowDash() {
			if (!this.thumbnailsAreFocused || !this.windowDash)
				return;

			this.thumbnailsAreFocused = false;

			const icons = this.appDash.get_children();
			if (this.highlightedApp >= icons.length)
				return;

			const appIcon = icons[this.highlightedApp];
			if (appIcon.cachedWindows.length === 1)
				this.setArrowVisibility(false);

			// animate closing
			this.windowDashAlreadyDestroyed = false;
			this.windowDash.ease({
				opacity: 0,
				duration: 150,
				mode: Clutter.AnimationMode.EASE_OUT_QUINT,
				onComplete: () => {
					if (this.windowDash && !this.windowDashAlreadyDestroyed) {
						this.highlightedWindow = -1;
						this.windowDash.destroy();
						this.windowDash = null;
					}
				}
			});
		}

		activate(window) {
			if (!window)
				return;

			const isTilingViaLayout = MyExtension.tilingLayoutManager.isTilingViaLayout;

			// halve the freeScreenRect when holding Shift or Alt
			if (!isTilingViaLayout) {
				const event = Clutter.get_current_event();
				const modifiers = event ? event.get_state() : 0;
				const isAltPressed = modifiers & Clutter.ModifierType.MOD1_MASK;
				const isShiftPressed = modifiers & Clutter.ModifierType.SHIFT_MASK;

				if (isAltPressed) {
					// prefer vertical tiling more (because of horizontal screen orientation)
					if (this.freeScreenRect.width >= this.freeScreenRect.height * 1.25) {
						this.freeScreenRect.x = this.freeScreenRect.x + this.freeScreenRect.width / 2;
						this.freeScreenRect.width = this.freeScreenRect.width / 2;

					} else {
						this.freeScreenRect.y = this.freeScreenRect.y + this.freeScreenRect.height / 2;
						this.freeScreenRect.height = this.freeScreenRect.height / 2;
					}

				} else if (isShiftPressed) {
					// prefer vertical tiling more (because of horizontal screen orientation)
					if (this.freeScreenRect.width >= this.freeScreenRect.height * 1.25)
						this.freeScreenRect.width = this.freeScreenRect.width / 2;

					else
						this.freeScreenRect.height = this.freeScreenRect.height / 2;
				}
			}

			window.move_to_monitor(this.monitorNr);
			Util.tileWindow(window, this.freeScreenRect, !isTilingViaLayout);
			MyExtension.tilingLayoutManager.onWindowTiled(window);
			// window.activate(global.get_current_time());

			this.destroy();
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
				case Clutter.KEY_KP_Enter:
				case Clutter.KEY_ISO_Enter:
				case Clutter.KEY_space:
					const appIcon = this.appDash.get_children()[this.highlightedApp];
					this.activate(appIcon.cachedWindows[this.thumbnailsAreFocused ? this.highlightedWindow : 0]);
					return Clutter.EVENT_STOP;

				case Clutter.KEY_Shift_L:
				case Clutter.KEY_Shift_R:
				case Clutter.KEY_Alt_L:
				case Clutter.KEY_Alt_R:
					return Clutter.EVENT_STOP;
			}

			// destroy on all other key inputs
			this.destroy(true);

			return Clutter.EVENT_STOP;
		}

		vfunc_button_press_event(buttonEvent) {
			if (buttonEvent.button === Clutter.BUTTON_MIDDLE) {
				const appIcon = this.appDash.get_children()[this.highlightedApp];
				this.activate(appIcon.cachedWindows[this.thumbnailsAreFocused ? this.highlightedWindow : 0]);
			} else {
				this.destroy(true);
			}
		}

		vfunc_scroll_event(scrollEvent) {
			const direction = scrollEvent.direction;
			// backward scroll through the appDash and windowDash
			if (direction === Clutter.ScrollDirection.UP || direction === Clutter.ScrollDirection.LEFT) {
				if (this.thumbnailsAreFocused) {
					// scroll through window list
					if (this.highlightedWindow > 0) {
						this.highlightItem(this.highlightedWindow - 1);

					// beginning of windowDash reached -> switch to appDash
					} else {
						this.highlightItem(this.highlightedApp - 1, true);
						if (this.appDash.get_children()[this.highlightedApp].cachedWindows.length > 1)
							this.openWindowDash(true);
					}

				} else {
					// scroll through appDash; open windowDash, if necessary
					this.highlightItem(this.highlightedApp - 1);
					if (this.appDash.get_children()[this.highlightedApp].cachedWindows.length > 1)
						this.openWindowDash(true);
				}

			// forward scroll through the appDash and windowDash
			} else if (direction === Clutter.ScrollDirection.DOWN || direction === Clutter.ScrollDirection.RIGHT) {
				if (this.thumbnailsAreFocused) {
					// end of windowDash reached -> switch to appDash
					if (this.highlightedWindow === this.windowDash.get_children().length - 1) {
						this.highlightItem(this.highlightedApp + 1, true);
						if (this.appDash.get_children()[this.highlightedApp].cachedWindows.length > 1)
							this.openWindowDash();

					// scroll windowDash
					} else {
						this.highlightItem(this.highlightedWindow + 1);
					}

				// scroll through appDash; open windowDash, if necessary
				} else {
					this.highlightItem(this.highlightedApp + 1);
					if (this.appDash.get_children()[this.highlightedApp].cachedWindows.length > 1)
						this.openWindowDash();
				}
			}

			return Clutter.EVENT_STOP;
		}
	}
);

// used for appDash and windowDash
var MyTilingDash = GObject.registerClass(
	class MyTilingDash extends St.BoxLayout {
		_init(dashManager, allItems, itemIconConstructor) {
			super._init({
				style_class: "switcher-list",
				pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 })
			});

			this.dashManager = dashManager;

			allItems.forEach((item, idx) => {
				const itemIcon = new itemIconConstructor(this, item, idx);
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
				style: "padding: 4px; " + ((idx > 0) ? "margin-left: 10px;" : ""),
				vertical: true,
				reactive: true
			});

			this.dash = dash;
			this.app = app;
			this.idx = idx;
			this.cachedWindows = [];
			this.isHovered = false;

			this.connect("button-press-event", () => dash.dashManager.activate(this.cachedWindows[0]));
			this.connect("enter-event", this.onItemEnter.bind(this));
			this.connect("leave-event", () => this.isHovered = false);

			const allWindows = Util.getOpenWindows();
			const appWindows = allWindows.filter(w => Shell.WindowTracker.get_default().get_window_app(w) === app);
			const tiledWindow = dash.dashManager.tiledWindow;
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

			const monitorScale = dash.dashManager.monitorScale;
			const buttonSize = (MyExtension.settings.get_int("icon-size") + MyExtension.settings.get_int("icon-margin")) * monitorScale;
			this.set_size(buttonSize, buttonSize);

			// app icon
			this.iconBin = new St.Bin({y_expand: true});
			this.icon = app.create_icon_texture(MyExtension.settings.get_int("icon-size"));
			this.add_child(this.iconBin);
			this.iconBin.set_child(this.icon);
		}

		setHighlight(highlight) {
			if (highlight)
				this.set_style_class_name("tiling-highlighted-appicon");
			else
				this.remove_style_class_name("tiling-highlighted-appicon");
		}

		onItemEnter() {
			this.isHovered = true;
			const dashManager = this.dash.dashManager;
			const prevHighlighted = dashManager.highlightedApp;

			if (dashManager.thumbnailsAreFocused)
				GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
					if (prevHighlighted !== this.idx && this.isHovered)
						dashManager.highlightItem(this.idx, true, true);

					return GLib.SOURCE_REMOVE;
				});
			else
				dashManager.highlightItem(this.idx, false, true);
		}
	}
);

var MyTilingWindowIcon = GObject.registerClass(
	class MyTilingWindowIcon extends St.BoxLayout {
		_init(dash, window, idx) {
			super._init({
				style_class: "alt-tab-app",
				style: "padding: 8px; " + ((idx > 0) ? "margin-left: 10px;" : ""),
				reactive: true
			});

			this.dash = dash;
			this.window = window;
			this.idx = idx;

			this.connect("button-press-event", () => dash.dashManager.activate(window));
			this.connect("enter-event", () => dash.dashManager.highlightItem(idx));

			const previewSize = dash.dashManager.windowPreviewSize;
			this.icon = new St.Widget({layout_manager: new Clutter.BinLayout()});
			this.icon.add_actor(altTab._createWindowClone(window.get_compositor_private(), previewSize));
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