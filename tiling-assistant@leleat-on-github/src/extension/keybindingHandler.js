"use strict";

const {main} = imports.ui;
const {Clutter, Meta, Shell, St} = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const {DynamicKeybindings, Settings, Shortcuts} = Me.imports.src.common;
const {Util} = Me.imports.src.extension.utility;

const Gettext = imports.gettext;
const Domain = Gettext.domain(Me.metadata.uuid);
const _ = Domain.gettext;

/**
 * Class to handle the keyboard shortcuts (on the extension side) except the
 * ones related to the popupLayouts. For those, see popupLayoutsManager.js.
 */

var Handler = class TilingKeybindingHandler {

	constructor() {
		const allowInOverview = [Shortcuts.TOGGLE_POPUP];
		this._keyBindings = Shortcuts.getAllKeys();
		this._keyBindings.forEach(key => {
			main.wm.addKeybinding(key
				, Settings.getGioObject()
				, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT
				, Shell.ActionMode.NORMAL | (allowInOverview.includes(key) && Shell.ActionMode.OVERVIEW)
				, this._onCustomKeybindingPressed.bind(this, key)
			);
		});
	};

	destroy() {
		this._keyBindings.forEach(key => main.wm.removeKeybinding(key));
		this._debuggingIndicators?.forEach(i => i.destroy());
	};

	_onCustomKeybindingPressed(shortcutName) {
		// debugging
		if (shortcutName === Shortcuts.DEBUGGING || shortcutName === Shortcuts.DEBUGGING_FREE_RECTS) {
			if (this._debuggingIndicators) {
				this._debuggingIndicators.forEach(i => i.destroy());
				this._debuggingIndicators = null;
			} else {
				const createIndicators = shortcutName === Shortcuts.DEBUGGING
						? Util.___debugShowTiledRects
						: Util.___debugShowFreeScreenRects;
				this._debuggingIndicators = createIndicators.call(Util);
			}
			return;

		// toggle the popup
		} else if (shortcutName === Shortcuts.TOGGLE_POPUP) {
			const toggleTo = !Settings.getBoolean(Settings.ENABLE_TILING_POPUP);
			Settings.setBoolean(Settings.ENABLE_TILING_POPUP, toggleTo);
			const message = toggleTo ? _("Tiling popup enabled") : _("Tiling popup was disabled");
			main.notify("Tiling Assistant", message);
			return;
		}

		const window = global.display.focus_window;
		if (!window)
			return;

		// auto tile: tile to empty space. If there's none: untile, if it's already tiled else maximize
		if (shortcutName === Shortcuts.AUTO_FILL) {
			const tileRect = Util.getBestFitTiledRect(window);
			Util.toggleTileState(window, tileRect);

		// tile editing mode
		} else if (shortcutName === Shortcuts.EDIT_MODE) {
			const TileEditingMode = Me.imports.src.extension.tileEditingMode;
			const tileEditor = new TileEditingMode.TileEditor();
			tileEditor.open();

		// tile window
		} else {
			const dynamicSetting = Settings.getString(Settings.DYNAMIC_KEYBINDINGS_BEHAVIOUR);
			switch (dynamicSetting) {
				case DynamicKeybindings.FOCUS:
					this._dynamicFocus(window, shortcutName);
					break;
				case DynamicKeybindings.TILING_STATE:
				case DynamicKeybindings.TILING_STATE_WINDOWS:
					const isWindowsStyle = dynamicSetting === DynamicKeybindings.TILING_STATE_WINDOWS;
					this._dynamicTilingState(window, shortcutName, isWindowsStyle);
					break;
				default:
					const workArea = window.get_work_area_current_monitor();
					Util.toggleTileState(window, Util.getTileRectFor(shortcutName, workArea));
			}
		}
	};

	_dynamicFocus(window, shortcutName) {
		const topTileGroup = Util.getTopTileGroup(false);
		const workArea = window.get_work_area_current_monitor();

		if (window.isTiled && topTileGroup.length > 1) {
			const closestTiledRect = Util.getClosestRect(
				window.tiledRect
				, topTileGroup.map(w => w.tiledRect)
				, shortcutName
			);

			if (!closestTiledRect) {
				Util.toggleTileState(window, Util.getTileRectFor(shortcutName, workArea));
				return;
			}

			const closestTiledWindow = topTileGroup.find(w => w.tiledRect.equal(closestTiledRect));
			closestTiledWindow.activate(global.get_current_time());

			// animate for visibilty
			const fromRect = window.get_frame_rect();
			const focusIndicator = new St.Widget({
				style_class: "tile-preview",
				opacity: 0,
				x: fromRect.x,
				y: fromRect.y,
				width: fromRect.width,
				height: fromRect.height
			});
			main.uiGroup.add_child(focusIndicator);
			const toRect = closestTiledWindow.get_frame_rect();
			focusIndicator.ease({
				opacity: 255,
				x: toRect.x,
				y: toRect.y,
				width: toRect.width,
				height: toRect.height,
				duration: 200,
				mode: Clutter.AnimationMode.EASE_OUT_QUART,
				onComplete: () => {
					focusIndicator.ease({
						opacity: 0,
						duration: 200,
						mode: Clutter.AnimationMode.EASE_IN_OUT_CIRC,
						delay: 100,
						onComplete: () => focusIndicator.destroy()
					});
				}
			});

		// toggle tile state window, if it isn't tiled or the only one which is
		} else {
			Util.toggleTileState(window, Util.getTileRectFor(shortcutName, workArea));
		}
	};

	// @isWindowsStyle: minimize when not tiled or tiling state at bottom
	// and 'tile to bottom' shortcut is pressed
	_dynamicTilingState(window, shortcutName, isWindowsStyle) {
		if (Util.isMaximized(window)
				&& [Shortcuts.BOTTOM, Shortcuts.TOP, Shortcuts.MAXIMIZE].includes(shortcutName)) {
			Util.untile(window);
			return;
		}

		const workArea = window.get_work_area_current_monitor();

		if (!window.isTiled) {
			isWindowsStyle && shortcutName === Shortcuts.BOTTOM
					? window.minimize()
					: Util.toggleTileState(window, Util.getTileRectFor(shortcutName, workArea));
			return;
		}

		const wRect = window.tiledRect;
		const isLeftHalf =
				wRect.x === workArea.x
				&& wRect.y === workArea.y
				&& wRect.width !== workArea.width
				&& wRect.height === workArea.height;
		const isRightHalf =
				wRect.x !== workArea.x
				&& wRect.y === workArea.y
				&& wRect.x + wRect.width === workArea.x + workArea.width
				&& wRect.height === workArea.height;
		const isTopHalf =
				wRect.x === workArea.x
				&& wRect.y === workArea.y
				&& wRect.width === workArea.width
				&& wRect.height !== workArea.height;
		const isBottomHalf =
				wRect.x === workArea.x
				&& wRect.y !== workArea.y
				&& wRect.width === workArea.width
				&& wRect.y + wRect.height === workArea.y + workArea.height;
		const isTopLeftQuarter =
				wRect.x === workArea.x
				&& wRect.y === workArea.y
				&& wRect.width !== workArea.width
				&& wRect.height !== workArea.height;
		const isTopRightQuarter =
				wRect.x !== workArea.x
				&& wRect.y === workArea.y
				&& wRect.x + wRect.width === workArea.x + workArea.width
				&& wRect.height !== workArea.height;
		const isBottomLeftQuarter =
				wRect.x === workArea.x
				&& wRect.y !== workArea.y
				&& wRect.width !== workArea.width
				&& wRect.y + wRect.height === workArea.y + workArea.height;
		const isBottomRightQuarter =
				wRect.x !== workArea.x
				&& wRect.y !== workArea.y
				&& wRect.x + wRect.width === workArea.x + workArea.width
				&& wRect.y + wRect.height === workArea.y + workArea.height;

		if (isLeftHalf) {
			switch (shortcutName) {
				case Shortcuts.TOP:
				case Shortcuts.MAXIMIZE:
					Util.toggleTileState(window, Util.getTileRectFor(Shortcuts.TOP_LEFT, workArea));
					return;
				case Shortcuts.BOTTOM:
					Util.toggleTileState(window, Util.getTileRectFor(Shortcuts.BOTTOM_LEFT, workArea));
					return;
				case Shortcuts.RIGHT:
					Util.untile(window);
					return;
			}
		} else if (isRightHalf) {
			switch (shortcutName) {
				case Shortcuts.TOP:
				case Shortcuts.MAXIMIZE:
					Util.toggleTileState(window, Util.getTileRectFor(Shortcuts.TOP_RIGHT, workArea));
					return;
				case Shortcuts.BOTTOM:
					Util.toggleTileState(window, Util.getTileRectFor(Shortcuts.BOTTOM_RIGHT, workArea));
					return;
				case Shortcuts.LEFT:
					Util.untile(window);
					return;
			}
		} else if (isTopHalf) {
			switch (shortcutName) {
				case Shortcuts.LEFT:
					Util.toggleTileState(window, Util.getTileRectFor(Shortcuts.TOP_LEFT, workArea));
					return;
				case Shortcuts.RIGHT:
					Util.toggleTileState(window, Util.getTileRectFor(Shortcuts.TOP_RIGHT, workArea));
					return;
				case Shortcuts.BOTTOM:
					Util.untile(window);
					return;
			}
		} else if (isBottomHalf) {
			switch (shortcutName) {
				case Shortcuts.LEFT:
					Util.toggleTileState(window, Util.getTileRectFor(Shortcuts.BOTTOM_LEFT, workArea));
					return;
				case Shortcuts.RIGHT:
					Util.toggleTileState(window, Util.getTileRectFor(Shortcuts.BOTTOM_RIGHT, workArea));
					return;
				case Shortcuts.TOP:
				case Shortcuts.MAXIMIZE:
					Util.untile(window);
					return;
				case Shortcuts.BOTTOM:
					isWindowsStyle
							? window.minimize()
							: Util.toggleTileState(window, Util.getTileRectFor(Shortcuts.BOTTOM, workArea));
					return;
			}
		} else if (isTopLeftQuarter) {
			switch (shortcutName) {
				case Shortcuts.RIGHT:
					Util.toggleTileState(window, Util.getTileRectFor(Shortcuts.TOP, workArea));
					return;
				case Shortcuts.BOTTOM:
					Util.toggleTileState(window, Util.getTileRectFor(Shortcuts.LEFT, workArea));
					return;
			}
		} else if (isTopRightQuarter) {
			switch (shortcutName) {
				case Shortcuts.LEFT:
					Util.toggleTileState(window, Util.getTileRectFor(Shortcuts.TOP, workArea));
					return;
				case Shortcuts.BOTTOM:
					Util.toggleTileState(window, Util.getTileRectFor(Shortcuts.RIGHT, workArea));
					return;
			}
		} else if (isBottomLeftQuarter) {
			switch (shortcutName) {
				case Shortcuts.TOP:
				case Shortcuts.MAXIMIZE:
					Util.toggleTileState(window, Util.getTileRectFor(Shortcuts.LEFT, workArea));
					return;
				case Shortcuts.RIGHT:
					Util.toggleTileState(window, Util.getTileRectFor(Shortcuts.BOTTOM, workArea));
					return;
				case Shortcuts.BOTTOM:
					isWindowsStyle
							? window.minimize()
							: Util.toggleTileState(window, Util.getTileRectFor(Shortcuts.BOTTOM, workArea));
					return;
			}
		} else if (isBottomRightQuarter) {
			switch (shortcutName) {
				case Shortcuts.TOP:
				case Shortcuts.MAXIMIZE:
					Util.toggleTileState(window, Util.getTileRectFor(Shortcuts.RIGHT, workArea));
					return;
				case Shortcuts.LEFT:
					Util.toggleTileState(window, Util.getTileRectFor(Shortcuts.BOTTOM, workArea));
					return;
				case Shortcuts.BOTTOM:
					isWindowsStyle
							? window.minimize()
							: Util.toggleTileState(window, Util.getTileRectFor(Shortcuts.BOTTOM, workArea));
					return;
			}
		}

		Util.toggleTileState(window, Util.getTileRectFor(shortcutName, workArea));
	};
};
