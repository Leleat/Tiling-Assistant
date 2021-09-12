"use strict";

const {main} = imports.ui;
const {Clutter, Meta, Shell, St} = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const MainExtension = Me.imports.extension;
const Util = Me.imports.tilingUtil;
const TileEditingMode = Me.imports.tilingEditingMode;

const Gettext = imports.gettext;
const Domain = Gettext.domain(Me.metadata.uuid);
const _ = Domain.gettext;

/**
 * Class to handle keyboard shortcuts.
 */

var Handler = class TilingKeybindingHandler {

	constructor() {
		this._keyBindings = Object.values(MainExtension.TILING);
		const bindingInOverview = [MainExtension.TILING.TOGGLE_POPUP];
		this._keyBindings.forEach(key => {
			main.wm.addKeybinding(key, MainExtension.settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, Shell.ActionMode.NORMAL
					| (bindingInOverview.includes(key) ? Shell.ActionMode.OVERVIEW : 0), this._onCustomKeybindingPressed.bind(this, key));
		});
	}

	destroy() {
		this._keyBindings.forEach(key => main.wm.removeKeybinding(key));

		this._debuggingIndicators && this._debuggingIndicators.forEach(i => i.destroy());
		this._debuggingIndicators = null;
	}

	_onCustomKeybindingPressed(shortcutName) {
		// debugging
		if (shortcutName === MainExtension.TILING.DEBUGGING || shortcutName === MainExtension.TILING.DEBUGGING_FREE_RECTS) {
			if (this._debuggingIndicators) {
				this._debuggingIndicators.forEach(i => i.destroy());
				this._debuggingIndicators = null;
			} else {
				const func = shortcutName === MainExtension.TILING.DEBUGGING ? Util.___debugShowTiledRects : Util.___debugShowFreeScreenRects;
				this._debuggingIndicators = func.call(this);
			}
			return;

		// toggle the popup, which appears when a window is tiled and there's free screen space
		} else if (shortcutName === MainExtension.TILING.TOGGLE_POPUP) {
			const toggleTo = !MainExtension.settings.get_boolean("enable-tiling-popup");
			MainExtension.settings.set_boolean("enable-tiling-popup", toggleTo);
			const message = toggleTo ? _("Tiling-assistant's popup enabled") : _("Tiling-assistant's popup was disabled");
			main.notify(_("Tiling Assistant"), message);
			return;
		}

		const window = global.display.focus_window;
		if (!window)
			return;

		// auto tile: tile to empty space. If there's no empty space: untile, if it's already tiled else maximize
		if (shortcutName === MainExtension.TILING.AUTO) {
			const tileRect = Util.getBestFitTiledRect(window);
			Util.toggleTileState(window, tileRect);

		// tile editing mode
		} else if (shortcutName === MainExtension.TILING.EDIT_MODE) {
			if (!Util.getTopTileGroup(!window.isTiled).length) {
				main.notify(_("Tiling Assistant"), _("Can't enter 'Tile Editing Mode', if the focused window isn't tiled."));
				return;
			}

			!window.isTiled && window.lower();
			const openWindows = Util.getOpenWindows();

			const tileEditor = new TileEditingMode.TileEditor();
			tileEditor.open(openWindows[0]);

		// tile window
		} else {
			const dynamicSetting = MainExtension.settings.get_string("dynamic-keybinding-behaviour");
			switch (dynamicSetting) {
				case "Focus":
					this._dynamicFocus(window, shortcutName);
					break;
				case "Tiling State":
				case "Tiling State (Windows)":
					this._dynamicTilingState(window, shortcutName, dynamicSetting === "Tiling State (Windows)");
					break;
				default:
					Util.toggleTileState(window, Util.getTileRectFor(shortcutName, window.get_work_area_current_monitor()));
			}
		}
	}

	_dynamicFocus(window, shortcutName) {
		const topTileGroup = Util.getTopTileGroup(false);
		if (window.isTiled && topTileGroup.length > 1) {
			const closestTiledRect = Util.getClosestRect(window.tiledRect, topTileGroup.map(w => w.tiledRect), shortcutName);
			if (!closestTiledRect) {
				Util.toggleTileState(window, Util.getTileRectFor(shortcutName, window.get_work_area_current_monitor()));
				return;
			}

			const closestTiledWindow = topTileGroup.find(w => w.tiledRect.equal(closestTiledRect));
			closestTiledWindow.activate(global.get_current_time());

			// animate for visibilty
			const fromRect = window.get_frame_rect();
			const focusIndicator = new St.Widget({
				style_class: "tile-preview",
				opacity: 0,
				x: fromRect.x, y: fromRect.y,
				width: fromRect.width, height: fromRect.height
			});
			main.uiGroup.add_child(focusIndicator);
			const toRect = closestTiledWindow.get_frame_rect();
			Util.compatEase(focusIndicator, {
					opacity: 255,
					x: toRect.x, y: toRect.y,
					width: toRect.width, height: toRect.height
				}, 200
				, Clutter.AnimationMode.EASE_OUT_QUART
				, () => Util.compatEase(focusIndicator, {
					opacity: 0,
				}, 200, Clutter.AnimationMode.EASE_IN_OUT_CIRC, () => {
					focusIndicator.destroy();
				}, 100)
			);

		// toggle tile state window, if it isn't tiled or the only one which is
		} else {
			Util.toggleTileState(window, Util.getTileRectFor(shortcutName, window.get_work_area_current_monitor()));
		}
	}

	// @isWindowsStyle -> minimize when tiling state at bottom and 'tile to bottom' shortcut is pressed
	_dynamicTilingState(window, shortcutName, isWindowsStyle) {
		if (Util.windowIsMaximized(window) && [MainExtension.TILING.BOTTOM, MainExtension.TILING.TOP, MainExtension.TILING.MAXIMIZE].includes(shortcutName)) {
			Util.restoreWindowSize(window);
			return;
		}

		if (!window.isTiled) {
			isWindowsStyle && shortcutName === MainExtension.TILING.BOTTOM ? window.minimize()
					: Util.toggleTileState(window, Util.getTileRectFor(shortcutName, window.get_work_area_current_monitor()));
			return;
		}

		const wRect = window.tiledRect;
		const workArea = window.get_work_area_current_monitor();
		const isLeftHalf = wRect.x === workArea.x && wRect.y === workArea.y && wRect.width !== workArea.width && wRect.height === workArea.height;
		const isRightHalf = wRect.x !== workArea.x && wRect.y === workArea.y && wRect.x + wRect.width === workArea.x + workArea.width && wRect.height === workArea.height;
		const isTopHalf = wRect.x === workArea.x && wRect.y === workArea.y && wRect.width === workArea.width && wRect.height !== workArea.height;
		const isBottomHalf = wRect.x === workArea.x && wRect.y !== workArea.y && wRect.width === workArea.width && wRect.y + wRect.height === workArea.y + workArea.height;
		const isTopLeftQuarter = wRect.x === workArea.x && wRect.y === workArea.y && wRect.width !== workArea.width && wRect.height !== workArea.height;
		const isTopRightQuarter = wRect.x !== workArea.x && wRect.y === workArea.y && wRect.x + wRect.width === workArea.x + workArea.width && wRect.height !== workArea.height;
		const isBottomLeftQuarter = wRect.x === workArea.x && wRect.y !== workArea.y && wRect.width !== workArea.width && wRect.y + wRect.height === workArea.y + workArea.height;
		const isBottomRightQuarter = wRect.x !== workArea.x && wRect.y !== workArea.y && wRect.x + wRect.width === workArea.x + workArea.width && wRect.y + wRect.height === workArea.y + workArea.height;

		if (isLeftHalf) {
			switch (shortcutName) {
				case MainExtension.TILING.TOP:
				case MainExtension.TILING.MAXIMIZE:
					Util.toggleTileState(window, Util.getTileRectFor(MainExtension.TILING.TOP_LEFT, window.get_work_area_current_monitor()));
					return;
				case MainExtension.TILING.BOTTOM:
					Util.toggleTileState(window, Util.getTileRectFor(MainExtension.TILING.BOTTOM_LEFT, window.get_work_area_current_monitor()));
					return;
				case MainExtension.TILING.RIGHT:
					Util.restoreWindowSize(window);
					return;
			}
		} else if (isRightHalf) {
			switch (shortcutName) {
				case MainExtension.TILING.TOP:
				case MainExtension.TILING.MAXIMIZE:
					Util.toggleTileState(window, Util.getTileRectFor(MainExtension.TILING.TOP_RIGHT, window.get_work_area_current_monitor()));
					return;
				case MainExtension.TILING.BOTTOM:
					Util.toggleTileState(window, Util.getTileRectFor(MainExtension.TILING.BOTTOM_RIGHT, window.get_work_area_current_monitor()));
					return;
				case MainExtension.TILING.LEFT:
					Util.restoreWindowSize(window);
					return;
			}
		} else if (isTopHalf) {
			switch (shortcutName) {
				case MainExtension.TILING.LEFT:
					Util.toggleTileState(window, Util.getTileRectFor(MainExtension.TILING.TOP_LEFT, window.get_work_area_current_monitor()));
					return;
				case MainExtension.TILING.RIGHT:
					Util.toggleTileState(window, Util.getTileRectFor(MainExtension.TILING.TOP_RIGHT, window.get_work_area_current_monitor()));
					return;
				case MainExtension.TILING.BOTTOM:
					Util.restoreWindowSize(window);
					return;
			}
		} else if (isBottomHalf) {
			switch (shortcutName) {
				case MainExtension.TILING.LEFT:
					Util.toggleTileState(window, Util.getTileRectFor(MainExtension.TILING.BOTTOM_LEFT, window.get_work_area_current_monitor()));
					return;
				case MainExtension.TILING.RIGHT:
					Util.toggleTileState(window, Util.getTileRectFor(MainExtension.TILING.BOTTOM_RIGHT, window.get_work_area_current_monitor()));
					return;
				case MainExtension.TILING.TOP:
				case MainExtension.TILING.MAXIMIZE:
					Util.restoreWindowSize(window);
					return;
				case MainExtension.TILING.BOTTOM:
					isWindowsStyle ? window.minimize()
							: Util.toggleTileState(window, Util.getTileRectFor(MainExtension.TILING.BOTTOM, window.get_work_area_current_monitor()));
					return;
			}
		} else if (isTopLeftQuarter) {
			switch (shortcutName) {
				case MainExtension.TILING.RIGHT:
					Util.toggleTileState(window, Util.getTileRectFor(MainExtension.TILING.TOP, window.get_work_area_current_monitor()));
					return;
				case MainExtension.TILING.BOTTOM:
					Util.toggleTileState(window, Util.getTileRectFor(MainExtension.TILING.LEFT, window.get_work_area_current_monitor()));
					return;
			}
		} else if (isTopRightQuarter) {
			switch (shortcutName) {
				case MainExtension.TILING.LEFT:
					Util.toggleTileState(window, Util.getTileRectFor(MainExtension.TILING.TOP, window.get_work_area_current_monitor()));
					return;
				case MainExtension.TILING.BOTTOM:
					Util.toggleTileState(window, Util.getTileRectFor(MainExtension.TILING.RIGHT, window.get_work_area_current_monitor()));
					return;
			}
		} else if (isBottomLeftQuarter) {
			switch (shortcutName) {
				case MainExtension.TILING.TOP:
				case MainExtension.TILING.MAXIMIZE:
					Util.toggleTileState(window, Util.getTileRectFor(MainExtension.TILING.LEFT, window.get_work_area_current_monitor()));
					return;
				case MainExtension.TILING.RIGHT:
					Util.toggleTileState(window, Util.getTileRectFor(MainExtension.TILING.BOTTOM, window.get_work_area_current_monitor()));
					return;
				case MainExtension.TILING.BOTTOM:
					isWindowsStyle ? window.minimize()
							: Util.toggleTileState(window, Util.getTileRectFor(MainExtension.TILING.BOTTOM, window.get_work_area_current_monitor()));
					return;
			}
		} else if (isBottomRightQuarter) {
			switch (shortcutName) {
				case MainExtension.TILING.TOP:
				case MainExtension.TILING.MAXIMIZE:
					Util.toggleTileState(window, Util.getTileRectFor(MainExtension.TILING.RIGHT, window.get_work_area_current_monitor()));
					return;
				case MainExtension.TILING.LEFT:
					Util.toggleTileState(window, Util.getTileRectFor(MainExtension.TILING.BOTTOM, window.get_work_area_current_monitor()));
					return;
				case MainExtension.TILING.BOTTOM:
					isWindowsStyle ? window.minimize()
							: Util.toggleTileState(window, Util.getTileRectFor(MainExtension.TILING.BOTTOM, window.get_work_area_current_monitor()));
					return;
			}
		}

		Util.toggleTileState(window, Util.getTileRectFor(shortcutName, window.get_work_area_current_monitor()));
	}
}