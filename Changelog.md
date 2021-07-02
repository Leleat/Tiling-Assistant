# Changelog

## v22
**Added**
- link to a list of known incompatible apps/extensions (github issue #61)
- Czech translation (by pervoj #81)

**Fixed**
- correctly position PieMenu on multimonitor setup (#78)
- wrong tilePreview, if window was at the very top display edge
- stop an extension crash, if ~/.config/tiling-assistant didn't exist, when the screen got locked


## v21
**Bugfixes:**
- reenable focus on prefs40.ui
- correctly use pointer position when moving window with keyboard `Alt` + `F7` + `Arrow` keys (#76)


## v20
**Features:**
- Tile Editing Mode: add option to 'equalize' window sizes (see 6bfbc07)
- Layouts: add dynamic rectangles to enable layouts like Master & Stack (see the tooltip in the `Layouts` tab of the settings)
- Experimental: Semi Tiling Mode (see 'Hidden Settings')

**Miscellaneous:**
- remove `User Guide` and `Changelog` tabs from the settings page (instead create .md files in repo)
- setup `translations/` for translations

**Bugfixes:**
- restore tile states properly after a screen lock


## v17 - 19
**Features:**
- Experimental: app attachments to layouts

**Miscellaneous:**
- Layouts: move layouts file from the extension folder to $XDG_CONFIG_HOME/tiling-assistant/layouts.json (#68)

**Bugfixes:**
- raise tileGroups with sloppy mouse focus mode only on click


## v16
- Pie menu: Super + RMB a window
- Settings: gaps on maximized windows (off by default)
- Settings: 'restore window size on grab end' (workaround for Wayland)
- Experimental: Tile Editing Mode


## v13 - 15
- dynamic tiling ('focus and tiling')
- ctrl-dragging a window now also works for multiple windows (by dragging the window to the very edges of other windows/free screen rects)
- inverse top screen edge action (by c-ridgway)
- multi-monitor: the tile preview will stick to the old monitor when changing monitors for a short period to easier tile quickly on the old monitor (by c-ridgway)
- default keybindings with the numpad for tiling (by c-ridgway)
- dynamic numbers of layouts & layout selector
- add 'User Guide' and 'Changelog' settings tab
- other minor settings additions/removals/changes
- refactor and minor bugfixes
