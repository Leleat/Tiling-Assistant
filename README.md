# Tiling assistant for GNOME

An extension which adds a Windows-like snap assist to GNOME. It also changes GNOME's 2 column tiling design to a 2x2 grid (i.e. 4 quadrants).

## Supported GNOME versions

- 3.38

Development started on GNOME 3.36. But as of November 2020 all development happens on 3.38. While it may (and I think it still should) work on 3.36, I can't test it.

Similiar outlook for **Wayland**. I am running NVIDIA drivers, as such I can't really test this extension on Wayland. For both cases I need extensive feedback.

PS: 
I'm not a developer, so any help in any form is appreciated.

## Usage and features

**You should disable GNOME's default keybindings for the split view/tiling and set them with this extension's settings page.**

- When a window is tiled and at least half the screen is occupied by tiled windows, a Dash containing icons for all non-tiled windows will open. The Dash will be centered on the free screen space. 
Activating an icon will tile the corresponding window to fill the free space. 

- If the free space spans 2 quadrants, you can hold `Shift` while activating the icon to tile the window to the top or the left free quadrant depending on the orientation of the free screen space and `Alt` to tile the window to the bottom or right quadrant.

- You can directly open an app from GNOME's search results or appGrid in a tiled state (left or right) by holding `Shift` or `Alt`. It will also effect other extensions which extend appDisplay.AppIcon (e.g. Dash-to-Dock).

- Raise/focus tiled windows as a group.

![Preview](preview.gif)

## Installation

You should install it via https://extensions.gnome.org. Alternatively, you can download the `tiling-assistant@leleat-on-github` folder and move it to your extensions folder. Local extensions are in `~/.local/share/gnome-shell/extensions/`.
