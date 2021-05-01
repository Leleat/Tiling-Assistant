"use strict";

const {appDisplay, main, panelMenu} = imports.ui;
const {Clutter, GLib, GObject, Shell, St} = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const MainExtension = Me.imports.extension;
const Util = Me.imports.tilingUtil;

// classes to handle opening an app (via AppIcon activation) in a tiled state when holding Shift/Alt

var Handler = class TilingWindowOpener {
	constructor() {
		this._toggleButton = main.panel.addToStatusArea("open-tiled-direction-toggle", new DirectionToggleButton(), 1);
		this._toggleButton.visible = MainExtension.settings.get_boolean("show-icon-open-app-vertically");

		this.settingsSignalId = MainExtension.settings.connect("changed::show-icon-open-app-vertically", () => {
			this._toggleButton.visible = !this._toggleButton.visible
		});

		// open apps in a tiled state by holding Shift/Alt when activating an AppIcon
		this.oldAppActivateFunc = appDisplay.AppIcon.prototype.activate;
		appDisplay.AppIcon.prototype.activate = function(button) {
			const event = Clutter.get_current_event();
			const modifiers = event ? event.get_state() : 0;
			const isAltPressed = modifiers & Clutter.ModifierType.MOD1_MASK;
			const isShiftPressed = modifiers & Clutter.ModifierType.SHIFT_MASK;
			const isMiddleButton = button && button === Clutter.BUTTON_MIDDLE;
			const isCtrlPressed = modifiers & Clutter.ModifierType.CONTROL_MASK;
			const openNewWindow = this.app.can_open_new_window() && this.app.state === Shell.AppState.RUNNING
					&& (isCtrlPressed || isMiddleButton);

			if (this.app.state === Shell.AppState.STOPPED || openNewWindow || isShiftPressed || isAltPressed)
				this.animateLaunch();

			if (openNewWindow) {
				this.app.open_new_window(-1);

			// main new code:
			} else if (isShiftPressed || isAltPressed) {
				if (!this.app.can_open_new_window())
					return;

				const activeWs = global.workspace_manager.get_active_workspace();
				const workArea = activeWs.get_work_area_for_monitor(global.display.get_current_monitor());
				const freeScreenSpace = Util.getFreeScreenSpace(Util.getTopTileGroup(false));
				let tileToRect;

				// fill unambiguous free screen space, if it exists
				if (freeScreenSpace && !freeScreenSpace.equal(workArea)) {
					tileToRect = freeScreenSpace

				// else split focused window, if it exists
				} else {
					const isVertical = MainExtension.settings.get_boolean("open-app-vertically");
					const [pos, dimension] = isVertical ? ["x", "width"] : ["y", "height"];
					const window = global.display.focus_window;
					const focusedTiledRect = window && window.tiledRect;
					const toSplitRect = focusedTiledRect || workArea;
					tileToRect = toSplitRect.copy();
					tileToRect[pos] += isAltPressed ? tileToRect[dimension] / 2 : 0;
					tileToRect[dimension] = tileToRect[dimension] / 2;

					if (window && (window.isTiled || Util.windowIsMaximized(window)))
						Util.tileWindow(window, Util.rectDiff(toSplitRect, tileToRect)[0], false);
				}

				Util.openAppTiled(this.app, tileToRect, true);

			} else {
				this.app.activate();
			}

			main.overview.hide();
		};
	}

	destroy() {
		MainExtension.settings.disconnect(this.settingsSignalId);
		this._toggleButton.destroy();
		appDisplay.AppIcon.prototype.activate = this.oldAppActivateFunc;
	}

	toggleSplitMode() {
		this._toggleButton.toggle();
	}
};

const DirectionToggleButton = GObject.registerClass(class TilingDirectionToggleButton extends panelMenu.Button {
	_init() {
		super._init(0.0, null, true);

		this._icon = new St.Icon({
			icon_size: 24,
			y_align: Clutter.ActorAlign.CENTER
		});
		this.add_child(this._icon);

		this._tooltip = new St.Label({
			visible: false,
			style: 'background-color: #212121; \
				border-radius: 6px; \
				border: 1px solid dimgray; \
				padding: 8px'
		});
		main.uiGroup.add_child(this._tooltip)
		this.connect("destroy", () => this._tooltip.destroy());

		this.connect("notify::hover", this._onHoverStateChanged.bind(this));

		this._updateIcon();
		this._updateTooltipText();
	}

	vfunc_button_press_event() {
		// prevent tooltip from showing, if button is clicked
		this._latestHoverTimerId = 0;
		this.toggle();
	}

	toggle() {
		MainExtension.settings.set_boolean("open-app-vertically", !this._splitIsVertical());
		this._updateIcon();
		this._updateTooltipText();
	}

	_updateIcon() {
		this._icon.set_icon_name(this._splitIsVertical() ? "media-playback-pause" : "format-justify-fill");
	}

	_updateTooltipText() {
		this._tooltip.set_text(`Open windows ${this._splitIsVertical() ? "vertically" : "horizontally"} tiled while holding Shift/Alt when activating an app.`);
	}

	_onHoverStateChanged() {
		if (this.get_hover()) {
			const timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, 600, () => {
				if (this.get_hover() && timerId === this._latestHoverTimerId) {
					const [, mouseY] = global.get_pointer();
					const display = global.display.get_monitor_geometry(global.display.get_current_monitor());
					this._tooltip.set_position(display.x + display.width - this._tooltip.width - 20, mouseY + 30);
					this._tooltip.show();
				}

				return GLib.SOURCE_REMOVE;
			});
			this._latestHoverTimerId = timerId;

		} else {
			this._tooltip.hide();
		}
	}

	_splitIsVertical() {
		return MainExtension.settings.get_boolean("open-app-vertically");
	}
});
