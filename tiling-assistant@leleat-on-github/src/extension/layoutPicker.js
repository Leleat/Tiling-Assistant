import { Clutter, GLib, GObject, St, Gio } from '../dependencies/gi.js';
import { Main } from '../dependencies/shell.js';

import { Settings } from '../common.js';

const LayoutPickerVisibility = {
    HIDDEN: 0,
    PEAK: 1,
    SHOWN: 2
};

function iconPath(name) {
    return GLib.build_filenamev([
        Settings.getExtension().path,
        'media',
        `${name}-symbolic.svg`
    ]);
}

export const LayoutPickerTileType = Object.freeze({
    NONE: 0,
    LEFT: 1,
    RIGHT: 2,
    TOP: 3,
    BOTTOM: 4,
    Q1: 5,
    Q2: 6,
    Q3: 7,
    Q4: 8,
    MAXIMIZE: 9
});

// omit '-symbolic.svg' as it is managed by iconPath function already
const ICONS = {
    vertical: {
        none: 'tile-vertical',

        states: {
            [LayoutPickerTileType.TOP]: 'tile-top',
            [LayoutPickerTileType.BOTTOM]: 'tile-bottom'
        }
    },

    horizontal: {
        none: 'tile-horizontal',

        states: {
            [LayoutPickerTileType.LEFT]: 'tile-left',
            [LayoutPickerTileType.RIGHT]: 'tile-right'
        }
    },

    quarter: {
        none: 'tile-quarter',

        states: {
            [LayoutPickerTileType.Q1]: 'tile-q1',
            [LayoutPickerTileType.Q2]: 'tile-q2',
            [LayoutPickerTileType.Q3]: 'tile-q3',
            [LayoutPickerTileType.Q4]: 'tile-q4'
        }
    },

    maximize: {
        none: 'tile-base',

        states: {
            [LayoutPickerTileType.MAXIMIZE]: 'tile-maximize'
        }
    }
};

const Ripples = GObject.registerClass(
  class Ripples extends St.Widget {
      _init(container, layoutPicker) {
          super._init({
              reactive: false,
              x_align: Clutter.ActorAlign.CENTER,
              y_align: Clutter.ActorAlign.CENTER,
              layout_manager: new Clutter.BinLayout()
          });
          this._container = container;
          this._layoutPicker = layoutPicker;

          this._ripples = [
              new St.Widget({
                  reactive: false,
                  opacity: 0,
                  x_align: Clutter.ActorAlign.CENTER,
                  y_align: Clutter.ActorAlign.CENTER
              }),
              new St.Widget({
                  reactive: false,
                  opacity: 0,
                  x_align: Clutter.ActorAlign.CENTER,
                  y_align: Clutter.ActorAlign.CENTER
              }),
              new St.Widget({
                  reactive: false,
                  opacity: 0,
                  x_align: Clutter.ActorAlign.CENTER,
                  y_align: Clutter.ActorAlign.CENTER
              })
          ];

          this._ripples.forEach(ripple => {
              this.add_child(ripple);
              ripple.set_pivot_point(0.5, 0.5);
          });

          this._finalStepSize = 120;
      }

      _resetRipple(ripple) {
          ripple.remove_all_transitions();
          ripple.set_scale(1, 1);
          ripple.opacity = 0;
      }

      play(x, y) {
          const [width, height] = this._container.get_transformed_size();
          const themeNode = this._container.get_theme_node();
          const borderRadius = themeNode
              ? themeNode.get_border_radius(St.Side.TOP_LEFT)
              : 20;

          const step = this._finalStepSize;

          // scaling a rectangle is not ideal as the longer side
          // will scale larger than the shorter side
          // so total left + right grow will be different for
          // total top + bottom grow
          //
          // We first compute for final height and final width
          const finalHeight = height + step;
          const finalWidth = width + step;

          // then we compute for scale x and scale y
          const scaleX = finalWidth / width;
          const scaleY = finalHeight / height;

          // 1 + decimal_portion / 2
          // e.g 1.5 will be transformed to 1.25
          const halfScaleX = 1 + (scaleX - 1) / 2;
          const halfScaleY = 1 + (scaleY - 1) / 2;

          // set position and side base on final values
          this.set_position(x - step / 2, y - step / 2);
          this.set_size(finalWidth, finalHeight);

          const [, pickerHeight] = this._layoutPicker.get_transformed_size();

          let clipY = pickerHeight - this._layoutPicker.translation_y + step / 2;

          // this._layoutPicker is larger than this._container
          // so we also compensate for it
          clipY -= (pickerHeight - height) / 2;

          this.set_clip(0, clipY, this.width, this.height);

          const duration = 600;
          const delay = 300;

          const cycleCount = 3;

          this._ripples.forEach(ripple => {
              ripple.set_style(`
           border-radius: ${borderRadius}px;
           background-color: white;
        `);
              ripple.set_size(width, height);
          });

          this._ripples.forEach((ripple, i) => {
              let currentCycle = 0;

              const cycle = () => {
                  if (currentCycle >= cycleCount)
                      return;

                  currentCycle++;
                  this._resetRipple(ripple);

                  // grow + fade in
                  ripple.ease({
                      opacity: 90,
                      scale_x: halfScaleX,
                      scale_y: halfScaleY,
                      duration,
                      delay: currentCycle === 1 ? delay * i : 0,
                      mode: Clutter.AnimationMode.EASE_IN_QUAD,
                      onComplete: () => {
                          // continue growing + fade out
                          ripple.ease({
                              opacity: 0,
                              scale_x: scaleX,
                              scale_y: scaleY,
                              duration,
                              delay: 0, //  delay already appears in first ease
                              mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                              onComplete: () => cycle()
                          });
                      }
                  });
              };
              cycle();
          });
      }

      stop() {}

      addChrome() {
          Main.layoutManager.addChrome(this, {
              affectsStruts: false,
              trackFullscreen: false
          });
      }

      untrackChrome() {
          Main.layoutManager.untrackChrome(this);
      }

      destroy() {
          this._container = null;
          super.destroy();
      }
  }
);

export const LayoutPicker = GObject.registerClass(
    {
        Properties: {
            'tile-type': GObject.ParamSpec.int(
                'tile-type',
                'tile-type',
                'tile-type',
                GObject.ParamFlags.READWRITE,
                LayoutPickerTileType.NONE,
                LayoutPickerTileType.MAXIMIZE,
                LayoutPickerTileType.NONE
            )
        }
    },
    class LayoutPicker extends St.Bin {
        _init() {
            super._init({
                style_class: 'tiling-menu-container'
            });

            this._container = new St.BoxLayout({
                x_expand: true,
                orientation: Clutter.Orientation.HORIZONTAL,
                style_class: 'popup-menu-content'
            });

            this._ripples = new Ripples(this._container, this);

            this._visibility = LayoutPickerVisibility.HIDDEN;
            this._dragging = false;
            this._ripple = true;

            this.set_child(this._container);

            this._addChrome();

            this._icons = {};

            for (const [group, config] of Object.entries(ICONS)) {
                // start with icons that appear to be not hovered
                const icon = this._createIcon(config.none);

                config.icon = icon;
                this._icons[group] = icon;

                this._container.add_child(icon);
            }

            // e.g a dock is enabled and or disabled
            global.display.connectObject(
                'workareas-changed',
                () => {
                    this._updateAllocation(global.display.get_current_monitor());
                },
                this
            );

            Main.layoutManager.connectObject(
                'monitors-changed',
                () => {
                    this._updateAllocation(global.display.get_current_monitor());
                },
                this
            );

            // GNOME Shell doesn't disable extensions when shutting down, so stop
            // reacting to monitor and work-area changes as soon as it shuts down.
            global.connectObject(
                'shutdown',
                () => {
                    global.display.disconnectObject(this);
                    Main.layoutManager.disconnectObject(this);
                },
                this
            );

            // The picker only needs to know when the move it reacts to is over,
            // so it can hide itself without the move handler having to track it.
            global.display.connectObject(
                'grab-op-end',
                () => this.onMoveFinished(),
                this
            );

            // just in case extension is enabled and disable
            this._updateAllocation(global.display.get_current_monitor());

            this.connectObject(
                'notify::translation-y',
                () => {
                    this.set_clip(
                        0,
                        this.height - this.translation_y,
                        this.width,
                        this.height
                    );
                },
                this
            );
        }

        _setVisibility(visibility) {
            if (this._visibility === visibility)
                return;

            this._visibility = visibility;

            this.opacity = 255;
            this.reactive = true;

            let positions = [
                0,
                this._container.get_theme_node().get_padding(St.Side.Bottom) +
          this.get_theme_node().get_padding(St.Side.BOTTOM),
                this.height
            ];

            this.remove_all_transitions();

            this.ease({
                translation_y: positions[visibility],
                duration: 250,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    this.opacity =
            this._visibility !== LayoutPickerVisibility.HIDDEN ? 255 : 0;
                    this.reactive = this._visibility !== LayoutPickerVisibility.HIDDEN;

                    // once picker is fully shown onMoving might not be able to update tile type
                    // for situations like no cursor update after picker is fully shown.
                    // this could causes incorrect tile type shown.
                    if (this._visibility === LayoutPickerVisibility.SHOWN) {
                        let [curX, curY] = global.get_pointer();
                        this._updateLayoutPickerTileType(curX, curY);
                    } else if (
                        this._visibility === LayoutPickerVisibility.PEAK &&
            this._ripple
                    ) {
                        // wait for ease animation to finish and reach PEAK position
                        // before triggering ripple aimation
                        this._startRipple();

                        // this will force the animation to trigger once for the
                        // entire lifetime of this LayoutPicker object.
                        this._ripple = false;
                    }
                }
            });
        }

        onMoving(curX, curY, monitorIndex = global.display.get_current_monitor()) {
            if (this._dragging === false)
                return;

            this._updateAllocation(monitorIndex);

            let [w, h] = this.get_size();
            let [mx, my_] = this.get_transformed_position();

            const themeNode = this.get_theme_node();
            let paddingLeft = themeNode.get_padding(St.Side.LEFT);
            let paddingRight = themeNode.get_padding(St.Side.RIGHT);
            let paddingBottom = this.get_theme_node().get_padding(St.Side.BOTTOM);

            const monitorArea = Main.layoutManager.monitors[monitorIndex];
            const area = this._getArea(monitorIndex);

            // Use monitorArea.y as the lower bound instead of area.y so the picker
            // also reveals while the cursor is over a chrome such as the top bar.
            if (
                curY >= monitorArea.y &&
        curY <= area.y + h - paddingBottom &&
        curX >= mx + paddingLeft &&
        curX <= mx + w - paddingRight
            )
                this._setVisibility(LayoutPickerVisibility.SHOWN);
            else
                this._setVisibility(LayoutPickerVisibility.PEAK);

            if (this._visibility === LayoutPickerVisibility.SHOWN)
                this._updateLayoutPickerTileType(curX, curY);
            else
                this._resetTileType();
        }

        onMoveStarted() {
            this._dragging = true;
            this._resetTileType();
            this._setVisibility(LayoutPickerVisibility.PEAK);
        }

        onMoveFinished() {
            this._dragging = false;
            this._resetTileType();
            this._setVisibility(LayoutPickerVisibility.HIDDEN);
        }

        _resetTileType() {
            this.tileType = LayoutPickerTileType.NONE;
            this._clearIcons();
        }

        _setLayoutPickerIcon(tileType) {
            this._clearIcons();

            for (const config of Object.values(ICONS)) {
                const iconName = config.states[tileType];

                if (!iconName)
                    continue;

                this._updateIcon(config.icon, iconName);
                break;
            }
        }

        _createIcon(name) {
            let fallback_gicon = Gio.FileIcon.new(
                Gio.File.new_for_path(iconPath(name))
            );

            let gicon = new Gio.ThemedIcon({
                name: `${name}-symbolic`
            });

            return new St.Icon({
                gicon,
                fallback_gicon
            });
        }

        _updateIcon(icon, name) {
            let fallback_gicon = Gio.FileIcon.new(
                Gio.File.new_for_path(iconPath(name))
            );

            let gicon = new Gio.ThemedIcon({
                name: `${name}-symbolic`
            });
            icon.set({
                gicon,
                fallback_gicon
            });
        }

        _clearIcons() {
            for (const config of Object.values(ICONS))
                this._updateIcon(config.icon, config.none);
        }

        _updateLayoutPickerTileType(curX, curY) {
            let rect = icon => {
                let [x, y] = icon.get_transformed_position();
                let [w, h] = icon.get_size();
                return { x, y, w, h };
            };

            let contains = ({ x, y, w, h }) =>
                curX >= x && curX <= x + w && curY >= y && curY <= y + h;
            const horizontal = rect(this._icons.horizontal);

            if (contains(horizontal)) {
                const leftPortion = curX < horizontal.x + horizontal.w / 2;

                this.tileType = leftPortion
                    ? LayoutPickerTileType.LEFT
                    : LayoutPickerTileType.RIGHT;

                this._setLayoutPickerIcon(this.tileType);
                return;
            }

            const vertical = rect(this._icons.vertical);

            if (contains(vertical)) {
                const topPortion = curY <= vertical.y + vertical.h / 2;

                this.tileType = topPortion
                    ? LayoutPickerTileType.TOP
                    : LayoutPickerTileType.BOTTOM;

                this._setLayoutPickerIcon(this.tileType);
                return;
            }

            const quarter = rect(this._icons.quarter);

            if (contains(quarter)) {
                const leftPortion = curX < quarter.x + quarter.w / 2;
                const topPortion = curY <= quarter.y + quarter.h / 2;

                if (topPortion) {
                    this.tileType = leftPortion
                        ? LayoutPickerTileType.Q2
                        : LayoutPickerTileType.Q1;
                } else {
                    this.tileType = leftPortion
                        ? LayoutPickerTileType.Q3
                        : LayoutPickerTileType.Q4;
                }

                this._setLayoutPickerIcon(this.tileType);
                return;
            }

            this.tileType = contains(rect(this._icons.maximize))
                ? LayoutPickerTileType.MAXIMIZE
                : LayoutPickerTileType.NONE;

            this._setLayoutPickerIcon(this.tileType);
        }

        _getArea(monitorIndex) {
            const monitorArea = Main.layoutManager.monitors[monitorIndex];

            if (monitorArea.inFullscreen)
                return monitorArea;

            const activeWs = global.workspace_manager.get_active_workspace();
            return activeWs.get_work_area_for_monitor(monitorIndex);
        }

        _updateAllocation(monitorIndex) {
            // The current monitor can already be gone (e.g. when the last monitor
            // is removed during shutdown), so make sure it still exists before
            // asking Mutter for its work area.
            if (!Main.layoutManager.monitors[monitorIndex])
                return;

            const area = this._getArea(monitorIndex);

            if (area === null)
                return;

            const [, natWidth] = this.get_preferred_width(-1);
            const [, natHeight] = this.get_preferred_height(-1);

            const targetX = Math.round(area.x + (area.width - natWidth) / 2);
            const targetY = Math.round(area.y - natHeight);

            if (targetX === this.x && targetY === this.y)
                return;

            this.set_position(targetX, targetY);

            this.remove_all_transitions();

            this._visibility = LayoutPickerVisibility.HIDDEN;
            this.translation_y = 0;
            this.opacity = 0;
            this.reactive = false;
        }

        _startRipple() {
            const [x, y] = this._container.get_transformed_position();
            this._ripples.play(x, y);
        }

        _forceStopRipple() {}

        _addChrome() {
            this._ripples.addChrome();

            Main.layoutManager.addChrome(this, {
                affectsStruts: false,
                trackFullscreen: false
            });
        }

        _untrackChrome() {
            Main.layoutManager.untrackChrome(this);
        }

        destroy() {
            this._untrackChrome();

            this._ripples.untrackChrome();
            this._ripples.destroy();

            global.display.disconnectObject(this);
            Main.layoutManager.disconnectObject(this);

            super.destroy();
        }
    }
);
