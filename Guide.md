# User Guide

## Table of Contents

- [Usage](#Usage)
    - [Mouse-driven Workflow](#Mouse-driven-Workflow)
    - [Keyboard-driven Workflow](#Keyboard-driven-Workflow)
- [Terminology](#Terminology)
    - [Tiling Popup](#Tiling-Popup)
    - [Tile Groups](#Tile-Groups)
    - [Tile Editing Mode](#Tile-Editing-Mode)
    - [Layouts](#Layouts)
    - [Pie Menu](#Pie-Menu)
    - [Semi Tiling Mode](#Semi-Tiling-Mode)
    - [Hidden Settings](#Hidden-Settings)

## Usage

### Mouse-driven Workflow

Dragging a window to the screen edges or quarters will open a tile preview. By default, the top edge is used for maximizing. Keeping the maximized preview open for a short time will switch to the top-half tiling preview. Optionally, this behaviour can be inverted (for landscape or portrait displays separately).

Holding `Ctrl` when moving a window over a tiled window, will make the grabbed window and the tiled window beneath it share the same space. A similiar principle applies to hovering free screen space. Hovering at the very edges will affect multiple windows.

### Keyboard-driven Workflow

Use the the shortcuts from the Keybindings settings and the [Tile Editing Mode](#Tile-Editing-Mode). You can predefine [Layouts](#Layouts) to quickly create complex tiling designs.

## Terminology

### Tiling Popup

This is the popup, which will open when you tile a window and there is (unambiguous) free screen space. It will list the open windows on the current workspace.

The popup's app icons can be activated with `Space`, `Enter`, and `Right` or `Middle Mouse Button`. Activating one of the popup's app icons will tile the corresponding window to fill the free screen space.

Holding `Shift` or `Alt` while activating an app icon, will tile the window to the top/left or bottom/right half of the free space depending on the space's orientation (aka spiral/dwindle tiling).

### Tile Groups

When a window is tiled, the top-most tiled windows, which don't overlap each other, are considered in a group. That means they will be raised to the foreground together, if one of them is focused. Resizing one of the windows will also affect the other windows in the group.

The group resizing can be escaped by holding `Ctrl` when starting the resize operation. This way only directly opposing windows will resize together. This may lead to inaccuracies in your layout and may mess up the layout detection, if you use window gaps as well.

### Tile Editing Mode

This is a special mode to manage your tiled windows.

You can navigate focus with the direction keys (`WASD`, `hjkl` or the `arrows`). Holding `Ctrl` while moving the focus and then releasing `Ctrl` will swap the highlighted windows. If you hold `Shift` as well instead of swapping the 2 highlighted windows, the sizes of the 2 windows and the windows between them will be equalized (*either* the width *or* the height depending on the relational position of the 2 highlighted windows).

`Super` + `Directions` will resize the selected window on the E or S side. Additionally holding `Shift` will resize the window on the W or N side.

When a window is highlighted, press `Q` to [q]uit it, `R` to [r]estore a window's size, and `E` to [e]xpand it to fill the available space. Press `C` to [c]ycle through 'half' states of a window.

Pressing `Esc`, `Space` or `Enter` will leave the Tile Editing Mode. If a free screen rectangle is highlighted, pressing `Space` or `Enter` will open the Tiling Popup instead.

### Layouts

A layout consists of a list of arbitrary rectangles. When activating a layout the tiling popup will ask you which of the open windows you want in which rectangle of your layout.

The layout selector enables you to search for layouts by name. That means you don't have to remember their keybindings.

### Pie Menu

`Super` + `RMB` on a window will open a pie menu. Moving the mouse into a direction and then releasing the right-click will perform that pie action. The pie menu's appearance is slightly delayed. However, the menu doesn't need to be visible for a pie action to be activated.

### Semi Tiling Mode

This is an experimental feature and thus off by default. Provide feedback at [#70](/../../issues/70). It can be enabled in the `Hidden Settings`. This feature is inspired by manual tiling window managers.

The tiling won't happen automatically. You need to hold `Shift` when activating an AppIcon (from the Dash, AppGrid or Search Results). A new instance of the app will be opened.

The newly opened window will try to fill the free unambiguous screen space. If there is none, they will share the space with the focused tiled window. The position of the new window is indicated by the top panel icon. It can be cycled with keyboard shortcuts or by clicking the panel icon.

### Hidden Settings

This is a 'hidden' (more specificly: nameless) tab under `Help and Changelog`. It contains minor (i. e. settings I don't expect the general user to ever need) or debugging and experimental settings.