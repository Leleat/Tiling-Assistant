# User Guide

## Table of Contents

- [Usage](#Usage)
    - [Mouse-driven Workflow](#Mouse-driven-Workflow)
    - [Keyboard-driven Workflow](#Keyboard-driven-Workflow)
- [Terminology](#Terminology)
    - [Tiling Popup](#Tiling-Popup)
    - [Tile Groups](#Tile-Groups)
    - [Tile Editing Mode](#Tile-Editing-Mode)
    - [Popup Layouts](#Popup-Layouts)
    - [Hidden Settings](#Hidden-Settings)

## Usage

### Mouse-driven Workflow

Dragging a window to the screen edges or corners will open a tile preview. By default, the top edge is used for maximizing. Keeping the maximized preview open for a short time will switch to the top-half tiling preview. Optionally, this behaviour can be inverted (for landscape or portrait displays separately).

Holding `Ctrl` when moving a window over a tiled window, will make the grabbed window and the tiled window beneath it share the same space. A similiar principle applies to hovering free screen space. Hovering at the very edges will affect multiple windows.

![](media/Guide_dnd.gif)

### Keyboard-driven Workflow

Use the the shortcuts from the `Keybindings` settings, the [Popup Layouts](#Popup-Layouts) and the [Tile Editing Mode](#Tile-Editing-Mode).

## Terminology

### Tiling Popup

This is the popup, which will appear when you tile a window and there is (unambiguous) free screen space. It will list the open windows on the current workspace.

The popup's app icons can be activated with `Space`, `Enter`, and `Right` or `Middle Mouse Button`. Activating one of the popup's app icons will tile the corresponding window to fill the free screen space.

Holding `Shift` or `Alt` while activating an app icon, will tile the window to the top/left or bottom/right half of the free space depending on the space's orientation (aka spiral/dwindle tiling).

![](media/Guide_tilingPopup.png)

### Tile Groups

When a window is tiled, the top-most tiled windows, which don't overlap each other, are considered in a group. That means they will be raised to the foreground together, if one of them is raised. Resizing one of the windows will also affect the other windows in the group.

### Tile Editing Mode

This is a special mode to manage your tiled windows with your keyboard.

You can navigate focus with the direction keys (`WASD`, `hjkl` or the `arrows`). Holding `Ctrl` while moving the focus and then releasing `Ctrl` will swap the highlighted windows. If you hold `Shift` as well instead of swapping the 2 highlighted windows, the sizes of the 2 windows and the windows between them will be equalized (*either* the width *or* the height based on the position of the 2 highlighted windows).

`Super` + `Directions` resizes the selected window. This follows GNOME's native resizing behaviour. That means, if you resize on one side and then want to resize on the opposite side, you first need to go to a neighbouring side of your current side before you can go to the opposite side. For intance, if you are currently increasing / decreasing the window size on the North side using the `up` and `down` arrows (or `w` / `s` / `j` / `k`) and then want to resize on the South, you first need to go the West or East side with the `left` or `right` arrows before you can use `down` to reach the South side.

When a window is highlighted, press `Q` to [q]uit it, `R` to [r]estore its size, and `E` to [e]xpand it to fill the available space. Press `C` to [c]ycle through 'half' states of a window.

Hitting `Esc`, `Space` or `Enter` will leave the Tile Editing Mode. If a free screen rectangle is highlighted, pressing `Space` or `Enter` will open the Tiling Popup instead.

![](media/Guide_tileEditingMode.gif)

### Popup Layouts

A 'Popup Layout' has a name and a list of rectangles with optional apps and loopTypes attached to each rectangle. If you activate a layout, you will spawn a Tiling Popup (hence the name 'Popup Layout') at each rectangle - one after the other. If you attached an app to the rectangle, instead of calling the Tiling Popup, a new instance of the app will be opened and tiled in that spot. If you set a loopType, you will keep tiling windows to that one rectangle and make them share that space evenly. This way you can setup layouts similiar to 'Master and Stack'. Any rectangle can have a loopType set.

You define rectangles by entering their `x` and `y` coordinate as well as their `width` and `height` into a text field separated by `--`. They are floating point values and can range from 0 to 1. The point (0,0) represents the top-left of your workspace and (1,1) the bottom-right. A loopType is set by appending `--h` or `--v` to the text field for a horizontal and a vertical loop respectively. You can attach an app by using the `add button` to the right of a text field. It acts like a toggle. If you already attached an app to it, clicking it again, will remove the app. Here is an example. The text field at row 0 defines a horizontal loop (`.5--0--.5--.5--h`) for the top-right quarter of my workspace and row 1 defines a non-looped rectangle (`.5--.5--.5--.5`) at the bottom-right quarter with an app (`Calender`) attached to it.

![](media/Guide_layouts.gif)

The `Search Popup Layout` keybinding enables you to activate layouts by name. That means you don't have to remember or set their keyboard shortcut. Here you can see it in action.

![](media/Guide_layouts2.gif)

By default, the `Popup Layouts` are [hidden](#Hidden-Settings) behind the 'Advanced / Experimental Settings'.

### Hidden Settings

This is a 'hidden' (more specificly: nameless) tab under `Help`. It contains minor (i. e. things I don't expect the general user to ever need), debugging, advanced and experimental settings.

![](media/Guide_HiddenSettings.png)