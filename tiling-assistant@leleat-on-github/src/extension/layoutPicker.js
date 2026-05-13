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
    Q4: 8
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

        this.set_child(this._container);

        this._addChrome();

        this.reactive = true;
        this.visible = false;

        this._vertIcon = this._createIcon(iconPath('tile-vertical'));
        this._horIcon = this._createIcon(iconPath('tile-horizontal'));
        this._quartIcon = this._createIcon(iconPath('tile-quarter'));

        this._container.add_child(this._vertIcon);
        this._container.add_child(this._horIcon);
        this._container.add_child(this._quartIcon);

        this._tileType = LayoutPickerTileType.NONE;


        // Defer allocation until after the actor has been laid out
        this._allocationId = this.connect('notify::allocation', () => {
            this.disconnect(this._allocationId);
            this._allocationId = null;
            this._updateAllocation();
        });

	this._dragging = false;
    }

    get tileType() {
        return this._tileType;
    }

    get picking() {
        return this._tileType !== LayoutPickerTileType.NONE;
    }

    _setVisibility(visibility) {
        this._visibility = visibility;
        console.log(this._visibility);
        this._updateAllocation();
    }

    onMoving(curX, curY) {
	if (this._dragging === false)
	    return;

        let [mx, my] = this.get_transformed_position();
        let [w, h] = this.get_size();

        const monitorIndex = global.display.get_current_monitor();
        const monitorArea = Main.layoutManager.monitors[monitorIndex];
        const monitorY = monitorArea ? monitorArea.y : my; // fallback to my just in case monitorArea is null;

        // 1.75 acts as an early trigger when transitioning from PEAK to SHOWN.
        // This ensures the picker becomes visible before the cursor reaches it.
        // The multiplier is only applied for PEAK → SHOWN, not SHOWN → PEAK.
        const triggerHeight = this._visibility === LayoutPickerVisibility.PEAK ? h * 1.75 : h;

        // using monitorY instead (my) as upper bound to compensate with chromes such us the top bar height
        // placing cursor above my could cause glitch. (my) and monitorY will be same for other monitor anyways.
        if (curY >= monitorY && curY <= my + triggerHeight && curX >= mx && curX <= mx + w) {
	    this._setVisibility(LayoutPickerVisibility.SHOWN);
	} else {
            this._setVisibility(LayoutPickerVisibility.PEAK);
	}


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
                this._horIcon.gicon = Gio.FileIcon.new(
                    Gio.File.new_for_path(iconPath('tile-left'))
                );
                break;
            }
            case LayoutPickerTileType.RIGHT: {
                this._horIcon.gicon = Gio.FileIcon.new(
                    Gio.File.new_for_path(iconPath('tile-right'))
                );
                break;
            }

            case LayoutPickerTileType.TOP: {
                this._vertIcon.gicon = Gio.FileIcon.new(
                    Gio.File.new_for_path(iconPath('tile-top'))
                );
                break;
            }

            case LayoutPickerTileType.BOTTOM: {
                this._vertIcon.gicon = Gio.FileIcon.new(
                    Gio.File.new_for_path(iconPath('tile-bottom'))
                );
                break;
            }

            case LayoutPickerTileType.Q1: {
                this._quartIcon.gicon = Gio.FileIcon.new(
                    Gio.File.new_for_path(iconPath('tile-q1'))
                );
                break;
            }

            case LayoutPickerTileType.Q2: {
                this._quartIcon.gicon = Gio.FileIcon.new(
                    Gio.File.new_for_path(iconPath('tile-q2'))
                );
                break;
            }

            case LayoutPickerTileType.Q3: {
                this._quartIcon.gicon = Gio.FileIcon.new(
                    Gio.File.new_for_path(iconPath('tile-q3'))
                );
                break;
            }

            case LayoutPickerTileType.Q4: {
                this._quartIcon.gicon = Gio.FileIcon.new(
                    Gio.File.new_for_path(iconPath('tile-q4'))
                );
                break;
            }
        }
    }

    _createIcon(path) {
        let gicon = Gio.FileIcon.new(
            Gio.File.new_for_path(path)
        );

        return new St.Icon({
            gicon
        });
    }

    _clearIcons() {
        this._vertIcon.gicon = Gio.FileIcon.new(
            Gio.File.new_for_path(iconPath('tile-vertical'))
        );
        this._horIcon.gicon = Gio.FileIcon.new(
            Gio.File.new_for_path(iconPath('tile-horizontal'))
        );
        this._quartIcon.gicon = Gio.FileIcon.new(
            Gio.File.new_for_path(iconPath('tile-quarter'))
        );
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
        }
        else {
            this._tileType = LayoutPickerTileType.NONE;
        }

        this._setLayoutPickerIcon(this._tileType);
    }

    _updateAllocation() {
        const activeWs = global.workspace_manager.get_active_workspace();
        const monitorIndex = global.display.get_current_monitor();
        const workArea = activeWs.get_work_area_for_monitor(monitorIndex);

        if (!workArea)
            return;

        this.x = (workArea.x + (workArea.width * 0.5)) - this.width * 0.5;

        this.visible = true;

        if (this._visibility === LayoutPickerVisibility.HIDDEN) {
            this.y = workArea.y - this.height;
            this.visible = false;
        } else if (this._visibility === LayoutPickerVisibility.PEAK) {
            this.y = workArea.y - this.height + this._container.get_theme_node().get_padding(St.Side.Bottom);
        } else if (this._visibility === LayoutPickerVisibility.SHOWN) {
            this.y = workArea.y;
        }

        this.set_clip(0, Math.abs(this.y - workArea.y), workArea.width, workArea.height);
    }

    _addChrome() {
        Main.layoutManager.addChrome(this);
    }

    _untrackChrome() {
        Main.layoutManager.untrackChrome(this);
    }

    destroy() {
        this._untrackChrome();

        this._container?.destroy();
        this._container = null;

        super.destroy();
    }
});

