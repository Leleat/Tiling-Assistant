"use strict";

const {altTab, main, switcherPopup} = imports.ui;
const {Clutter, GObject, Meta, Shell, St} = imports.gi;

const Me = imports.misc.extensionUtils.getCurrentExtension();
const Util = Me.imports.tilingUtil;

const isGnome3_36 = parseFloat(imports.misc.config.PACKAGE_VERSION) < 3.38;

// classes for the tiling popup, which opens when tiling a window
// and there is free screen space to fill with other windows.
// mostly based on GNOME's altTab.js

var TilingSwitcherPopup = GObject.registerClass({
	Signals: {
		"tiling-finished": {param_types: [GObject.TYPE_BOOLEAN]} // tilingCanceled
	},
}, class TilingSwitcherPopup extends switcherPopup.SwitcherPopup {
		// @allowConsecutivePopup means wether the window that is tiled with the popup
		// may cause the popup to appear again (for ex. when holding Shift/Alt when activating an icon)
		_init(openWindows, freeScreenRect, allowConsecutivePopup = true) {
			this.freeScreenRect = freeScreenRect;
			this.shadeBG = null;

			super._init();

			this._thumbnails = null;
			this._thumbnailTimeoutId = 0;
			this._currentWindow = -1;
			this.thumbnailsVisible = false;
			// the window, which is going to be tiled with this popup (or null, if canceled)
			this.tiledWindow = null;
			this.allowConsecutivePopup = allowConsecutivePopup;

			const apps = Shell.AppSystem.get_default().get_running();
			this._switcherList = new TilingSwitcherList(openWindows, apps, this);
			this._items = this._switcherList.icons;

			// destroy popup when touching outside of popup
			this.connect("touch-event", (actor, event) => {
				if (Meta.is_wayland_compositor())
					this.fadeAndDestroy();

				return Clutter.EVENT_PROPAGATE;
			});
		}

		// when showing the tiling popup the background will be shaded for easier visibility.
		// @tileGroup determines, which windows will be above the shading widget.
		// when tiling "normally", the tileGroup is simply the same as Util.getTopTileGroup...
		// when using layouts, the tileGroup consists of the windows, which were tiled by the layout
		show(tileGroup) {
			if (this._items.length === 0)
				return false;

			if (!main.pushModal(this)) {
				// Probably someone else has a pointer grab, try again with keyboard only
				if (!main.pushModal(this, {options: Meta.ModalOptions.POINTER_ALREADY_GRABBED}))
					return false;
			}
			this._haveModal = true;

			this._switcherList.connect('item-activated', this._itemActivated.bind(this));
			this._switcherList.connect('item-entered', this._itemEntered.bind(this));
			this._switcherList.connect('item-removed', this._itemRemoved.bind(this));
			this.add_actor(this._switcherList);

			// Need to force an allocation so we can figure out
			// whether we need to scroll when selecting
			this.visible = true;
			this.get_allocation_box();

			this._select(0);

			main.osdWindowManager.hideAll();

			this._shadeBackground(tileGroup);
			this.opacity = 0;
			this.ease({
				opacity: 255,
				duration: 200,
				mode: Clutter.AnimationMode.EASE_OUT_QUAD
			});

			return true;
		}

		_shadeBackground(tileGroup) {
			const lastTiledWindow = tileGroup[0];
			const workArea = lastTiledWindow ? lastTiledWindow.get_work_area_for_monitor(lastTiledWindow.get_monitor())
					: global.workspace_manager.get_active_workspace().get_work_area_for_monitor(global.display.get_current_monitor());

			this.shadeBG = new St.Widget({
				style: "background-color : black",
				x: workArea.x, y: workArea.y,
				width: workArea.width, height: workArea.height,
				opacity: 0
			});
			global.window_group.add_child(this.shadeBG);
			this.shadeBG.ease({
				opacity: 180,
				duration: 200,
				mode: Clutter.AnimationMode.EASE_OUT_QUAD
			});

			if (!lastTiledWindow)
				return;

			// clones to correctly shade the background for consecutive tiling.
			for (let i = 1; i < tileGroup.length; i++) {
				const wActor = tileGroup[i].get_compositor_private();
				const clone = new Clutter.Clone({source: wActor, x: wActor.x, y: wActor.y});
				global.window_group.add_child(clone);
				wActor.hide();
				this.connect("destroy", () => {
					wActor.show();
					clone.destroy();
				});
			}

			const tiledWindowActor = lastTiledWindow.get_compositor_private();
			global.window_group.set_child_above_sibling(tiledWindowActor, this.shadeBG);
		}

		vfunc_allocate(box) {
			isGnome3_36 ? this.set_allocation(box, Clutter.AllocationFlags.ALLOCATION_NONE)
					: this.set_allocation(box);

			const freeScreenRect = this.freeScreenRect;
			const childBox = new Clutter.ActorBox();

			const leftPadding = this.get_theme_node().get_padding(St.Side.LEFT);
			const rightPadding = this.get_theme_node().get_padding(St.Side.RIGHT);
			const hPadding = leftPadding + rightPadding;

			const [, childNaturalHeight] = this._switcherList.get_preferred_height(freeScreenRect.width - hPadding);
			const [, childNaturalWidth] = this._switcherList.get_preferred_width(childNaturalHeight);

			childBox.x1 = Math.max(freeScreenRect.x + leftPadding, freeScreenRect.x + Math.floor((freeScreenRect.width - childNaturalWidth) / 2));
			childBox.x2 = Math.min(freeScreenRect.x + freeScreenRect.width - rightPadding, childBox.x1 + childNaturalWidth);
			childBox.y1 = freeScreenRect.y + Math.floor((freeScreenRect.height - childNaturalHeight) / 2);
			childBox.y2 = childBox.y1 + childNaturalHeight;
			isGnome3_36 ? this._switcherList.allocate(childBox, Clutter.AllocationFlags.ALLOCATION_NONE)
					: this._switcherList.allocate(childBox);

			if (this._thumbnails) {
				const childBox = this._switcherList.get_allocation_box();
				const focusedWindow = global.display.focus_window;
				const monitor = global.display.get_monitor_geometry(
						focusedWindow ? focusedWindow.get_monitor() : global.display.get_current_monitor());

				const leftPadding = this.get_theme_node().get_padding(St.Side.LEFT);
				const rightPadding = this.get_theme_node().get_padding(St.Side.RIGHT);
				const bottomPadding = this.get_theme_node().get_padding(St.Side.BOTTOM);
				const hPadding = leftPadding + rightPadding;

				const icon = this._items[this._selectedIndex];
				const [posX] = icon.get_transformed_position();
				const thumbnailCenter = posX + icon.width / 2;
				const [, childNaturalWidth] = this._thumbnails.get_preferred_width(-1);
				childBox.x1 = Math.max(monitor.x + leftPadding, Math.floor(thumbnailCenter - childNaturalWidth / 2));
				if (childBox.x1 + childNaturalWidth > monitor.x + monitor.width - hPadding) {
					const offset = childBox.x1 + childNaturalWidth - monitor.width + hPadding;
					childBox.x1 = Math.max(monitor.x + leftPadding, childBox.x1 - offset - hPadding);
				}

				const spacing = this.get_theme_node().get_length('spacing');

				childBox.x2 = childBox.x1 +  childNaturalWidth;
				if (childBox.x2 > monitor.x + monitor.width - rightPadding)
					childBox.x2 = monitor.x + monitor.width - rightPadding;
				childBox.y1 = this._switcherList.allocation.y2 + spacing;
				this._thumbnails.addClones(monitor.y + monitor.height - bottomPadding - childBox.y1);
				const [, childNaturalHeight] = this._thumbnails.get_preferred_height(-1);
				childBox.y2 = childBox.y1 + childNaturalHeight;
				isGnome3_36 ? this._thumbnails.allocate(childBox, Clutter.AllocationFlags.ALLOCATION_NONE)
						: this._thumbnails.allocate(childBox);
			}
		}

		vfunc_button_press_event(buttonEvent) {
			if (buttonEvent.button === Clutter.BUTTON_MIDDLE || buttonEvent.button === Clutter.BUTTON_SECONDARY) {
				this._finish(global.get_current_time());
				return Clutter.EVENT_PROPAGATE;
			}

			return super.vfunc_button_press_event(buttonEvent);
		}

		_nextWindow() {
			return altTab.AppSwitcherPopup.prototype._nextWindow.apply(this);
		}

		_previousWindow() {
			return altTab.AppSwitcherPopup.prototype._previousWindow.apply(this);
		}

		_keyPressHandler(keysym, action) {
			const moveUp = Util.eventIsDirection(keysym, Meta.MotionDirection.UP);
			const moveDown = Util.eventIsDirection(keysym, Meta.MotionDirection.DOWN);
			const moveLeft = Util.eventIsDirection(keysym, Meta.MotionDirection.LEFT);
			const moveRight = Util.eventIsDirection(keysym, Meta.MotionDirection.RIGHT);

			if (this._thumbnailsFocused) {
				if (moveLeft)
					this._select(this._selectedIndex, this._previousWindow());
				else if (moveRight)
					this._select(this._selectedIndex, this._nextWindow());
				else if (moveUp || moveDown)
					this._select(this._selectedIndex, null, true);
				else
					return Clutter.EVENT_PROPAGATE;
			} else if (moveLeft) {
				this._select(this._previous());
			} else if (moveRight) {
				this._select(this._next());
			} else if (moveDown || moveUp) {
				this._select(this._selectedIndex, 0);
			} else {
				return Clutter.EVENT_PROPAGATE;
			}

			return Clutter.EVENT_STOP;
		}

		_scrollHandler(...params) {
			return altTab.AppSwitcherPopup.prototype._scrollHandler.apply(this, params);
		}

		_itemActivatedHandler(...params) {
			return altTab.AppSwitcherPopup.prototype._itemActivatedHandler.apply(this, params);
		}

		_itemEnteredHandler(...params) {
			return altTab.AppSwitcherPopup.prototype._itemEnteredHandler.apply(this, params);
		}

		_windowActivated(thumbnailSwitcher, n) {
			const window = this._items[this._selectedIndex].cachedWindows[n];
			this._tileWindow(window);
			this.fadeAndDestroy();
		}

		_windowEntered(...params) {
			return altTab.AppSwitcherPopup.prototype._windowEntered.apply(this, params);
		}

		_windowRemoved(...params) {
			return altTab.AppSwitcherPopup.prototype._windowRemoved.apply(this, params);
		}

		_finish(timestamp) {
			const appIcon = this._items[this._selectedIndex];
			const window = appIcon.cachedWindows[Math.max(0, this._currentWindow)];
			this._tileWindow(window);
			super._finish(timestamp);
		}

		fadeAndDestroy() {
			const tilingCanceled = !this.tiledWindow;
			this.emit("tiling-finished", tilingCanceled);

			this.shadeBG && this.shadeBG.destroy();
			this.shadeBG = null;
			super.fadeAndDestroy();
		}

		_onDestroy() {
			return altTab.AppSwitcherPopup.prototype._onDestroy.apply(this);
		}

		_select(...params) {
			return altTab.AppSwitcherPopup.prototype._select.apply(this, params);
		}

		_tileWindow(window) {
			const isAltPressed = Util.isModPressed(Clutter.ModifierType.MOD1_MASK);
			const isShiftPressed = Util.isModPressed(Clutter.ModifierType.SHIFT_MASK);
			if (isAltPressed) { // halve to right or bottom
				// prefer vertical tiling more (because of horizontal screen orientation)
				if (this.freeScreenRect.width >= this.freeScreenRect.height * 1.25) {
					this.freeScreenRect.x = this.freeScreenRect.x + Math.floor(this.freeScreenRect.width / 2);
					this.freeScreenRect.width = this.freeScreenRect.width / 2;
				} else {
					this.freeScreenRect.y = this.freeScreenRect.y + Math.floor(this.freeScreenRect.height / 2);
					this.freeScreenRect.height = Math.ceil(this.freeScreenRect.height / 2);
				}

			} else if (isShiftPressed) { // halve to left or top
				if (this.freeScreenRect.width >= this.freeScreenRect.height * 1.25)
					this.freeScreenRect.width = Math.ceil(this.freeScreenRect.width / 2);
				else
					this.freeScreenRect.height = Math.ceil(this.freeScreenRect.height / 2);
			}

			this.tiledWindow = window;

			window.change_workspace(global.workspace_manager.get_active_workspace());
			window.move_to_monitor(global.display.get_current_monitor());
			Util.tileWindow(window, this.freeScreenRect, this.allowConsecutivePopup);
			window.activate(global.get_current_time());
		}

		_timeoutPopupThumbnails() {
			return altTab.AppSwitcherPopup.prototype._timeoutPopupThumbnails.apply(this);
		}

		_destroyThumbnails() {
			return altTab.AppSwitcherPopup.prototype._destroyThumbnails.apply(this);
		}

		_createThumbnails() {
			return altTab.AppSwitcherPopup.prototype._createThumbnails.apply(this);
		}

		// dont _finish(), if no mods are pressed
		_resetNoModsTimeout() {
		}
	}
)

const TilingSwitcherList = GObject.registerClass(
	class TilingSwitcherList extends switcherPopup.SwitcherList {
		_init(openWindows, apps, altTabPopup) {
			super._init(true);

			this.icons = [];
			this._arrows = [];

			const winTracker = Shell.WindowTracker.get_default();
			for (const app of apps) {
				const appIcon = new altTab.AppIcon(app);
				appIcon.cachedWindows = openWindows.filter(w => winTracker.get_window_app(w) === app);
				if (appIcon.cachedWindows.length > 0)
					this._addIcon(appIcon);
			}

			this._curApp = -1;
			this._altTabPopup = altTabPopup;
			this._mouseTimeOutId = 0;

			this.connect('destroy', this._onDestroy.bind(this));
		}

		_onDestroy() {
			return altTab.AppSwitcher.prototype._onDestroy.apply(this);
		}

		_setIconSize() {
			let j = 0;
			while (this._items.length > 1 && this._items[j].style_class != 'item-box')
				j++;

			const themeNode = this._items[j].get_theme_node();
			this._list.ensure_style();

			const iconPadding = themeNode.get_horizontal_padding();
			const iconBorder = themeNode.get_border_width(St.Side.LEFT) + themeNode.get_border_width(St.Side.RIGHT);
			const [, labelNaturalHeight] = this.icons[j].label.get_preferred_height(-1);
			const iconSpacing = labelNaturalHeight + iconPadding + iconBorder;
			const totalSpacing = this._list.spacing * (this._items.length - 1);

			const freeScreenRect = this._altTabPopup.freeScreenRect;
			const parentPadding = this.get_parent().get_theme_node().get_horizontal_padding();
			const availWidth = freeScreenRect.width - parentPadding - this.get_theme_node().get_horizontal_padding();

			const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
			const baseIconSizes = [96, 64, 48, 32, 22];
			const iconSizes = baseIconSizes.map(s => s * scaleFactor);
			let iconSize = baseIconSizes[0];

			if (this._items.length > 1) {
				for (let i =  0; i < baseIconSizes.length; i++) {
					iconSize = baseIconSizes[i];
					const height = iconSizes[i] + iconSpacing;
					const w = height * this._items.length + totalSpacing;
					if (w <= availWidth)
						break;
				}
			}

			this._iconSize = iconSize;

			for (let i = 0; i < this.icons.length; i++) {
				if (this.icons[i].icon != null)
					break;
				this.icons[i].set_size(iconSize);
			}
		}

		vfunc_get_preferred_height(...params) {
			return altTab.AppSwitcher.prototype.vfunc_get_preferred_height.apply(this, params);
		}

		vfunc_allocate(...params) {
			return altTab.AppSwitcher.prototype.vfunc_allocate.apply(this, params);
		}

		_onItemEnter(...params) {
			return altTab.AppSwitcher.prototype._onItemEnter.apply(this, params);
		}

		_enterItem(...params) {
			return altTab.AppSwitcher.prototype._enterItem.apply(this, params);
		}

		highlight(...params) {
			return altTab.AppSwitcher.prototype.highlight.apply(this, params);
		}

		_addIcon(...params) {
			return altTab.AppSwitcher.prototype._addIcon.apply(this, params);
		}

		_removeIcon(...params) {
			return altTab.AppSwitcher.prototype._removeIcon.apply(this, params);
		}
	}
)