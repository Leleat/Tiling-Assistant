"use strict";

const {main} = imports.ui;
const {Clutter, Gio, GLib, GObject, Meta, Shell, St} = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const TilingDash = Me.imports.tilingDash;
const Util = Me.imports.util;

var MyTilingLayoutManager = GObject.registerClass(
	class MyTilingLayoutManager extends GObject.Object {
		_init() {
			this.currentLayout = []; // array of objects: {x: F, y: F, width: F, height: F} where F is a float between 0 and 1
			this.layoutRectPreview = null; // preview for the current rect of the currentLayout
			this.cachedOpenWindows = []; // the open windows, which havent been tiled with the current layout yet
			this.monitorNr = 0;
			this.isTilingViaLayout = false;
		}

		_destroy() {
			this.endTilingViaLayout();
		}

		// called via keybinding of the respective layout
		// opens appDash to tile apps in a layout
		startTilingToLayout(layoutIdx) {
			const openWindows = Util.getOpenWindows();
			if (!openWindows.length)
				return;

			const [rectLayout, ] = this.getLayout(layoutIdx, false);
			if (!rectLayout || !rectLayout.length || !this.layoutIsValid(rectLayout))
				return;

			this.isTilingViaLayout = true;
			this.cachedOpenWindows = openWindows;
			this.monitorNr = openWindows[0].get_monitor();
			this.currentLayout = [];

			// turn rect objects (gotten from .json) into Meta.Rectangles
			// and scale rects to workArea size
			const workArea = this.cachedOpenWindows[0].get_work_area_current_monitor();
			rectLayout.forEach(r => {
				this.currentLayout.push(new Meta.Rectangle({
					x: workArea.x + r.x * workArea.width,
					y: workArea.y + r.y * workArea.height,
					width: r.width * workArea.width,
					height: r.height * workArea.height,
				}));
			});

			const currentLayoutRect = this.currentLayout.shift();
			this.createTilingPreview(currentLayoutRect);
			TilingDash.openDash(this.cachedOpenWindows, null, this.monitorNr, currentLayoutRect);
		}

		// called via keybinding of the respective layout (last few layouts)
		// automatically opens a predefined list of apps in a layout
		openAppsInLayout(layoutIdx) {
			const [rectLayout, appList] = this.getLayout(layoutIdx, true);
			if (!rectLayout || !rectLayout.length || !this.layoutIsValid(rectLayout))
				return;

			this.currentLayout = [];

			// turn rect objects (gotten from .json) into Meta.Rectangles
			// and scale rects to workArea size
			const workArea = global.workspace_manager.get_active_workspace().get_work_area_for_monitor(global.display.get_current_monitor());
			rectLayout.forEach(r => {
				this.currentLayout.push(new Meta.Rectangle({
					x: workArea.x + r.x * workArea.width,
					y: workArea.y + r.y * workArea.height,
					width: r.width * workArea.width,
					height: r.height * workArea.height,
				}));
			});

			const currentLayoutRect = this.currentLayout.shift();
			Util.openAppTiled(appList.shift(), currentLayoutRect, appList, this.currentLayout);
		}

		// called after a window was tiled with an appIcon from tilingDash.js
		onWindowTiled(tiledWindow) {
			if (!this.isTilingViaLayout)
				return;

			// finish after final layout rect
			if (!this.currentLayout.length) {
				this.endTilingViaLayout();
				return;
			}

			// remove tiledWindow from the cachedOpenWindows
			this.cachedOpenWindows.splice(this.cachedOpenWindows.indexOf(tiledWindow), 1);
			if (!this.cachedOpenWindows.length) {
				this.endTilingViaLayout();
				return;
			}

			const currentLayoutRect = this.currentLayout.shift();
			this.createTilingPreview(currentLayoutRect);

			TilingDash.openDash(this.cachedOpenWindows, tiledWindow, this.monitorNr, currentLayoutRect);
		}

		endTilingViaLayout() {
			this.isTilingViaLayout = false;
			this.currentLayout = [];
			this.cachedOpenWindows = [];
			this.monitorNr = 0;
			if (this.layoutRectPreview) {
				this.layoutRectPreview.destroy();
				this.layoutRectPreview = null;
			}
		}

		createTilingPreview(rect) {
			if (this.layoutRectPreview)
				this.layoutRectPreview.destroy();

			this.layoutRectPreview = new St.Widget({
				style_class: "tile-preview",
				x: rect.x + rect.width / 2,
				y: rect.y + rect.height / 2,
			});
			main.layoutManager.addChrome(this.layoutRectPreview);

			this.layoutRectPreview.ease({
				x: rect.x,
				y: rect.y,
				width: rect.width,
				height: rect.height,
				duration: 200,
				mode: Clutter.AnimationMode.EASE_OUT_QUAD,
			});
		}

		getLayout(idx, tileWithAppList) {
			const path = GLib.build_filenamev([GLib.get_home_dir(), ".TilingAssistantExtension.layouts.json"]);
			const layoutFile = Gio.File.new_for_path(path);

			try {
				layoutFile.create(Gio.FileCreateFlags.NONE, null);
			} catch (e) {

			}

			const [success, contents] = layoutFile.load_contents(null);
			if (success) {
				const layouts = JSON.parse(contents);
				GLib.free(contents);

				const appSystem = Shell.AppSystem.get_default();
				const rectLayout = (tileWithAppList) ? layouts[idx].map(element => element[0]) : layouts[idx];
				const appList = (tileWithAppList) ? layouts[idx].map(element => {
					const desktopAppInfo = appSystem.get_installed().find(appInfo => appInfo.get_name() === element[1]);
					return appSystem.lookup_app(desktopAppInfo.get_id());
				}) : null;

				if (layouts.length && idx < layouts.length)
					return [rectLayout, appList];
			}

			return [];
		}

		layoutIsValid(layout) {
			// calculate the surface area of an overlap
			// 0 means no overlap
			const rectsOverlap = (r1, r2) => Math.max(0, Math.min(r1.x + r1.width, r2.x + r2.width) - Math.max(r1.x, r2.x))
					* Math.max(0, Math.min(r1.y + r1.height, r2.y + r2.height) - Math.max(r1.y, r2.y));

			for (let i = 0, len = layout.length; i < len; i++) {
				const r = layout[i];

				// a rect is/reaches outside of screen (i. e. > 1)
				if (r.x < 0 || r.y < 0 || r.width <= 0 || r.height <= 0 || r.x + r.width > 1 || r.y + r.height > 1)
					return false;

				for (let j = i + 1; j < len; j++) {
					if (rectsOverlap(r, layout[j]))
						return false;
				}
			}

			return true;
		}
	}
)