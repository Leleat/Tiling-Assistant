const {main} = imports.ui;
const {Clutter, GObject, Graphene, Meta, St} = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const MainExtension = Me.imports.extension;
const Util = Me.imports.tilingUtil;
const TilingPopup = Me.imports.tilingPopup;

const MODES = {
	SELECT: 1,
	SWAP: 2,
}

var TileEditor = GObject.registerClass(class TilingEditingMode extends St.Widget {
	_init() {
		const display = global.display.get_monitor_geometry(global.display.get_current_monitor());
		super._init({
			x: display.x,
			y: display.y,
			width: display.width,
			height: display.height,
			reactive: true
		});
		this._haveModal = false;
		this.currMode = MODES.SELECT;
		main.uiGroup.add_child(this);
	}

	open(window) {
		if (!main.pushModal(this)) {
			// Probably someone else has a pointer grab, try again with keyboard only
			if (!main.pushModal(this, {options: Meta.ModalOptions.POINTER_ALREADY_GRABBED})) {
				this.destroy();
				return;
			}
		}

		this._haveModal = true;
		this._topTileGroup = Util.getTopTileGroup(false);
		// primary window is the focused window, which is operated on
		const gap = MainExtension.settings.get_int("window-gap");
		const color = MainExtension.settings.get_string("tile-editing-mode-color"); // rgb(X,Y,Z)
		this._primaryIndicator = new Indicator(window, `border: ${gap / 2 + 1}px solid ${color};`);
		this.add_child(this._primaryIndicator);
		// secondary indicator (for swapping with focused window)
		const rgb = color.substring(color.indexOf("(") + 1, color.indexOf(")")).split(",");
		this._secondaryIndicator = new Indicator(window, `background-color: rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, .3);`);
		this._secondaryIndicator.set_opacity(100);
		this.add_child(this._secondaryIndicator);

		this.select(window.tiledRect, window);
	}

	close() {
		if (this._haveModal) {
			main.popModal(this);
			this._haveModal = false;
		}

		const window = this._primaryIndicator.window;
		window && window.activate(global.get_current_time());

		this.ease({
			opacity: 0,
			duration: 100,
			mode: Clutter.AnimationMode.EASE_OUT_QUAD,
			onComplete: () => this.destroy()
		});
	}

	select(rect, window) {
		this.currMode = MODES.SELECT;
		this._primaryIndicator.select(rect, window);
		this._secondaryIndicator.select(rect, window);
	}

	secondarySelect(rect, window) {
		this.currMode = MODES.SWAP;
		this._secondaryIndicator.select(rect, window);
	}

	vfunc_button_press_event(buttonEvent) {
		this.close();
	}

	vfunc_key_press_event(keyEvent) {
		const keySym = keyEvent.keyval;
		const modState = keyEvent.modifier_state;
		const isCtrlPressed = modState & Clutter.ModifierType.CONTROL_MASK;
		const isAltPressed = modState & Clutter.ModifierType.MOD1_MASK;
		const isShiftPressed = modState & Clutter.ModifierType.SHIFT_MASK;
		const isSuperPressed = modState & Clutter.ModifierType.MOD4_MASK;

		// [E]xpand to fill space
		if (keySym === Clutter.KEY_e || keySym === Clutter.KEY_E) {
			const window = this._primaryIndicator.window;
			if (!window)
				return;

			const tileRect = Util.getBestFitTiledRect(window, this._topTileGroup);
			if (window.tiledRect.equal(tileRect) || tileRect.equal(window.get_work_area_current_monitor()))
				return;

			Util.tileWindow(window, tileRect, false);
			this.select(window.tiledRect, window);

		// [H]orizontally split tiled window
		} else if ((keySym === Clutter.KEY_h || keySym === Clutter.KEY_H) && (isShiftPressed || isAltPressed)) {
			const window = this._primaryIndicator.window;
			if (!window)
				return;

			if (isShiftPressed) {
				Util.tileWindow(window, new Meta.Rectangle({
					x: window.tiledRect.x,
					y: window.tiledRect.y,
					width: Math.ceil(window.tiledRect.width / 2),
					height: window.tiledRect.height
				}), false);
			} else {
				Util.tileWindow(window, new Meta.Rectangle({
					x: window.tiledRect.x + Math.floor(window.tiledRect.width / 2),
					y: window.tiledRect.y,
					width: Math.ceil(window.tiledRect.width / 2),
					height: window.tiledRect.height
				}), false);
			}
			this.select(window.tiledRect, window);

		// [V]ertically split tiled window
		} else if ((keySym === Clutter.KEY_v || keySym === Clutter.KEY_V) && (isShiftPressed || isAltPressed)) {
			const window = this._primaryIndicator.window;
			if (!window)
				return;

			if (isShiftPressed) {
				Util.tileWindow(window, new Meta.Rectangle({
					x: window.tiledRect.x,
					y: window.tiledRect.y,
					width: window.tiledRect.width,
					height: Math.ceil(window.tiledRect.height / 2)
				}), false);
			} else {
				Util.tileWindow(window, new Meta.Rectangle({
					x: window.tiledRect.x,
					y: window.tiledRect.y + Math.floor(window.tiledRect.height / 2),
					width: window.tiledRect.width,
					height: Math.ceil(window.tiledRect.height / 2)
				}), false);
			}
			this.select(window.tiledRect, window);

		// [Q]uit a window
		} else if (keySym === Clutter.KEY_q || keySym === Clutter.KEY_Q) {
			const window = this._primaryIndicator.window;
			if (!window)
				return;

			this._topTileGroup.splice(this._topTileGroup.indexOf(window), 1);
			window.delete(global.get_current_time());
			const newWindow = this._topTileGroup[0];
			newWindow ? this.select(newWindow.tiledRect, newWindow) : this.close();

		// [U]ntile a window
		} else if (keySym === Clutter.KEY_u || keySym === Clutter.KEY_U) {
			const window = this._primaryIndicator.window;
			if (!window)
				return;

			this._topTileGroup.splice(this._topTileGroup.indexOf(window), 1);
			Util.restoreWindowSize(window, true);
			this._topTileGroup.forEach(w => w.raise());
			const newWindow = this._topTileGroup[0];
			newWindow ? this.select(newWindow.tiledRect, newWindow) : this.close();

		// [Esc]ape tile editing mode
		} else if (keySym === Clutter.KEY_Escape) {
			this.currMode === MODES.SELECT ? this.close() : this.select(this._primaryIndicator.rect, this._primaryIndicator.window);

		// [Enter/Space]
		} else if (keySym === Clutter.KEY_Return || keySym === Clutter.KEY_space) {
			if (this.currMode !== MODES.SELECT)
				return;

			const window = this._primaryIndicator.window;
			if (window) {
				this.close();

			// open Tiling Popup, when activating an empty spot
			} else {
				const openWindows = Util.getOpenWindows().filter(w => !this._topTileGroup.includes(w));
				const rect = this._primaryIndicator.rect;
				const tilingPopup = new TilingPopup.TilingSwitcherPopup(openWindows, rect, false);
				if (!tilingPopup.show(this._topTileGroup)) {
					tilingPopup.destroy();
					return;
				}

				tilingPopup.connect("tiling-finished", (popup, tilingCanceled) => {
					if (tilingCanceled)
						return;

					const {tiledWindow} = popup;
					this._topTileGroup.unshift(tiledWindow);
					this.select(tiledWindow.tiledRect, tiledWindow);
				});
			}

		// switch selection (WASD, hjkl and arrow keys)
		} else if (Util.eventIsDirection(keySym, Meta.MotionDirection.UP)) {
			isSuperPressed ? this._resize(MainExtension.TILING.TOP, isShiftPressed)
					: this._selectTowards(MainExtension.TILING.TOP, isCtrlPressed);

		} else if (Util.eventIsDirection(keySym, Meta.MotionDirection.DOWN)) {
			isSuperPressed ? this._resize(MainExtension.TILING.BOTTOM, isShiftPressed)
					: this._selectTowards(MainExtension.TILING.BOTTOM, isCtrlPressed);

		} else if (Util.eventIsDirection(keySym, Meta.MotionDirection.LEFT)) {
			isSuperPressed ? this._resize(MainExtension.TILING.LEFT, isShiftPressed)
					: this._selectTowards(MainExtension.TILING.LEFT, isCtrlPressed);

		} else if (Util.eventIsDirection(keySym, Meta.MotionDirection.RIGHT)) {
			isSuperPressed ? this._resize(MainExtension.TILING.RIGHT, isShiftPressed)
					: this._selectTowards(MainExtension.TILING.RIGHT, isCtrlPressed);
		}
	}

	_selectTowards(direction, isCtrlPressed) {
		const currRect = isCtrlPressed ? this._secondaryIndicator.rect : this._primaryIndicator.rect;
		const closestRect = Util.getClosestRect(currRect, this._topTileGroup.map(w => w.tiledRect)
				.concat(Util.getFreeScreenRects(this._topTileGroup)), direction, true);
		const newWindow = closestRect && this._topTileGroup.find(w => w.tiledRect.equal(closestRect));
		isCtrlPressed ? this.secondarySelect(closestRect, newWindow) : this.select(closestRect, newWindow);
	};

	_resize(direction, isShiftPressed) {
		const window = this._primaryIndicator.window;
		if (!window)
			return;

		const resizedRect = window.tiledRect.copy();
		const workArea = window.get_work_area_current_monitor();
		let resizeAmount = 100;
		// limit resizeAmount when trying to extend outside of the current screen
		if (direction === MainExtension.TILING.TOP && isShiftPressed)
			resizeAmount = Math.min(resizeAmount, resizedRect.y - workArea.y);
		else if (direction === MainExtension.TILING.BOTTOM && !isShiftPressed)
			resizeAmount = Math.min(resizeAmount, workArea.y + workArea.height - (resizedRect.y + resizedRect.height));
		else if (direction === MainExtension.TILING.LEFT && isShiftPressed)
			resizeAmount = Math.min(resizeAmount, resizedRect.x - workArea.x);
		else if (direction === MainExtension.TILING.RIGHT && !isShiftPressed)
			resizeAmount = Math.min(resizeAmount, workArea.x + workArea.width - (resizedRect.x + resizedRect.width));

		const isVertical = direction === MainExtension.TILING.TOP || direction === MainExtension.TILING.BOTTOM;
		const changeDir = ((direction === MainExtension.TILING.BOTTOM || direction === MainExtension.TILING.RIGHT) ? 1 : -1)
				* (isShiftPressed ? -1 : 1);
		const getResizedRect = function(rect, dimensionChangeOnly, dir) {
			return new Meta.Rectangle({
				x: rect.x + (dimensionChangeOnly || isVertical ? 0 : resizeAmount * -dir),
				y: rect.y + (!dimensionChangeOnly && isVertical ? resizeAmount * -dir : 0),
				width: rect.width + (isVertical ? 0 : resizeAmount * dir),
				height: rect.height + (isVertical ? resizeAmount * dir : 0),
			});
		};
		const resizeSide = function(rect1, rect2, opposite) {
			const [posProp, dimensionProp] = isVertical ? ["y", "height"] : ["x", "width"];
			if (isShiftPressed)
				return opposite ? Util.equalApprox(rect1[posProp] + rect1[dimensionProp], rect2[posProp])
						: Util.equalApprox(rect1[posProp], rect2[posProp]);
			else
				return opposite ? Util.equalApprox(rect1[posProp], rect2[posProp] + rect2[dimensionProp])
						: Util.equalApprox(rect1[posProp] + rect1[dimensionProp], rect2[posProp] + rect2[dimensionProp]);
		};

		this._topTileGroup.forEach(w => {
			if (resizeSide(w.tiledRect, resizedRect, false))
				Util.tileWindow(w, getResizedRect(w.tiledRect, !isShiftPressed, changeDir), false);
			else if (resizeSide(w.tiledRect, resizedRect, true))
				Util.tileWindow(w, getResizedRect(w.tiledRect, isShiftPressed, -changeDir), false);
		});
		this.select(window.tiledRect, window);
	}

	vfunc_key_release_event(keyEvent) {
		const keySym = keyEvent.keyval;
		// swap focused and secondary window(s)/rect
		if (this.currMode === MODES.SWAP && [Clutter.KEY_Control_L, Clutter.KEY_Control_R].includes(keySym)) {
			const primWindow = this._primaryIndicator.window;
			const secWindow = this._secondaryIndicator.window;
			primWindow && Util.tileWindow(primWindow, this._secondaryIndicator.rect, false);
			secWindow && Util.tileWindow(secWindow, this._primaryIndicator.rect, false);
			this.select(this._secondaryIndicator.rect, primWindow);
		}
	}
});

const Indicator = GObject.registerClass(class TilingEditingModeIndicator extends St.Widget {
	_init(window, style) {
		super._init({
			x: window.tiledRect.x + 100,
			y: window.tiledRect.y + 100,
			width: window.tiledRect.width - 200,
			height: window.tiledRect.height - 200,
			opacity: 0,
			style: style,
		});

		this.rect = window.tiledRect;
		this.window = window;
	}

	select(rect, window) {
		const gap = MainExtension.settings.get_int("window-gap");
		this.ease({
			x: rect.x + (gap - 2) / 2,
			y: rect.y + (gap - 2) / 2,
			width: rect.width - gap + 2,
			height: rect.height - gap + 2,
			opacity: 255,
			duration: 150,
			mode: Clutter.AnimationMode.EASE_OUT_QUAD,
		});

		this.rect = rect;
		this.window = window;
	}
});
