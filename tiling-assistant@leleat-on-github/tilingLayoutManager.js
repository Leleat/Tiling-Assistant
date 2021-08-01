"use strict";

const {main} = imports.ui;
const {Clutter, Gio, GLib, GObject, Meta, Shell, St} = imports.gi;
const ByteArray = imports.byteArray;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const MainExtension = Me.imports.extension;
const Util = Me.imports.tilingUtil;
const TilingPopup = Me.imports.tilingPopup;

const Gettext = imports.gettext;
const Domain = Gettext.domain(Me.metadata.uuid);
const _ = Domain.gettext;

var LayoutManager = class TilingLayoutManager {
	constructor() {
		this._layoutRects = [];
		this._layoutAppIds = [];
		this._layoutLoopModes = [];

		this._currTileRect = null;
		this._currAppId = "";
		this._currLoopMode = "";

		this._cachedOpenWindows = [];
		this._tiledViaLayout = [];
		this._tiledViaLoop = [];
		this._layoutRectPreview = null;
	}

	destroy() {
		this._finishTilingToLayout();
	}

	// start a layout via keybinding from extension.js.
	// a layout is an object with a name, an array of rectangles, an array of appIds and loopModes.
	// the rectangle's properties *should* range from 0 to 1 (relative scale to monitor).
	// but may not... prefs.js only ensures that the layout has the proper format but not
	// wether the numbers are in the correct range of if the rects overlap each other
	// (this is so the user can still fix mistakes without having to start from scratch)
	////////////////
	// there are 3 "modes": default, app attachment, looped
	// default: tiling popup will ask, which window to tile in the rect; go to next rect
	// app attachment: automatically open the attached app in the rect; go to next rect
	// looped: evenly tile as many windows in the *current* rect as possible
	// until user aborts or there aren't any open windows left
	startTilingToLayout(layoutIndex) {
		const openWindows = Util.getOpenWindows(MainExtension.settings.get_boolean("tiling-popup-current-workspace-only"));
		const layouts = this._getLayouts();
		const layout = layouts[layoutIndex];
		if (!this._layoutIsValid(layout)) {
			this._finishTilingToLayout();
			main.notify("Tiling Assistant", _(`Layout ${layoutIndex + 1} is not valid.`));
			return;
		}

		this._layoutRects = layout.rects;
		this._layoutAppIds = layout.apps;
		this._layoutLoopModes = layout.loopModes;
		this._cachedOpenWindows = openWindows;

		this._tileNextRect();
	}

	_finishTilingToLayout() {
		this._layoutRects = [];
		this._layoutAppIds = [];
		this._layoutLoopModes = [];

		this._currTileRect = null;
		this._currAppId = "";
		this._currLoopMode = "";

		this._cachedOpenWindows = [];
		this._tiledViaLayout = [];
		this._tiledViaLoop = [];
		this._layoutRectPreview && this._layoutRectPreview.destroy();
		this._layoutRectPreview = null;
	}

	_getLayouts() {
		const path = GLib.build_filenamev([GLib.get_user_config_dir(), "/tiling-assistant/layouts.json"]);
		const file = Gio.File.new_for_path(path);
		if (!file.query_exists(null))
			return null;

		try {file.create(Gio.FileCreateFlags.NONE, null)} catch (e) {}
		const [success, contents] = file.load_contents(null);
		if (success && contents.length) {
			const allLayouts = JSON.parse(ByteArray.toString(contents));
			if (allLayouts.length)
				return allLayouts;
		}

		return null;
	}

	// basically copied from prefs.js
	_layoutIsValid(layout) {
		if (!layout)
			return false;

		// calculate the surface area of an overlap
		const rectsOverlap = function(r1, r2) {
			return Math.max(0, Math.min(r1.x + r1.width, r2.x + r2.width) - Math.max(r1.x, r2.x))
					* Math.max(0, Math.min(r1.y + r1.height, r2.y + r2.height) - Math.max(r1.y, r2.y));
		}

		for (let i = 0; i < layout.rects.length; i++) {
			const rect = layout.rects[i];
			// rects is/reaches outside of screen (i. entry. > 1)
			if (rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0 || rect.x + rect.width > 1 || rect.y + rect.height > 1)
				return false;

			for (let j = i + 1; j < layout.rects.length; j++) {
				if (rectsOverlap(rect, layout.rects[j]))
					return false;
			}
		}

		return true;
	}

	_tileNextRect(loopCurrTileRect = false) {
		if (!this._layoutRects.length && !loopCurrTileRect) {
			this._finishTilingToLayout();
			return;
		}

		if (!loopCurrTileRect)
			this._startNextStep();

		// automatically open an app in the rectangle spot
		if (this._currAppId) {
			const app = Shell.AppSystem.get_default().lookup_app(this._currAppId);
			if (!app) {
				main.notify("Tiling Assistant", _("Layouts: App not found."));
				this._finishTilingToLayout();
				return;

			} else if (app.can_open_new_window()) {
				Util.openAppTiled(app, this._currTileRect);

			} else {
				const winTracker = Shell.WindowTracker.get_default();
				const window = this._cachedOpenWindows.find(w => app === winTracker.get_window_app(w));
				window && Util.tileWindow(window, this._currTileRect, false, true);
			}

			this._tileNextRect();

		// tiling popup to ask what window to tile to the rectangle spot
		} else {
			if (!this._cachedOpenWindows.length) {
				this._tileNextRect();
				return;
			}

			this._createTilingPreview(this._currTileRect);

			const tilingPopup = new TilingPopup.TilingSwitcherPopup(this._cachedOpenWindows, this._currTileRect, !this._layoutRects.length && !this._currLoopMode);
			const tileGroupByStacking = global.display.sort_windows_by_stacking(this._tiledViaLayout).reverse();
			if (!tilingPopup.show(tileGroupByStacking)) {
				tilingPopup.destroy();
				this._finishTilingToLayout();
			}

			tilingPopup.connect("tiling-finished", this._onTiledWithTilingPopup.bind(this));
		}
	}

	_startNextStep() {
		const activeWs = global.workspace_manager.get_active_workspace();
		const workArea = activeWs.get_work_area_for_monitor(global.display.get_current_monitor());
		const rectRatios = this._layoutRects.shift();

		this._currTileRect = new Meta.Rectangle({
			x: workArea.x + Math.floor(rectRatios.x * workArea.width),
			y: workArea.y + Math.floor(rectRatios.y * workArea.height),
			width: Math.floor(rectRatios.width * workArea.width),
			height: Math.floor(rectRatios.height * workArea.height)
		});
		this._currAppId = this._layoutAppIds && this._layoutAppIds.shift();
		this._currLoopMode = this._layoutLoopModes && this._layoutLoopModes.shift();
	}

	_createTilingPreview(rect) {
		this._layoutRectPreview && this._layoutRectPreview.destroy();
		this._layoutRectPreview = new St.Widget({
			style_class: "tile-preview",
			x: rect.x + rect.width / 2, y: rect.y + rect.height / 2
		});
		main.layoutManager.addChrome(this._layoutRectPreview);

		this._layoutRectPreview.ease({
			x: rect.x, y: rect.y,
			width: rect.width, height: rect.height,
			duration: 200,
			mode: Clutter.AnimationMode.EASE_OUT_QUAD
		});
	}

	_onTiledWithTilingPopup(tilingPopup, popupCanceled) {
		if (popupCanceled) {
			if (this._currLoopMode) {
				this._tiledViaLoop = [];
				this._tileNextRect();
			} else {
				this._finishTilingToLayout();
			}

		} else {
			const {tiledWindow} = tilingPopup;
			this._tiledViaLayout.push(tiledWindow);
			this._cachedOpenWindows.splice(this._cachedOpenWindows.indexOf(tiledWindow), 1);

			// split the 'looped' tiled windows evenly in this._currTileRect
			if (this._currLoopMode) {
				this._tiledViaLoop.push(tiledWindow);
				this._tiledViaLoop.forEach((w, index) => {
					const rect = this._currTileRect.copy();
					const [pos, dimension] = this._currLoopMode === "h" ? ["y", "height"] : ["x", "width"];
					rect[dimension] = rect[dimension] / this._tiledViaLoop.length;
					rect[pos] = rect[pos] + index * rect[dimension];
					Util.tileWindow(w, rect, false, true);
				});
			}

			this._tileNextRect(this._currLoopMode);
		}
	}

	openLayoutSelector() {
		const layouts = this._getLayouts();
		if (!layouts) {
			main.notify("Tiling Assistant", _("No valid layouts defined."));
			return;
		}

		const layoutSelector = new LayoutSelector(layouts.map(layout => {
			layout.isValid = this._layoutIsValid(layout);
			return layout;
		}));
		layoutSelector.connect("item-activated", (selector, index) => this.startTilingToLayout(index));
	}
}

const LayoutSelector = GObject.registerClass({
	Signals: {
		"item-activated": {param_types: [GObject.TYPE_INT]}
	}
}, class LayoutSelector extends St.BoxLayout {
		_init(layouts) {
			super._init({
				width: 500,
				vertical: true,
				style_class: "osd-window",
			});
			main.uiGroup.add_child(this);

			this._items = [];
			this._focusedIdx = -1;
			const fontSize = 18;

			const entry = new St.Entry({
				style: `font-size: ${fontSize}px`,
				hint_text: _(" Type to search...")
			});
			this.add_child(entry);

			const activeWs = global.workspace_manager.get_active_workspace();
			const workArea = activeWs.get_work_area_for_monitor(global.display.get_current_monitor());
			this.set_position(workArea.x + workArea.width / 2 - this.width / 2, workArea.y + workArea.height / 2 - this.height / 2);

			layouts.forEach(layout => this._items.push(this._createMenuItem(layout, fontSize)));
			if (!this._items.length) {
				this.destroy();
				return;
			}

			if (!main.pushModal(this)) {
				// Probably someone else has a pointer grab, try again with keyboard only
				if (!main.pushModal(this, {options: Meta.ModalOptions.POINTER_ALREADY_GRABBED})) {
					this.destroy();
					return;
				}
			}

			this._haveModal = true;
			this._focus(0);
			entry.grab_key_focus();

			const entryClutterText = entry.get_clutter_text();
			entryClutterText.connect("key-press-event", this._onKeyPressed.bind(this));
			entryClutterText.connect("text-changed", this._onTextChanged.bind(this));
		}

		destroy() {
			if (this._haveModal) {
				main.popModal(this);
				this._haveModal = false;
			}

			super.destroy();
		}

		_createMenuItem(layout, fontSize) {
			if (!layout.isValid)
				return;

			const menuItem = new SelectorMenuItem(layout.name, fontSize);
			menuItem.connect("button-press-event", this._onMenuItemClicked.bind(this));
			this.add_child(menuItem);
			return menuItem;
		}

		_onKeyPressed(textActor, event) {
			const keySym = event.get_key_symbol();
			if (keySym === Clutter.KEY_Escape) {
				this.destroy();
				return Clutter.EVENT_STOP;

			} else if (keySym === Clutter.KEY_Return || keySym === Clutter.KEY_KP_Enter || keySym === Clutter.KEY_ISO_Enter) {
				this._activateLayout();
				return Clutter.EVENT_STOP;

			} else if (keySym == Clutter.KEY_Down) {
				this._focusNext();
				return Clutter.EVENT_STOP;

			} else if (keySym === Clutter.KEY_Up) {
				this._focusPrev();
				return Clutter.EVENT_STOP;
			}

			return Clutter.EVENT_PROPAGATE;
		}

		_onTextChanged(textActor) {
			const filterText = textActor.get_text();
			this._items.forEach(item => item.text.toLowerCase().includes(filterText.toLowerCase()) ? item.show() : item.hide());
			this._focus(this._items.findIndex(item => item.visible));
		}

		_onMenuItemClicked(menuItem, event) {
			this._focusedIdx = this.get_children().indexOf(menuItem) - 1;
			this._activateLayout();
		}

		_focusPrev() {
			this._focus((this._focusedIdx === 0 ? this._items.length : this._focusedIdx) - 1);
		}

		_focusNext() {
			this._focus((this._focusedIdx + 1) % this._items.length);
		}

		_focus(newIdx) {
			const prevItem = this._items[this._focusedIdx];
			const newItem = this._items[newIdx];
			this._focusedIdx = newIdx;

			prevItem && prevItem.remove_style_class_name("layout-selector-highlight");
			newItem && newItem.add_style_class_name("layout-selector-highlight");
		}

		_activateLayout() {
			this._focusedIdx !== -1 && this.emit("item-activated", this._focusedIdx);
			this.destroy();
		}
	}
)

const SelectorMenuItem = GObject.registerClass(class SelectorMenuItem extends St.Label {
	_init(text, fontSize) {
		super._init({
			text: text || _("No layout name..."),
			style: `font-size: ${fontSize}px;\
					text-align: left;\
					padding: 8px`,
			reactive: true
		});
	}
})
