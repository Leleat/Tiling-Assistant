const {main} = imports.ui;
const {Clutter, GObject, Meta, St} = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const MainExtension = Me.imports.extension;
const Util = Me.imports.tilingUtil;

var TileEditor = GObject.registerClass(
	class TiledWindowEditor extends St.Widget {
		_init() {
			super._init();
			this.currMode = null;
			this._haveModal = false;
		}

		open() {
			if (!main.pushModal(this)) {
				// Probably someone else has a pointer grab, try again with keyboard only
				if (!main.pushModal(this, {options: Meta.ModalOptions.POINTER_ALREADY_GRABBED})) {
					this.destroy();
					return;
				}
			}

			this._haveModal = true;
			this.currMode = new SelectMode(this);
		}

		close(changesCanceled = false) {
			if (changesCanceled) {

			}

			if (this._haveModal) {
				main.popModal(this);
				this._haveModal = false;
			}

			this.currMode.destroy();
			this.destroy();
		}

		_switchModes(mode) {
			this.currMode.destroy();
			this.currMode = new mode(this);
		}

		vfunc_key_press_event(keyEvent) {
			this.close();
		}

		vfunc_button_press_event(buttonEvent) {
			this.close();
		}
	}
);

// select a window to perform operations with
const SelectMode = GObject.registerClass(
	class SelectMode extends St.Widget {
		_init(tileEditor) {
			super._init();
			this.tileEditor = tileEditor;
		}

		destroy() {
			super.destroy();
		}
	}
);

const EditMode = GObject.registerClass(
	class EditMode extends St.Widget {
		_init() {
			super._init();
			this.tileEditor = tileEditor;
		}

		destroy() {
			super.destroy();
		}
	}
);