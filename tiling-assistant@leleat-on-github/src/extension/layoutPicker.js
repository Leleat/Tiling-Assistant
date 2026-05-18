import { Clutter, GObject, St, Gio } from '../dependencies/gi.js';
import { Main, Extension } from '../dependencies/shell.js';

const LayoutPickerVisibility = {
    HIDDEN: 0,
    PEAK: 1,
    SHOWN: 2
};

function iconPath(name) {
    const path = Extension.lookupByURL(import.meta.url)
            .dir
            .get_child(`media/${name}-symbolic.svg`)
            .get_path();

    return path;
}

export const LayoutPickerTileType = {
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
};

export const LayoutPicker = GObject.registerClass(
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

        this._visibility = LayoutPickerVisibility.HIDDEN;
        this._dragging = false;

        this.set_child(this._container);

        this._addChrome();

        this._vertIcon = this._createIcon('tile-vertical');
        this._horIcon = this._createIcon('tile-horizontal');
        this._quartIcon = this._createIcon('tile-quarter');
        this._maxIcon = this._createIcon('tile-base');

        this._container.add_child(this._vertIcon);
        this._container.add_child(this._horIcon);
        this._container.add_child(this._quartIcon);
        this._container.add_child(this._maxIcon);

        this._tileType = LayoutPickerTileType.NONE;

        // e.g ubuntu dock is enabled and or disabled
        global.display.connectObject('workareas-changed', () => {
	    this._updateAllocation(global.display.get_current_monitor());
        }, this);

        Main.layoutManager.connectObject('monitors-changed', () => {
	    this._updateAllocation(global.display.get_current_monitor());
        }, this);

        // just in case extension is enabled and disable
        this._updateAllocation(global.display.get_current_monitor());

        this.connectObject('notify::translation-y', () => {
            this.set_clip(
                0,
                this.height - this.translation_y,
                this.width,
                this.height
            );
        }, this);
    }

    get tileType() {
        return this._tileType;
    }

    get picking() {
        return this._tileType !== LayoutPickerTileType.NONE;
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
                this.opacity = this._visibility !== LayoutPickerVisibility.HIDDEN ? 255 : 0;
                this.reactive = this._visibility !== LayoutPickerVisibility.HIDDEN;

                // once picker is fully shown onMoving might not be able to update tile type
                // for situations like no cursor update after picker is fully shown.
                // this could causes incorrect tile type shown.
                if (this._visibility === LayoutPickerVisibility.SHOWN) {
                    let [curX, curY] = global.get_pointer();
                    this._updateLayoutPickerTileType(curX, curY);
                }
	    }

        });
    }

    onMonitorEntered(monitorIndex) {
	    this._updateAllocation(monitorIndex);
    }

    onMoving(curX, curY) {
        if (this._dragging === false)
            return;

        let [w, h] = this.get_size();
        let [mx, my_] = this.get_transformed_position();

        const themeNode = this.get_theme_node();
        let paddingLeft = themeNode.get_padding(St.Side.LEFT);
        let paddingRight = themeNode.get_padding(St.Side.RIGHT);
        let paddingBottom = this.get_theme_node().get_padding(St.Side.BOTTOM);

        const monitorIndex = global.display.get_current_monitor();
        const monitorArea = Main.layoutManager.monitors[monitorIndex];
        const activeWs = global.workspace_manager.get_active_workspace();
        const workArea = activeWs.get_work_area_for_monitor(monitorIndex);

        // using monitorArea.y instead  of workArea.y as upper bound to compensate with chromes such us the top bar height
        // placing cursor above workArea.y causes visibility glitch. workArea.y and monitorArea.y will be same for other monitor anyways.
        if (
            curY >= monitorArea.y &&
            curY <= workArea.y + h - paddingBottom &&
            curX >= mx + paddingLeft &&
            curX <= mx + w - paddingRight
        )
            this._setVisibility(LayoutPickerVisibility.SHOWN);
        else
            this._setVisibility(LayoutPickerVisibility.PEAK);

        this._updateLayoutPickerTileType(curX, curY);
    }

    onMoveStarted() {
        this._dragging = true;
        this._setVisibility(LayoutPickerVisibility.PEAK);
    }

    onMoveFinished() {
        this._dragging = false;
        this._setVisibility(LayoutPickerVisibility.HIDDEN);
    }

    _setLayoutPickerIcon(hoveredType) {
        this._clearIcons();
        switch (hoveredType) {
            case LayoutPickerTileType.NONE: {
                break;
            }
            case LayoutPickerTileType.LEFT: {
                this._updateIcon(this._horIcon, 'tile-left');
                break;
            }
            case LayoutPickerTileType.RIGHT: {
                this._updateIcon(this._horIcon, 'tile-right');
                break;
            }

            case LayoutPickerTileType.TOP: {
                this._updateIcon(this._vertIcon, 'tile-top');
                break;
            }

            case LayoutPickerTileType.BOTTOM: {
                this._updateIcon(this._vertIcon, 'tile-bottom');
                break;
            }

            case LayoutPickerTileType.Q1: {
                this._updateIcon(this._quartIcon, 'tile-q1');
                break;
            }

            case LayoutPickerTileType.Q2: {
                this._updateIcon(this._quartIcon, 'tile-q2');
                break;
            }

            case LayoutPickerTileType.Q3: {
                this._updateIcon(this._quartIcon, 'tile-q3');
                break;
            }

            case LayoutPickerTileType.Q4: {
                this._updateIcon(this._quartIcon, 'tile-q4');
                break;
            }

	    case LayoutPickerTileType.MAXIMIZE: {
                this._updateIcon(this._maxIcon, 'tile-maximize');
                break;
            }
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
        this._updateIcon(this._vertIcon, 'tile-vertical');
        this._updateIcon(this._horIcon, 'tile-horizontal');
        this._updateIcon(this._quartIcon, 'tile-quarter');
        this._updateIcon(this._maxIcon, 'tile-base');
    }

    _updateLayoutPickerTileType(curX, curY) {
        let rect = icon => {
            let [mx, my] = icon.get_transformed_position();
            let [mw, mh] = icon.get_size();
            return [mx, my, mw, mh];
        };
        let contains = (icon, x, y) => {
            let [mx, my, mw, mh] = rect(icon);
            return x >= mx && x <= mx + mw && y >= my && y <= my + mh;
        };

        if (contains(this._horIcon, curX, curY)) {
            let [mx, my_, mw, mh_] = rect(this._horIcon);
            let mid = mx + (mw * 0.5);

            if (curX <= mid)
                this._tileType = LayoutPickerTileType.LEFT;
            else
                this._tileType = LayoutPickerTileType.RIGHT;
        } else if (contains(this._vertIcon, curX, curY)) {
            let [mx_, my, mw_, mh] = rect(this._vertIcon);
            let mid = my + (mh * 0.5);

            if (curY <= mid)
                this._tileType = LayoutPickerTileType.TOP;
            else
                this._tileType = LayoutPickerTileType.BOTTOM;
        } else if (contains(this._quartIcon, curX, curY)) {
            let [mx, my, mw, mh] = rect(this._quartIcon);
            let midX = mx + (mw * 0.5);
            let midY = my + (mh * 0.5);

            if (curX >= midX && curY <= midY)
                this._tileType = LayoutPickerTileType.Q1;
            else if (curX < midX && curY <= midY)
                this._tileType = LayoutPickerTileType.Q2;
            else if (curX < midX && curY > midY)
                this._tileType = LayoutPickerTileType.Q3;
            else
                this._tileType = LayoutPickerTileType.Q4;
        } else if (contains(this._maxIcon, curX, curY)) {
	    this._tileType = LayoutPickerTileType.MAXIMIZE;
        }
        else {
            this._tileType = LayoutPickerTileType.NONE;
        }

        this._setLayoutPickerIcon(this._tileType);
    }

    _updateAllocation(monitorIndex) {
        const activeWs = global.workspace_manager.get_active_workspace();
        const workArea = activeWs.get_work_area_for_monitor(monitorIndex);

        if (workArea === null)
	    return;

        const [, natWidth] = this.get_preferred_width(-1);
        const [, natHeight] = this.get_preferred_height(-1);

        this.set_position(
            Math.round(workArea.x + (workArea.width - natWidth) / 2),
            Math.round(workArea.y - natHeight)
        );

        this.remove_all_transitions();

        this._visibility = LayoutPickerVisibility.HIDDEN;
        this.translation_y = 0;
        this.opacity = 0;
        this.reactive = false;
    }

    _addChrome() {
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

        global.display.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);

        this._container?.destroy();
        this._container = null;

        super.destroy();
    }
});

