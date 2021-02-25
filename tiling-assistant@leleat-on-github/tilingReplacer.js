"use strict";

const {main} = imports.ui;
const {Clutter, GObject, Meta, St} = imports.gi;

const Me = imports.misc.extensionUtils.getCurrentExtension();
const Util = Me.imports.util;
const MODE = {
	FULL: 1,
	VERTICAL: 2,
	HORIZONTAL: 4,
}

function replaceTiledWindow() {
	const window = global.display.focus_window;
	if (!window)
		return;

	new MyTilingReplacer(window);
};

// class to replace a tiledWindow via the keybinding "tile to other tiled window"
const MyTilingReplacer = GObject.registerClass(
	class MyTilingReplacer extends St.Widget {
		_init(window) {
			const activeWS = global.workspace_manager.get_active_workspace();
			const entireWorkArea = activeWS.get_work_area_all_monitors();

			super._init({
				reactive: true,
				x: entireWorkArea.x,
				y: entireWorkArea.y - main.panel.height,
				width: entireWorkArea.width,
				height: entireWorkArea.height + main.panel.height
			});

			main.uiGroup.add_child(this);

			global.stage.set_key_focus(this);

			this.window = window;
			this.previewRects = [];
			this.rects = [];
			this.currMode = MODE.FULL;
			this.labelText = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "f", "d", "s", "a", "w", "e", "r", "h", "z", "j", "k", "l", "u", "i", "o"];

			this.shadeBackground(entireWorkArea);
			this.createRectPreviews();
		}

		destroy() {
			this.previewRects.forEach(r => r.destroy());
			this.shadeBG.destroy();
			super.destroy();
		}

		shadeBackground(entireWorkArea) {
			this.shadeBG = new St.Widget({
				style: ("background-color : black"),
				opacity: 0,
				x: entireWorkArea.x,
				y: entireWorkArea.y,
				width: entireWorkArea.width,
				height: entireWorkArea.height
			});
			global.window_group.add_child(this.shadeBG);

			this.shadeBG.ease({
				opacity: 175,
				duration: 200,
				mode: Clutter.AnimationMode.EASE_OUT_QUAD,
			});
		}

		createRectPreviews() {
			this.previewRects.forEach(r => r.destroy());
			this.previewRects = [];
			this.setPreviewRects()
			// no tiled windows below it; so only full display as rect
			if (this.rects.length <= 1) {
				this.destroy();
				return;
			}

			for (let i = 0; i < Math.min(this.labelText.length, this.rects.length); i++) {
				const rect = this.rects[i];
				// for visibility: preview is slightly smaller than the rect
				const previewRect = new St.Widget({
					style_class: "tile-preview",
					x: rect.x + 10,
					y: rect.y + 10,
					width: rect.width - 2 * 10,
					height: rect.height - 2 * 10,
					opacity: 0,
				});
				global.window_group.add_child(previewRect);
				this.previewRects.push(previewRect);

				previewRect.ease({
					opacity: 255,
					duration: 200,
					mode: Clutter.AnimationMode.EASE_OUT_QUAD
				});

				const label = new St.Label({
					x: rect.x + rect.width / 2,
					y: rect.y + rect.height / 2,
					text: this.labelText[i],
					style: "font-size: 50px"
				});
				global.window_group.add_child(label);
				this.previewRects.push(label);
			}
		}

		setPreviewRects() {
			const openWindows = Util.getOpenWindows();
			const currTileGroup = Util.getTopTileGroup(openWindows, (openWindows[0].isTiled) ? false : true);
			const freeScreenRects = Util.getFreeScreenRects(currTileGroup);
			const windowCount = currTileGroup.length;
			this.rects = currTileGroup.map(w => w.tiledRect.copy()).concat(freeScreenRects);
			let tmpRects = [];

			switch (this.currMode) {
				case MODE.FULL:
					tmpRects = this.rects;
					break;

				// split rects vertically
				case MODE.VERTICAL:
					for (let i = 0; i < this.rects.length; i++) {
						const r = this.rects[i];
						const r1 = new Meta.Rectangle({
							x: r.x,
							y: r.y,
							width: r.width,
							height: r.height / 2,
						});
						tmpRects.push(r1);

						const r2 = new Meta.Rectangle({
							x: r.x,
							y: r.y + r.height / 2,
							width: r.width,
							height: r.height / 2,
						});
						tmpRects.push(r2);

						if (i < windowCount) {
							r1.window = currTileGroup[i];
							r2.window = currTileGroup[i];
						}
					}

					break;

				// split rects horizontally
				case MODE.HORIZONTAL:
					for (let i = 0; i < this.rects.length; i++) {
						const r = this.rects[i];
						const r1 = new Meta.Rectangle({
							x: r.x,
							y: r.y,
							width: r.width / 2,
							height: r.height,
						});
						tmpRects.push(r1);

						const r2 = new Meta.Rectangle({
							x: r.x + r.width / 2,
							y: r.y,
							width: r.width / 2,
							height: r.height,
						});
						tmpRects.push(r2);

						if (i < windowCount) {
							r1.window = currTileGroup[i];
							r2.window = currTileGroup[i];
						}
					}

					break;
			}

			// sort left -> right and top -> bottom
			this.rects = tmpRects.sort((r1, r2) => {
				const xPos = r1.x - r2.x;
				if (xPos)
					return xPos;

				return r1.y - r2.y;
			});
		}

		vfunc_button_press_event(buttonEvent) {
			for (const rect of this.rects) {
				if (!Util.rectHasPoint(rect, buttonEvent))
					continue;

				if (rect.window && rect.window !== this.window) // halve old window
					Util.tileWindow(rect.window, Util.rectDiff(rect.window.tiledRect, rect)[0], false);

				Util.tileWindow(this.window, rect);
				break;
			}

			this.destroy();
		}

		vfunc_key_press_event(keyEvent) {
			if (keyEvent.keyval ===  65507 || keyEvent.keyval === 65508) { // left and right ctrl
				if (this.currMode === MODE.FULL)
					this.currMode = MODE.VERTICAL;
				else if (this.currMode === MODE.VERTICAL)
					this.currMode = MODE.HORIZONTAL;
				else
					this.currMode = MODE.FULL;

				this.createRectPreviews();

			} else {
				const idx = this.labelText.indexOf(keyEvent.unicode_value);
				if (idx !== -1 && idx < this.rects.length) {
					const rect = this.rects[idx];
					if (rect.window && rect.window !== this.window) // halve old window
						Util.tileWindow(rect.window, Util.rectDiff(rect.window.tiledRect, rect)[0], false);

					Util.tileWindow(this.window, rect);
				}

				this.destroy();
			}
		}
	}
)