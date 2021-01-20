const {main} = imports.ui;
const {Clutter, GObject, Meta, St} = imports.gi;

// this is the preview which is shown when DNDing to a screen edge/corner etc...
// mostly from windowManager.js except:
// show preview above all windows, because big windows may obscure small previews (e. g. quarter previews),
// save the tiledWindow (until closing the preview) to tile over another tiled window when holding Ctrl
var MyTilingPreviewRect = GObject.registerClass(
	class MyTilingPreviewRect extends St.Widget {
		_init() {
			super._init();
			main.uiGroup.add_child(this);

			this.reset();
			this.showing = false;
		}

		open(window, tileRect, monitorIndex, tiledWindow = null) {
			let windowActor = window.get_compositor_private();
			if (!windowActor)
				return;

			if (this.rect && this.rect.equal(tileRect))
				return;

			let changeMonitor = this.monitorIndex == -1 || this.monitorIndex != monitorIndex;
			this.monitorIndex = monitorIndex;
			this.rect = tileRect;
			this.tiledWindow = tiledWindow; // tiledWindow, which is being hovered while holding ctrl

			let monitor = main.layoutManager.monitors[monitorIndex];

			// update style class
			let styles = ["tile-preview"];
			if (this.monitorIndex == main.layoutManager.primaryIndex)
				styles.push("on-primary");
			if (this.rect.x == monitor.x)
				styles.push("tile-preview-left");
			if (this.rect.x + this.rect.width == monitor.x + monitor.width)
				styles.push("tile-preview-right");
			this.style_class = styles.join(" ");

			if (!this.showing || changeMonitor) {
				let monitorRect = new Meta.Rectangle({
					x: monitor.x,
					y: monitor.y,
					width: monitor.width,
					height: monitor.height
				});
				let [, rect] = window.get_frame_rect().intersect(monitorRect);
				this.set_size(rect.width, rect.height);
				this.set_position(rect.x, rect.y);
				this.opacity = 0;
			}

			this.showing = true;
			this.show();
			this.ease({
				x: tileRect.x,
				y: tileRect.y,
				width: tileRect.width,
				height: tileRect.height,
				opacity: 255,
				duration: 200,
				mode: Clutter.AnimationMode.EASE_OUT_QUAD,
			});
		}

		close() {
			if (!this.showing)
				return;

			this.showing = false;
			this.tiledWindow = null;
			this.ease({
				opacity: 0,
				duration: 200,
				mode: Clutter.AnimationMode.EASE_OUT_QUAD,
				onComplete: () => this.reset(),
			});
		}

		reset() {
			this.hide();
			this.rect = null;
			this.monitorIndex = -1;
		}
	}
);