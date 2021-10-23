# Changelog

## v27
**Added**
- 'Fixed Layout', a new window movement mode, as an alternative to the default Edge Tiling (#94)
    - It allows people to dnd a window to a predefined layout (Check out the `GUIDE.md` for details)

**Changed**
- reworked the preference window to follow GNOME's HIG a bit more closely
    - use titlebar, listBoxes, etc...
- moved the 'Inverse Top Screen Edge Action' settings to the `Hidden Setting`
- moved the 'Include apps from all workspaces' for the Tiling Popup to the general settings
- and some other minor settings tweaks

**Removed**
- the color selection for the Tile Editing Mode because now we can always follow the system's native Tile-Preview style


## v26
**Added**
- ~~AUR package~~ (not by me, see #85)

**Changed**
- hid the `Layouts` behind the 'Advanced / Experimental Settings' switch (in `Hidden Settings`)
- renamed `Layout` to `Popup Layout` since just `Layout` may be misleading
- Tile Editing Mode's resizing now follows GNOME native keyboard resizing style (see `Alt` + `F8`)
- removed the PieMenu
- removed support for GNOME < 40
- refactored code & created scripts to automate stuff like building, updating translations...


## v25
**Fixed**
- bug when PieMenu is enabled


## v24
**Added**
- clear-keybindings button
- Dutch translation (by Vistaus #95)
- partial japanese translation (by k-fog #89)
- added Brazillian Portuguese translation (by msmafra #92)
- windows-like minimize option for the dynamic keybindings
- hidden settings: choose secondary mode (tile preview) activator and option to default to secondary mode (#90)

**Fixed**
- GNOME Shell 41: use new function, which got replaced in GS


## v23
**Added**
- partial Traditional Chinese translation for users in Taiwan (by laichiaheng #84)
- added dynamic tiling options: disabled, focus & tiling states (#87)
- added the 'layout selector' as an option for the pieMenu

**Changed**
- moved 'Tile Editing Mode: Focus Color' to the 'Hidden Settings'
- removed experimental semi-autotiling mode (#70)
- simplify tl file (removed duplicates)

**Fixed**
- multimonitor: wrong position for the focus indicator of the tile editing mode
- multimonitor: wrong position for the layout selector
- multimonitor: inconsistent behaviour for tiling a window via DND within the 'grace period'


## v22
**Added**
- link to a list of known incompatible apps/extensions (github issue #61)
- Czech translation (by pervoj #81)

**Fixed**
- correctly position PieMenu on multimonitor setup (#78)
- wrong tilePreview, if window was at the very top display edge
- stop an extension crash, if ~/.config/tiling-assistant didn't exist, when the screen got locked (#80)


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
