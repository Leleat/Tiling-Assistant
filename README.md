# Tiling assistant for GNOME

An extension which adds a Windows-like snap assist to GNOME. It also changes GNOME's 2 column tiling design to a 2x2 grid (i.e. 4 quadrants).

## Usage

When a window is tiled and at least half the screen is occupied by tiled windows, a Dash containing icons for all non-tiled windows from the current workspace will open. The Dash will be centered on the free (/unoccupied) screen space. 
Activating an icon will tile the corresponding window to fill the free space. 

If the free space spans 2 quadrants, you can hold `Shift` while activating the icon to tile the window to the top or the left free quadrant depending on the orientation of the free screen space and `Alt` to tile the window to the bottom or right quadrant.

**You should disable GNOME's default shortcuts for the split view and use the shortcuts of this extension.**

![Preview](preview.gif)

## Installation

You should install it via https://extensions.gnome.org. Alternatively, you can download the `tiling-assistant@leleat-on-github` folder and move it to your extensions folder. Local extensions are in `~/.local/share/gnome-shell/extensions/`.