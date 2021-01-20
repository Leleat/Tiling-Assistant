const {altTab, main} = imports.ui;
const {Clutter, Gio, GLib, GObject, Meta, Shell, St} = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const MyExtension = Me.imports.extension;

var MyTilingLayoutManager = GObject.registerClass(
	class MyTilingLayoutManager extends GObject.Object {
		_init() {
			this.currentLayout = [];
			this.layoutRectPreview = null;
			this.cachedOpenWindows = [];
			this.monitorNr = 0;
		}

		_destroy() {
			this.endTilingViaLayout();
		}

		// called via keybinding of the respective layout
		tileToLayout(layoutIdx, monitorNr) {
			let openWindows = altTab.getWindows(global.workspace_manager.get_active_workspace());
			if (!openWindows.length)
				return;
			
			let layout = this._getLayout(layoutIdx);
			if (!layout || !layout.length || !this._layoutIsValid(layout))
				return;
				
			this.cachedOpenWindows = openWindows;
			this.monitorNr = monitorNr;

			// turn rect objects (gotten from .json) into Meta.Rectangles
			// and scale rects to workArea size
			let workArea = this.cachedOpenWindows[0].get_work_area_current_monitor();
			layout.forEach(r => {
				this.currentLayout.push(new Meta.Rectangle({
					x: workArea.x + r.x * workArea.width,
					y: workArea.y + r.y * workArea.height,
					width: r.width * workArea.width,
					height: r.height * workArea.height,
				}));
			});

			let currentLayoutRect = this.currentLayout.shift();
			this._createTilingPreview(currentLayoutRect);
	
			MyExtension.appDash.open(this.cachedOpenWindows, null, this.monitorNr, currentLayoutRect, this.currentLayout);
		}

		// called after a window was tiled
		onWindowTiled(tiledWindow) {
            if (this.layoutRectPreview)
                this.layoutRectPreview.destroy();
                
			if (!this.isTilingViaLayout()) {
				this.endTilingViaLayout();
				return;
			}

			// remove tiledWindow from the cachedOpenWindows
			this.cachedOpenWindows.splice(this.cachedOpenWindows.indexOf(tiledWindow), 1);
			if (!this.cachedOpenWindows.length) {
				this.endTilingViaLayout();
				return;
			}

			let currentLayoutRect = this.currentLayout.shift();
			this._createTilingPreview(currentLayoutRect);

			MyExtension.appDash.open(this.cachedOpenWindows, tiledWindow, this.monitorNr, currentLayoutRect, this.currentLayout);
		}

		isTilingViaLayout() {
			return this.currentLayout.length > 0;
		}

		endTilingViaLayout() {
			this.currentLayout = [];
			this.cachedOpenWindows = [];
			this.monitorNr = 0;
			if (this.layoutRectPreview) {
				this.layoutRectPreview.destroy();
				this.layoutRectPreview = null;
			}
		}

		_createTilingPreview(rect) {
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

		_getLayout(idx) {
			let path = GLib.build_filenamev([GLib.get_home_dir(), ".TilingAssistantExtension.layouts.json"]);
			let layoutFile = Gio.File.new_for_path(path); // TODO need to free this?
	
			try {
				layoutFile.create(Gio.FileCreateFlags.NONE, null);
			} catch (e) {

			}
	
			let [success, contents] = layoutFile.load_contents(null);
			if (success) {
				let layouts = JSON.parse(contents);
				if (layouts.length && idx < layouts.length)
					return layouts[idx];
			}
	
			return null;
		}

		_layoutIsValid(layout) {
			// calculate the surface area of an overlap
			// 0 means no overlap
			let rectsOverlap = (r1, r2) => Math.max(0, Math.min(r1.x + r1.width, r2.x + r2.width) - Math.max(r1.x, r2.x)) 
					* Math.max(0, Math.min(r1.y + r1.height, r2.y + r2.height) - Math.max(r1.y, r2.y));
	
			for (let i = 0, len = layout.length; i < len; i++) {
				let r = layout[i];
	
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