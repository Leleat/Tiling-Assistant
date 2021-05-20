"use strict";

const {appDisplay, main, panelMenu} = imports.ui;
const {Clutter, Gio, GLib, GObject, Shell, St} = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const MainExtension = Me.imports.extension;
const Util = Me.imports.tilingUtil;

const TILING_MODES = {
	LEFT: "left",
	TOP: "top",
	RIGHT: "right",
	BOTTOM: "bottom"
};

// classes to open apps (via AppIcon) in a tiled state

var Manager = class SemiAutoTilingMode {
	constructor() {
		this._panelButton = main.panel.addToStatusArea("tiling-mode-button", new PanelButton(this.tilingModeEnabled), 1);
		this._panelButton.connect("button-press-event", () => {
			const cycleModes = [TILING_MODES.LEFT, TILING_MODES.TOP, TILING_MODES.RIGHT, TILING_MODES.BOTTOM];
			this.currTilingMode = cycleModes[(cycleModes.indexOf(this.currTilingMode) + 1) % cycleModes.length];
		});

		this.currTilingMode = MainExtension.settings.get_string("current-tiling-mode");

		// replace app activate function
		const that = this;
		this._originalAppActivate = appDisplay.AppIcon.prototype.activate;
		appDisplay.AppIcon.prototype.activate = function(button) {
			that._appIconActivate.call(this, button, that.tilingModeEnabled && that.currTilingMode);
		};

		this._settingsSignalId = MainExtension.settings.connect("changed::enable-tiling-mode", () =>
				this._panelButton.visible = !this._panelButton.visible);
	}

	destroy() {
		// restore app activate function
		appDisplay.AppIcon.prototype.activate = this._originalAppActivate;
		this._originalAppActivate = null;

		MainExtension.settings.disconnect(this._settingsSignalId);

		this._panelButton.destroy();
	}

	cycleTilingModes(shortcutName) {
		// primary toggle: right <-> bottom tiling modes
		// secondary toggle: left <-> top tiling modes
		const cycleStates = shortcutName === MainExtension.TILING.TILING_MODE_PRIMARY
				? [TILING_MODES.RIGHT, TILING_MODES.BOTTOM] : [TILING_MODES.LEFT, TILING_MODES.TOP];
		const currState = cycleStates.indexOf(this.currTilingMode);
		this.currTilingMode = cycleStates[(currState + 1) % cycleStates.length];
	}

	// called with AppIcon as `this`
	_appIconActivate(button, tilingMode) {
		const event = Clutter.get_current_event();
		const modifiers = event ? event.get_state() : 0;
		const isMiddleButton = button && button === Clutter.BUTTON_MIDDLE;
		const isCtrlPressed = modifiers & Clutter.ModifierType.CONTROL_MASK;
		const isShiftPressed = modifiers & Clutter.ModifierType.SHIFT_MASK;
		const openNewWindow = this.app.can_open_new_window() && this.app.state === Shell.AppState.RUNNING
				&& (isCtrlPressed || isMiddleButton);

		if (this.app.state === Shell.AppState.STOPPED || openNewWindow || tilingMode)
			this.animateLaunch();

		if (isShiftPressed && tilingMode) {
			const openAppSplit = (tileRectToSplit, windowToSplit) => {
				const isSecondaryPos = [TILING_MODES.RIGHT, TILING_MODES.BOTTOM].includes(tilingMode);
				const isVerticalSplit = [TILING_MODES.LEFT, TILING_MODES.RIGHT].includes(tilingMode);
				const [pos, dimension] = isVerticalSplit ? ["x", "width"] : ["y", "height"];
				const newRect = tileRectToSplit.copy();
				newRect[dimension] = newRect[dimension] / 2;
				newRect[pos] = isSecondaryPos ? newRect[pos] + newRect[dimension] : newRect[pos];

				Util.openAppTiled(this.app, newRect, true);

				if (windowToSplit)
					Util.tileWindow(windowToSplit, Util.rectDiff(tileRectToSplit, newRect)[0], false);
			};

			const freeScreenSpace = Util.getFreeScreenSpace(Util.getTopTileGroup(false));
			const focusedWindow = global.display.focus_window;
			const activeWs = global.workspace_manager.get_active_workspace();
			const workArea = activeWs.get_work_area_for_monitor(global.display.get_current_monitor());
			if (freeScreenSpace && !freeScreenSpace.equal(workArea))
				Util.openAppTiled(this.app, freeScreenSpace, true);
			else if (focusedWindow && (focusedWindow.isTiled || Util.windowIsMaximized(focusedWindow)))
				openAppSplit(focusedWindow.tiledRect || workArea, focusedWindow);
			else
				openAppSplit(workArea);

		} else if (openNewWindow) {
			this.app.open_new_window(-1);
		} else {
			this.app.activate();
		}

		main.overview.hide();
	}

	get tilingModeEnabled() {
		return MainExtension.settings.get_boolean("enable-tiling-mode");
	}

	get currTilingMode() {
		return this._currTilingMode;
	}

	set currTilingMode(newMode) {
		this._currTilingMode = newMode;
		this._panelButton.updateState(newMode);
		MainExtension.settings.set_string("current-tiling-mode", newMode);
	}
};

const PanelButton = GObject.registerClass(class TilingDirectionCycleButton extends panelMenu.Button {
	_init(show) {
		super._init(0.0, null, true);
		this.visible = show;

		this._icon = new St.Icon({
			icon_size: 32,
			y_align: Clutter.ActorAlign.CENTER
		});
		this.add_child(this._icon);

		this._tooltip = new St.Label({
			visible: false,
			style: "background-color: #212121; \
				border-radius: 6px; \
				border: 1px solid dimgray; \
				padding: 8px"
		});
		main.uiGroup.add_child(this._tooltip)
		this.connect("destroy", () => this._tooltip.destroy());

		this.connect("notify::hover", this._onHoverStateChanged.bind(this));
	}

	vfunc_button_press_event() {
		// prevent tooltip from showing, if button is clicked
		this._latestHoverTimerId = 0;
	}

	updateState(tilingMode) {
		this._updateIcon(tilingMode);
		this._updateTooltipText(tilingMode);
	}

	_updateIcon(tilingMode) {
		let iconName;
		switch (tilingMode) {
			case TILING_MODES.TOP:
				iconName = "top_tiling_icon.png";
				break;
			case TILING_MODES.BOTTOM:
				iconName = "bottom_tiling_icon.png";
				break;
			case TILING_MODES.LEFT:
				iconName = "left_tiling_icon.png";
				break;
			case TILING_MODES.RIGHT:
				iconName = "right_tiling_icon.png";
				break;
			default:
				iconName = "floating_icon.png";
		}
		this._icon.set_gicon(Gio.icon_new_for_string(Me.path + "/images/" + iconName));
	}

	_updateTooltipText(tilingMode) {
		this._tooltip.get_clutter_text().set_markup(!tilingMode ? "Floating window mode" :
`Activating an <u><b>AppIcon</b></u> while holding <u><b>Shift</b></u> will open a new window to fill the free screen space.
If there is none or if the free space is ambiguous and the focused window is tiled, halve the focused window.
The new window will take the <u><b>${tilingMode.toUpperCase()}</b></u> half; the focused window the other one.`
		);
		this._updateToolTipPosition();
	}

	_updateToolTipPosition() {
		const [, mouseY] = global.get_pointer();
		const display = global.display.get_monitor_geometry(global.display.get_current_monitor());
		this._tooltip.set_position(display.x + display.width - this._tooltip.width - 20, mouseY + 30);
	}

	_onHoverStateChanged() {
		if (this.get_hover()) {
			const timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, 600, () => {
				// only show tooltip, if the latest hover timer timed out
				if (this.get_hover() && timerId === this._latestHoverTimerId) {
					this._updateToolTipPosition();
					this._tooltip.show();
				}

				return GLib.SOURCE_REMOVE;
			});
			this._latestHoverTimerId = timerId;

		} else {
			this._tooltip.hide();
		}
	}
});
