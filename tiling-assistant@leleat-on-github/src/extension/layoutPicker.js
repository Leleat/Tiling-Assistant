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

// ommit '-symbolic.svg' as it is managed by iconPath function already
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

        this._icons = {};

        for (const [group, config] of Object.entries(ICONS)) {
	    // start with icons that appear to be not hovered
            const icon = this._createIcon(config.none);

            config.icon = icon;
            this._icons[group] = icon;

            this._container.add_child(icon);
        }

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

    onMoving(curX, curY) {
        if (this._dragging === false)
            return;

        this._updateAllocation(global.display.get_current_monitor());

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

        let contains = ({ x, y, w, h }) => (
	    curX >= x &&
	    curX <= x + w &&
	    curY >= y &&
	    curY <= y + h
        );

        const horizontal = rect(this._icons.horizontal);

        if (contains(horizontal)) {
	    const leftPortion = curX < horizontal.x + horizontal.w / 2;

	    this._tileType = leftPortion
                ? LayoutPickerTileType.LEFT
                : LayoutPickerTileType.RIGHT;

	    this._setLayoutPickerIcon(this._tileType);
	    return;
        }

        const vertical = rect(this._icons.vertical);

        if (contains(vertical)) {
	    const topPortion = curY <= horizontal.y + horizontal.h / 2;

	    this._tileType = topPortion 
                ? LayoutPickerTileType.TOP
                : LayoutPickerTileType.BOTTOM;

	    this._setLayoutPickerIcon(this._tileType);
	    return;
        }

	const quarter = rect(this._icons.quarter);
	
	if (contains(quarter)) {
	    const leftPortion = curX < quarter.x + quarter.w / 2;
	    const topPortion = curY <= quarter.y + quarter.h / 2;

	    if (topPortion)
		this._tileType = leftPortion
		    ? LayoutPickerTileType.Q2
		    : LayoutPickerTileType.Q1;
	    else
		this._tileType = leftPortion
		    ? LayoutPickerTileType.Q3
		    : LayoutPickerTileType.Q4;
	    
	    this._setLayoutPickerIcon(this._tileType);
	    return;
	}

        this._tileType = contains(rect(this._icons.maximize))
	    ? LayoutPickerTileType.MAXIMIZE
	    : LayoutPickerTileType.NONE;

        this._setLayoutPickerIcon(this._tileType);
    }

    _updateAllocation(monitorIndex) {
        const activeWs = global.workspace_manager.get_active_workspace();
        const workArea = activeWs.get_work_area_for_monitor(monitorIndex);

        if (workArea === null)
	    return;

        const [, natWidth] = this.get_preferred_width(-1);
        const [, natHeight] = this.get_preferred_height(-1);

        const targetX = Math.round(workArea.x + (workArea.width - natWidth) / 2);
        const targetY = Math.round(workArea.y - natHeight);

        if (targetX === this.x && targetY === this.y)
	    return;

        this.set_position(targetX, targetY);

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

