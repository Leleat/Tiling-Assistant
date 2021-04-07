const {main} = imports.ui;
const {GObject, Meta, St} = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Util = Me.imports.tilingUtil;

const ACTIONS = {
	MAXIMIZE: "_toggleMaximize",
	MINIMIZE:  "_minimizeWindow",
	CLOSE: "_closeWindow",
	MOVE_PREV_WORKSPACE: "_moveToPrevWorkspace",
	MOVE_NEXT_WORKSPACE: "_moveToNextWorkspace",
};

var PieMenu = GObject.registerClass(
	class PieMenu extends St.Widget {
		_init(clickPos) {
			const workArea = global.display.focus_window.get_work_area_current_monitor();
			super._init({
				x: workArea.x, 
				y: workArea.y,
				width: workArea.width,
				height: workArea.height,
				reactive: true
			});
			main.uiGroup.add_child(this);

			this._clickPos = clickPos;

			const menu = new St.Label({ // TODO create labels
				text: "Hello World",
				style_class: "resize-popup",
				style: `font-size: ${18}px;\
						text-align: left;\
						padding: 8px`
			});
			this.add_child(menu);
			menu.set_position(clickPos[0], clickPos[1]);

			// TODO need modal to get all events
		}

		vfunc_motion_event(motionEvent) {
			log(motionEvent.x)
		}

		_activate() {
			// TODO get activated action
			this.destroy();
		}

		_toggleMaximize() {
			const window = global.display.focus_window;
			Util.toggleTileState(window, window.get_work_area_current_monitor());
		}

		_closeWindow() {
			global.display.focus_window.delete(global.get_current_time());
		}

		_minimizeWindow() {
			global.display.focus_window.minimize();
		}

		_moveToPrevWorkspace() {
			const window = global.display.focus_window;
			const activeWsIdx = global.workspace_manager.get_active_workspace_index();
			window.change_workspace_by_index(Math.max(activeWsIdx - 1, 0), true);
		}

		_moveToNextWorkspace() {
			const window = global.display.focus_window;
			const activeWsIdx = global.workspace_manager.get_active_workspace_index();
			window.change_workspace_by_index(activeWsIdx + 1, true);
		}
	}
)
