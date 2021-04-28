"use strict";

const {main} = imports.ui;
const {Clutter, Gio, GLib, GObject, Meta, Shell, St} = imports.gi;
const ByteArray = imports.byteArray;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const MainExtension = Me.imports.extension;
const Util = Me.imports.tilingUtil;
const TilingPopup = Me.imports.tilingPopup;

var LayoutManager = class TilingLayoutManager {
	constructor() {
		this.currentLayout = {};
		this.cachedOpenWindows = [];
		this.tiledViaLayout = [];
		this.layoutRectPreview = null;
	}

	destroy() {
		this._finishTilingToLayout();
	}

	// start a layout via keybinding from extension.js.
	// a layout is an object with a name, an array of rectangles, and an array of appIds.
	// the rectangle's properties *should* range from 0 to 1 (relative scale to monitor).
	// but may not... prefs.js only ensures that the layout has the proper format but not
	// wether the numbers are in the correct range of if the rects overlap each other
	// (this is so the user can still fix mistakes without having to start from scratch)
	startTilingToLayout(layoutIndex) {
		const openWindows = Util.getOpenWindows(MainExtension.settings.get_boolean("tiling-popup-current-workspace-only"));
		const layouts = this._getLayouts();
		const layout = layouts[layoutIndex];
		if (!this._layoutIsValid(layout)) {
			this._finishTilingToLayout();
			main.notify("Tiling Assistant", `Layout ${layoutIndex + 1} is not valid.`);
			return;
		}

		this.currentLayoutRects = layout.rects;
		this.currentLayoutAppIds = layout.apps;
		this.cachedOpenWindows = openWindows;

		this._tileNextRect();
	}

	_finishTilingToLayout() {
		this.currentLayout = {};
		this.cachedOpenWindows = [];
		this.tiledViaLayout = [];
		this.layoutRectPreview && this.layoutRectPreview.destroy();
		this.layoutRectPreview = null;
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

	_tileNextRect() {
		if (!this.currentLayoutRects.length) {
			this._finishTilingToLayout();
			return;
		}

		const rect = this.currentLayoutRects.shift();
		const appId = this.currentLayoutAppIds && this.currentLayoutAppIds.shift();
		const activeWs = global.workspace_manager.get_active_workspace();
		const workArea = activeWs.get_work_area_for_monitor(global.display.get_current_monitor());
		const winTracker = Shell.WindowTracker.get_default();
		const tileRect = new Meta.Rectangle({
			x: workArea.x + Math.floor(rect.x * workArea.width),
			y: workArea.y + Math.floor(rect.y * workArea.height),
			width: Math.floor(rect.width * workArea.width),
			height: Math.floor(rect.height * workArea.height)
		});

		// automatically open an app in the rectangle spot
		if (appId) {
			const app = Shell.AppSystem.get_default().lookup_app(appId);
			if (!app) {
				main.notify("Tiling Assistant", "Layouts: App not found.");
				this._finishTilingToLayout();
				return;
			} else if (app.can_open_new_window()) {
				Util.openAppTiled(app, tileRect);
			} else {
				const window = this.cachedOpenWindows.find(w => app === winTracker.get_window_app(w));
				window && Util.tileWindow(window, tileRect, false, true);
			}

			this._tileNextRect();

		// tiling popup to ask what window to tile to the rectangle spot
		} else {
			if (!this.cachedOpenWindows.length) {
				this._tileNextRect();
				return;
			}

			this._createTilingPreview(tileRect);

			const tilingPopup = new TilingPopup.TilingSwitcherPopup(this.cachedOpenWindows, tileRect, !this.currentLayoutRects.length);
			const tileGroupByStacking = global.display.sort_windows_by_stacking(this.tiledViaLayout).reverse();
			if (!tilingPopup.show(tileGroupByStacking)) {
				tilingPopup.destroy();
				this._finishTilingToLayout();
			}

			tilingPopup.connect("tiling-finished", this._onTiledWithTilingPopup.bind(this));
		}
	}

	_createTilingPreview(rect) {
		this.layoutRectPreview && this.layoutRectPreview.destroy();
		this.layoutRectPreview = new St.Widget({
			style_class: "tile-preview",
			x: rect.x + rect.width / 2, y: rect.y + rect.height / 2
		});
		main.layoutManager.addChrome(this.layoutRectPreview);

		this.layoutRectPreview.ease({
			x: rect.x, y: rect.y,
			width: rect.width, height: rect.height,
			duration: 200,
			mode: Clutter.AnimationMode.EASE_OUT_QUAD
		});
	}

	_onTiledWithTilingPopup(tilingPopup, tilingCanceled) {
		if (tilingCanceled) {
			this._finishTilingToLayout();
			return;
		}

		const {tiledWindow} = tilingPopup;
		this.tiledViaLayout.push(tiledWindow);
		this.cachedOpenWindows.splice(this.cachedOpenWindows.indexOf(tiledWindow), 1);
		this._tileNextRect();
	}

	openLayoutSelector() {
		const layouts = this._getLayouts();
		if (!layouts) {
			main.notify("Tiling Assistant", "No valid layouts defined.");
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
				style_class: "osd-window"
			});
			main.uiGroup.add_child(this);

			this._items = [];
			this._focusedIdx = -1;
			const fontSize = 18;

			const entry = new St.Entry({
				style: `font-size: ${fontSize}px`,
				hint_text: " Type to search..."
			});
			this.add_child(entry);
			entry.grab_key_focus();

			const entryClutterText = entry.get_clutter_text();
			entryClutterText.connect("key-focus-out", () => this.destroy());
			entryClutterText.connect("key-press-event", this._onKeyPressed.bind(this));
			entryClutterText.connect("text-changed", this._onTextChanged.bind(this));

			const activeWs = global.workspace_manager.get_active_workspace();
			const workArea = activeWs.get_work_area_for_monitor(global.display.get_current_monitor());
			this.set_position(workArea.width / 2 - this.width / 2, workArea.height / 2 - this.height / 2);

			layouts.forEach(layout => this._items.push(this._createMenuItem(layout, fontSize)));
			if (!this._items.length) {
				this.destroy();
				return;
			}

			this._focus(0);
		}

		destroy() {
			// destroy may be called when activating a layout and when losing focus
			if (this.alreadyDestroyed)
				return;

			this.alreadyDestroyed = true;
			super.destroy();
		}

		_createMenuItem(layout, fontSize) {
			if (!layout.isValid)
				return;

			const menuItem = new SelectorMenuItem(layout.name, fontSize);
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
			this._items.forEach(item => item.text.includes(filterText) ? item.show() : item.hide());
			this._focus(this._items.findIndex(item => item.visible));
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
			text: text || "No name...",
			style: `font-size: ${fontSize}px;\
					text-align: left;\
					padding: 8px`,
		});
	}
})
