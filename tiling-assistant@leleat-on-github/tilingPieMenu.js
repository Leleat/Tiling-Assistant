const {main} = imports.ui;
const {Clutter, Gio, GLib, GObject, Meta, St} = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const MainExtension = Me.imports.extension;
const Util = Me.imports.tilingUtil;

const Gettext = imports.gettext;
const Domain = Gettext.domain(Me.metadata.uuid);
const _ = Domain.gettext;

const ACTIONS = [
	{name: _("Toggle 'Maximize'"), func: _toggleMaximize},
	{name: _("Minimize window"), func: _minimizeWindow},
	{name: _("Close window"), func: _closeWindow},
	{name: _("Move to previous workspace"), func: _moveToPrevWorkspace},
	{name: _("Move to next workspace"), func: _moveToNextWorkspace},
	{name: _("Move to top monitor"), func: _moveToTopMonitor},
	{name: _("Move to bottom monitor"), func: _moveToBottomMonitor},
	{name: _("Move to left monitor"), func: _moveToLeftMonitor},
	{name: _("Move to right monitor"), func: _moveToRightMonitor},
	{name: _("Toggle fullscreen"), func: _toggleFullscreen},
	{name: _("Toggle 'Always on top'"), func: _toggleAlwaysOnTop},
	{name: _("Tile to left"), func: _tileLeft},
	{name: _("Tile to right"), func: _tileRight},
	{name: _("Tile to top"), func: _tileTop},
	{name: _("Tile to bottom"), func: _tileBottom},
	{name: _("Tile to top-left"), func: _tileTopLeft},
	{name: _("Tile to top-right"), func: _tileTopRight},
	{name: _("Tile to bottom-left"), func: _tileBottomLeft},
	{name: _("Tile to bottom-right"), func: _tileBottomRight},
];

var PieMenu = GObject.registerClass(
	class PieMenu extends St.Widget {
		_init() {
			const {x, y, width, height} = global.display.get_monitor_geometry(global.display.get_current_monitor());
			super._init({
				x, y, width, height,
				reactive: true,
				opacity: 0
			});
			main.uiGroup.add_child(this);

			if (!main.pushModal(this)) {
				// Probably someone else has a pointer grab, try again with keyboard only
				if (!main.pushModal(this, {options: Meta.ModalOptions.POINTER_ALREADY_GRABBED})) {
					super.destroy();
					return;
				}
			}

			const [mX, mY] = global.get_pointer();
			this._clickPos = {x: mX, y: mY};
			this._highlightedItem = null;
			this._items = [];
			this._deadZoneRadius = MainExtension.settings.get_int("pie-menu-deadzone-radius");
			this._itemRadius = this._deadZoneRadius + MainExtension.settings.get_int("pie-menu-item-radius");

			// menu items
			let angle = 270; // 0 - 360° clockwise from x-axis;
			const actionIds = MainExtension.settings.get_strv("pie-menu-options");
			if (!actionIds.length) {
				this.destroy();
				return;
			}

			for (const id of actionIds) {
				const item = new PieMenuItem(ACTIONS[id], angle);
				this._items.push(item);
				this.add_child(item);
				this._setItemPos(item, angle);
				angle = (angle + 360 / actionIds.length) % 360;
			}

			// deadzone circle
			this._deadZone = new St.Widget({
				x: this._clickPos.x - this._deadZoneRadius,
				y: this._clickPos.y - this._deadZoneRadius,
				style_class: "resize-popup",
				style: "border-radius: 999px;",
				width: this._deadZoneRadius * 2,
				height: this._deadZoneRadius * 2,
				reactive: true,
				track_hover: true
			});
			this.add_child(this._deadZone);

			// delay visual to prevent a flicker for fast activation
			this.ease({
				opacity: 255,
				delay: 200,
				duration: 50,
				mode: Clutter.AnimationMode.EASE_OUT_QUAD
			});
		}

		destroy() {
			if (this._alreadyPopped)
				return;

			this._alreadyPopped = true;
			main.popModal(this);
			super.destroy();
		}

		vfunc_button_release_event(buttonEvent) {
			this._highlightedItem && this._highlightedItem.action.func.call(this);
			this.destroy();
		}

		vfunc_motion_event(motionEvent) {
			this._highlightedItem && this._highlightedItem.setFocus(false);
			this._highlightedItem = null;

			if (this._deadZone.get_hover())
				return;

			const {x, y} = motionEvent;
			const relativeX = x - this._clickPos.x;
			const relativeY = y - this._clickPos.y;
			let angle = Math.atan2(relativeY, relativeX) * 180 / Math.PI;
			angle = (angle < 0 ? 360 : 0) + angle; // 0 - 360° clockwise from x-axis
			const pieSize = 360 / this._items.length;
			this._highlightedItem = this._items.find(item => {
				return (angle >= item.angle - pieSize / 2 && angle <= item.angle + pieSize / 2)
						// special case: item around 0°
						|| (item.angle - pieSize / 2 < 0 && angle >= 360 - item.angle - pieSize / 2)
						|| (item.angle + pieSize / 2 > 360 && angle <= (item.angle + pieSize / 2) % 360);
			});
			this._highlightedItem.setFocus(true);
		}

		_setItemPos(item, angle) {
			const centerX = this._clickPos.x + (this._itemRadius * Math.cos(angle * Math.PI / 180));
			const centerY = this._clickPos.y + (this._itemRadius * Math.sin(angle * Math.PI / 180));
			const x = centerX - item.width / 2;
			const y = centerY - item.height / 2;
			const isLeft = angle > 90 && angle < 270;
			const isRight = angle > 270 || angle < 90;
			item.set_position(x + (isLeft ? -item.width / 2 : (isRight ? item.width / 2 : 0))
					, y + (angle === 90 ? item.height / 2 : (angle === 270 ? -item.height / 2 : 0)));
		}
	}
)

const PieMenuItem = GObject.registerClass(
	class PieMenuItem extends St.Label {
		_init(action, angle, fontSize = 18) {
			super._init({
				text: action.name,
				style_class: "resize-popup",
				style: `font-size: ${fontSize}px;\
						text-align: left;\
						padding: 12px;`
			});

			this.action = action;
			this.angle = angle;
		}

		setFocus(focus) {
			focus ? this.add_style_class_name("piemenu-selector-highlight")
					: this.remove_style_class_name("piemenu-selector-highlight");
		}
	}
)

function _toggleMaximize() {
	const window = global.display.focus_window;
	Util.toggleTileState(window, window.get_work_area_current_monitor());
}

function _closeWindow() {
	global.display.focus_window.delete(global.get_current_time());
}

function _minimizeWindow() {
	global.display.focus_window.minimize();
}

function _moveToPrevWorkspace() {
	const window = global.display.focus_window;
	const activeWsIdx = global.workspace_manager.get_active_workspace_index();
	window.change_workspace_by_index(Math.max(activeWsIdx - 1, 0), true);
}

function _moveToNextWorkspace() {
	const window = global.display.focus_window;
	const activeWsIdx = global.workspace_manager.get_active_workspace_index();
	window.change_workspace_by_index(activeWsIdx + 1, true);
}

function _moveToTopMonitor() {
	const window = global.display.focus_window;
	window.move_to_monitor(global.display.get_monitor_neighbor_index(window.get_monitor(), Meta.DisplayDirection.UP));
}

function _moveToBottomMonitor() {
	const window = global.display.focus_window;
	window.move_to_monitor(global.display.get_monitor_neighbor_index(window.get_monitor(), Meta.DisplayDirection.DOWN));
}

function _moveToLeftMonitor() {
	const window = global.display.focus_window;
	window.move_to_monitor(global.display.get_monitor_neighbor_index(window.get_monitor(), Meta.DisplayDirection.LEFT));
}

function _moveToRightMonitor() {
	const window = global.display.focus_window;
	window.move_to_monitor(global.display.get_monitor_neighbor_index(window.get_monitor(), Meta.DisplayDirection.RIGHT));
}

function _toggleFullscreen() {
	const window = global.display.focus_window;
	window.is_fullscreen() ? window.unmake_fullscreen() : window.make_fullscreen();
}

function _toggleAlwaysOnTop() {
	const window = global.display.focus_window;
	window.is_above() ? window.unmake_above() : window.make_above();
}

function _tileLeft() {
	const window = global.display.focus_window;
	Util.toggleTileState(window, Util.getTileRectFor(MainExtension.TILING.LEFT, window.get_work_area_current_monitor()));
}

function _tileRight() {
	const window = global.display.focus_window;
	Util.toggleTileState(window, Util.getTileRectFor(MainExtension.TILING.RIGHT, window.get_work_area_current_monitor()));
}

function _tileTop() {
	const window = global.display.focus_window;
	Util.toggleTileState(window, Util.getTileRectFor(MainExtension.TILING.TOP, window.get_work_area_current_monitor()));
}

function _tileBottom() {
	const window = global.display.focus_window;
	Util.toggleTileState(window, Util.getTileRectFor(MainExtension.TILING.BOTTOM, window.get_work_area_current_monitor()));
}

function _tileTopLeft() {
	const window = global.display.focus_window;
	Util.toggleTileState(window, Util.getTileRectFor(MainExtension.TILING.TOP_LEFT, window.get_work_area_current_monitor()));
}

function _tileTopRight() {
	const window = global.display.focus_window;
	Util.toggleTileState(window, Util.getTileRectFor(MainExtension.TILING.TOP_RIGHT, window.get_work_area_current_monitor()));
}

function _tileBottomLeft() {
	const window = global.display.focus_window;
	Util.toggleTileState(window, Util.getTileRectFor(MainExtension.TILING.BOTTOM_LEFT, window.get_work_area_current_monitor()));
}

function _tileBottomRight() {
	const window = global.display.focus_window;
	Util.toggleTileState(window, Util.getTileRectFor(MainExtension.TILING.BOTTOM_RIGHT, window.get_work_area_current_monitor()));
}
