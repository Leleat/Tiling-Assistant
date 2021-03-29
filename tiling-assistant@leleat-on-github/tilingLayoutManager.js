"use strict";

const {main} = imports.ui;
const {Clutter, Gio, GLib, Meta, St} = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
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
	// a layout is an object with a name and an array of rectangles.
	// the rectangle's properties *should* range from 0 to 1 (relative scale to monitor).
	// but may not... prefs.js only ensures that the layout has the proper format but not
	// wether the numbers are in the correct range of if the rects overlap each other
	// (this is so the user can still fix mistakes without having to start from scratch) 
	startTilingToLayout(layoutIndex) {
		const openWindows = Util.getOpenWindows();
		if (!openWindows.length) {
			this._finishTilingToLayout();
			return;
		}

		const layout = this._getLayout(layoutIndex);
		if (!layout) {
			this._finishTilingToLayout();
			main.notify("Tiling Assistant", `Layout ${layoutIndex + 1} is not valid.`);
			return;
		}

		this.currentLayoutRects = layout.rects;
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

	_getLayout(layoutIndex) {
		// basically copied from prefs.js
		const layoutIsValid = function(layout) {
			if (!layout)
				return false;

			// calculate the surface area of an overlap
			const rectsOverlap = function(r1, r2) {
				return Math.max(0, Math.min(r1.x + r1.width, r2.x + r2.width) - Math.max(r1.x, r2.x))
						* Math.max(0, Math.min(r1.y + r1.height, r2.y + r2.height) - Math.max(r1.y, r2.y));
			}

			for (let i = 0; i < layout.rects.length; i++) {
				const rect = layout.rects[i];
				// rects is/reaches outside of screen (i. e. > 1)
				if (rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0 || rect.x + rect.width > 1 || rect.y + rect.height > 1)
					return false;

				for (let j = i + 1; j < layout.rects.length; j++) {
					if (rectsOverlap(rect, layout.rects[j]))
						return false;
				}
			}

			return true;
		}

		const path = GLib.build_filenamev([Me.dir.get_path(), ".layouts.json"]);
		const layoutFile = Gio.File.new_for_path(path);

		try {layoutFile.create(Gio.FileCreateFlags.NONE, null)} catch (e) {}
		const [success, contents] = layoutFile.load_contents(null);
		if (success && contents.length) {
			const allLayouts = JSON.parse(contents);
			if (allLayouts.length && layoutIndex < allLayouts.length)
				return layoutIsValid(allLayouts[layoutIndex]) ? allLayouts[layoutIndex] : null;
		}

		return null;
	}

	_tileNextRect() {
		const rect = this.currentLayoutRects.shift();
		const workArea = this.cachedOpenWindows[0].get_work_area_current_monitor();
		const tileRect = new Meta.Rectangle({
			x: workArea.x + Math.floor(rect.x * workArea.width),
			y: workArea.y + Math.floor(rect.y * workArea.height),
			width: Math.floor(rect.width * workArea.width),
			height: Math.floor(rect.height * workArea.height),
		});

		this._createTilingPreview(tileRect);

		const tilingPopup = new TilingPopup.TilingSwitcherPopup(this.cachedOpenWindows, tileRect, !this.currentLayoutRects.length);
		const tileGroupByStacking = global.display.sort_windows_by_stacking(this.tiledViaLayout).reverse();
		if (!tilingPopup.show(tileGroupByStacking)) {
			tilingPopup.destroy();
			this._finishTilingToLayout();
		}

		tilingPopup.connect("tiling-finished", this._onTilingFinished.bind(this));
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

	_onTilingFinished(tilingPopup, tilingCanceled) {
		if (tilingCanceled) {
			this._finishTilingToLayout();
			return;
		}

		const tiledWindow = tilingPopup.tiledWindow;
		this.tiledViaLayout.push(tiledWindow);
		this.cachedOpenWindows.splice(this.cachedOpenWindows.indexOf(tiledWindow), 1);
		this.currentLayoutRects.length && this.cachedOpenWindows.length ? this._tileNextRect() : this._finishTilingToLayout();
	}
}