# Changelog

## [47] - 2024-04-21

### Fixed

-   Don't untile a window on a single click by taoky (#328)

### Changed

-   Use native AdwSwitchRow and AdwSpinRow (#334)

### Removed

-   Removed restore-window-size-on-grab-start/end setting since it should be no longer needed (#334)

## [46] - 2024-03-24

### Added

-   Brazilian Portuguese translation by nunseik (#310)
-   Italian translation by albanobattistella (#312)
-   Ukrainian translation by xalt7x (#317)
-   Support for GNOME 46 by sergio-costas (#319)

### Fixed

-   Rework arch PKGBUILD to compile completely from source to enable building inside a docker-container by VeldoraTheDragon (#296, #301)
-   Handle change of window action key while the extension is enabled (#321)

### Changed

-   Disable animations when using layouts as a workaround for freezing windows according to #304 (#321)

## [44] - 2023-09-18

### Added

-   support for GNOME 45 (#281)

## [43] - 2023-09-17

### Fixed

-   Window not resizing correctly when it enters another monitor - by domferr (#290)

## [42] - 2023-09-03

### Added

-   Italian translation by albanobattistella (#271)

### Fixed

-   Move modes update correctly when the grabbed window changes the monitor (#279)

## [41] - 2023-05-17

### Fixed

-   Tiling Popup not appearing under some circumstances (#259)
-   Properly restore tiling props on all workspaces (#262)

## [40] - 2023-04-13

### Added

-   Support for GNOME Shell 44 by 3v1n0 (mostly #234)
-   Github CI: linting and spell checking
-   Spanish translations by IngrownMink4 (#216)
-   Dutch translations by flipflop97 (#215)
-   Italian translations by albanobattistella (#220)
-   German translations by affengeist (#231)
-   Hungarian translations by infeeeee (#236)

### Fixed

-   The position of the fix-search-a-layout popup now appears correctly on multi-monitor setups (#247)
-   Fix tiling when there are always-on-top windows (#240)
-   Fix non-extension maximization window-restore position (#251)

### Changed

-   Move UserGuide.MD into the [github wiki](https://github.com/Leleat/Tiling-Assistant/wiki)
-   Update Scripts and a bugfix by SubOptimal (#248, #249, #250)

## [39] - 2022-11-23

### Fixed

-   Clean up settings signals properly (technically only relevant for the active hint since it may be destroyed before the settings singleton)

## [38] - 2022-11-23

### Fixed

-   Issue with always active window hint (there is still a problem with GTK4 popups on Wayland)

## [37] - 2022-11-22

### Added

-   Added active window hint. By default the `Minimal` option will be chosen (#210)
-   Added an option to not use T-A features (Tiling Popup and grouping) when DNDing a window via a modifier and via additional keyboard shortcuts. Features are hidden behind the advanced settings (#212)
-   Added setting for a single/uniform screen gap instead of splitting it into edges (each edge is still available, if the advanced settings are enabled)

### Changed

-   Increased possible maximum of gaps to 500 (#205)
-   Changed/shuffled some of the preferences around

## [36] - 2022-09-04

### Added

-   Support GNOME 43

### Changed

-   Removed the 'row'-look of shortcuts in the layouts

### Fixed

-   Consider monitor scale when calculating window gaps (#196)

## [35] - 2022-07-23

### Added

-   Added setting to disable multi-monitor grace period (#189)

### Changed

-   Make the 'improved performance behavior' opt-in (in the advanced settings) since it impacts the precision of the tile preview (#190)

### Fixed

-   Fixed issue about windows maximizing to wrong monitor under some circumstances setups (#188)

### Removed

-   Removed in-app changelog

## [34] - 2022-07-13

### Added

-   Added setting to completely disable tile groups. That means no resizing, raising or suggestions anymore (#180)
-   Added the ability to only resize the absolutely necessary windows in a tile group when holding `Ctrl` before resizing started (#155)

### Changed

-   Improved performance when dragging a window around for lower performance machines (#181)
-   Split the screen gap setting into top, bottom, left and right parts by CharlieQLe (#146)
-   Don't open the changelog window after an extension update in the prefs by default anymore

### Fixed

-   Added a workaround for a multi-monitor bug where windows may untile incorrectly under Wayland (#137)
-   Fixed issue with RMB as a `Move Mode Activator` under Wayland (#170)
-   Added Meta as a `Move Mode Activator` and set it as default, if `Alt` is the default window action key (#172)

## [33] - 2022-05-07

### Added

-   German (Switzerland) tl by MrReSc #152
-   German (Germany) tl by pjanze #161
-   Italian translation by starise #164
-   Spanish translation by fjsevilla-dev #168

### Changed

-   Port to GNOME 42 and drop support for older versions
-   Brazilian Portuguese tl by ItzJaum #157
-   If an app is attached to a layout rect, try to tile an existing window instance first before opening a new one

### Removed

-   Deprecate 'App Switcher and Tiling Popup' setting
-   Hacky partial touch 'support'

### Fixed

-   Override GNOME's default shortcuts only if they are set in Tiling Assistant

## [32] - 2022-01-22

### Added

-   Added new keyboard shortcuts:
    -   Restore window size (#134)
    -   Toggle Vertical Maximization
    -   Toggle Horizontal Maximization
    -   Move Window to Center (#132)
    -   Toggle `Always on Top`
-   Added ability to move tile groups to a new workspace/monitor using the Tile Editing Mode:
    -   `Shift`+`Directions` moves the tile group to a new monitor
    -   `Shift`+`Alt`+`Directions` moves the tile group to a new workspace
-   Tiled windows will untile themselves if they change workspaces
-   Allow one action to have multiple keyboard shortcuts (press `Enter` or `Space` when listening for a new keyboard shortcut to append shortcuts to existing ones)
-   Added GNOME's native tiling behavior (`Super`+`Up`/`Down`/`Left`/`Right`) to the default shortcuts

### Changed

-   Adapt edge-tiling only if it doesn't cover existing tiles. Use `Ctrl`-drag (mouse) or the `Tile Editing Mode` (keyboard) to 'replace/cover' existing tiles. That way 1 window can be part of multiple tile groups
-   Reworked tile group detection when a window is tiled
-   Renamed `Split Tiles` mode to `Adaptive Tiling`. This is the mode when moving a window around while holding `Ctrl`
-   Disabled grouping tiled windows in the app switcher by default and mark that setting as experimental
-   Introduce concept of deprecated settings and deprecate the `Toggle Tiling Popup` and `Auto-Tile` keyboard shortcuts
    -   Deprecated settings won't be visible in the prefs window anymore unless they have a non-default value set

### Fixed

-   Fixed a compatibility issue introduced in v31 with other alt-Tab extensions (#126)
-   Fixed the Tiling Popup ignoring the Tile Group setting `App Switcher and Tiling Popup`
-   Shortcuts may no longer change unintentionally after using the clear-shortcut-button
-   Fixed the URLs in the prefs' popup menu freezing the prefs - Wayland only (#136)

## [31] - 2021-12-10

### Fixed

-   Fixed crash introduced in v28 (#125)

## [30] - 2021-12-10

### Fixed

-   Fixed crash introduced in v28 (#124)

## [29] - 2021-12-09

### Fixed

-   Removed timer sources according to EGO review

## [28] - 2021-12-09

### Added

-   Added a Panel Indicator for the layouts (disabled by default). With it you can activate a layout with your pointer or change your `Favorite Layout` (per monitor)
-   Added a setting to group tileGroups in the AppSwitcher (altTab) and Tiling Popup
-   When dnd-ing a window, hold `Super` to make the tile preview span multiple rectangles. This only works in the `Favorite Layout` or `Split Tiles` preview modes
-   Added a `hidden` setting to not adapt the Edge-Tiling to the favorite layouts

### Removed

-   Removed the `Change favorite layouts` keyboard shortcut (Use the Panel Indicator instead)
-   Removed the favorite button from the `Layouts` in the preferences (Use the Panel Indicator instead)

### Changed

-   Show the entire Layout when moving a window with the `Favorite Layout` preview mode
-   Updated the jp translation (by k-fog #112)
-   Untile tiled windows, if they are moved to a new monitor or workspace (#114)
-   `Tile Editing Mode`: Pressing `Space` will always open the Tiling Popup (even if there is already a window in that spot)
-   Visual tweaks to the preference window

### Fixed

-   When dragging a window to a new monitor there is a short `Grace Period` (150 ms), in which, if the grab is released, the window will tile to the old monitor. Fix: The `Tiling Popup` will appear on the correct monitor now.
-   Fixed artifacts due to the rounded corners of the `Changelog Dialog` (only works on Wayland)
-   Fixed animations being skipped, if an animation was already running (#58)

## [27] - 2021-11-01

### Added

-   `Favorite Layout`, a new window movement mode, as an alternative to the default Edge Tiling (issue #94)
    -   It allows users to dnd a window to a predefined layout (Check out the `GUIDE.md` for details)
    -   It also adapts the keyboard shortcuts and edge previews to the favorite layout
-   Changelog dialog to prefs window on new extension version (deactivatable in `Hidden Settings`)

### Removed

-   The color selection for the Tile Editing Mode because now we can always follow the system's native Tile-Preview style

### Changed

-   Split gaps into `Window Gaps` and `Screen Gaps` (i. e. when windows are touching the screen edges) (discussion #109)
-   `Tile to top` & `Toggle Maximization` cycle between top tiling and maximization in `Tiling State` and `Tiling State (Windows)`
-   Reworked the preference window to follow GNOME's HIG a bit more closely
-   Moved the `Inverse Top Screen Edge Action` settings to the `Hidden Setting`
-   Moved the `Include apps from all workspaces` for the Tiling Popup to the general settings
-   And some other minor settings tweaks

## [26] - 2021-10-14

### Added

-   AUR package (not by me, see #85)

### Changed

-   Hid the `Layouts` behind the 'Advanced / Experimental Settings' switch (in `Hidden Settings`)
-   Renamed `Layout` to `Popup Layout` since just `Layout` may be misleading
-   Tile Editing Mode's resizing now follows GNOME native keyboard resizing style (see `Alt` + `F8`)
-   Removed the PieMenu
-   Removed support for GNOME < 40
-   Refactored code & created scripts to automate stuff like building, updating translations...

## [25] - 2021-09-27

### Fixed

-   Bug when PieMenu is enabled

## [24] - 2021-09-27

### Added

-   Clear-keybindings button
-   Dutch translation (by Vistaus #95)
-   Partial japanese translation (by k-fog #89)
-   Added Brazilian Portuguese translation (by msmafra #92)
-   Windows-like minimize option for the dynamic keybindings
-   Hidden settings: choose secondary mode (tile preview) activator and option to default to secondary mode (#90)

### Fixed

-   GNOME Shell 41: use new function, which got replaced in GS

## [23]

### Added

-   Partial Traditional Chinese translation for users in Taiwan (by laichiaheng #84)
-   Added dynamic tiling options: disabled, focus & tiling states (#87)
-   Added the 'layout selector' as an option for the pieMenu

### Changed

-   Moved 'Tile Editing Mode: Focus Color' to the 'Hidden Settings'
-   Removed experimental semi-autotiling mode (#70)
-   Simplify tl file (removed duplicates)

### Fixed

-   Multimonitor: wrong position for the focus indicator of the tile editing mode
-   Multimonitor: wrong position for the layout selector
-   Multimonitor: inconsistent behavior for tiling a window via DND within the 'grace period'

## [22]

### Added

-   Link to a list of known incompatible apps/extensions (github issue #61)
-   Czech translation (by pervoj #81)

### Fixed

-   Correctly position PieMenu on multimonitor setup (#78)
-   Wrong tilePreview, if window was at the very top display edge
-   Stop an extension crash, if ~/.config/tiling-assistant didn't exist, when the screen got locked (#80)

## [21]

### Fixed

-   Re-enable focus on prefs40.ui
-   Correctly use pointer position when moving window with keyboard `Alt` + `F7` + `Arrow` keys (#76)

## [20]

### Added

-   Tile Editing Mode: add option to 'equalize' window sizes (see 6bfbc07)
-   Layouts: add dynamic rectangles to enable layouts like Master & Stack (see the tooltip in the `Layouts` tab of the settings)
-   Experimental: Semi Tiling Mode (see 'Hidden Settings')
-   Setup `translations/` for translations

### Changed

-   Remove `User Guide` and `Changelog` tabs from the settings page (instead create .md files in repo)

### Fixed

-   Restore tile states properly after a screen lock

## [17] - [19]

### Added

-   Experimental: app attachments to layouts

### Changed

-   Layouts: move layouts file from the extension folder to $XDG_CONFIG_HOME/tiling-assistant/layouts.json (#68)

### Fixed

-   Raise tileGroups with sloppy mouse focus mode only on click

## [16]

### Added

-   Pie menu: Super + RMB a window
-   Settings: gaps on maximized windows (off by default)
-   Settings: 'restore window size on grab end' (workaround for Wayland)
-   Experimental: Tile Editing Mode

## [13] - [15]

### Added

-   Dynamic tiling ('focus and tiling')
-   Ctrl-dragging a window now also works for multiple windows (by dragging the window to the very edges of other windows/free screen rects)
-   Inverse top screen edge action (by c-ridgway)
-   Multi-monitor: the tile preview will stick to the old monitor when changing monitors for a short period to easier tile quickly on the old monitor (by c-ridgway)
-   Default keybindings with the numpad for tiling (by c-ridgway)
-   Dynamic numbers of layouts & layout selector
-   Add 'User Guide' and 'Changelog' settings tab

### Changed

-   Other minor settings additions/removals/changes
