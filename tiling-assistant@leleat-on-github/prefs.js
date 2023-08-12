import { Gdk, Gio, GLib, Gtk } from './src/dependencies/prefs/gi.js';
import { ExtensionPreferences } from './src/dependencies/prefs.js';

import LayoutPrefs from './src/prefs/layoutsPrefs.js';
import { Settings, Shortcuts } from './src/common.js';
// eslint-disable-next-line no-unused-vars
import { ShortcutListener } from './src/prefs/shortcutListener.js';

export default class Prefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        // Load css file
        const provider = new Gtk.CssProvider();
        const path = GLib.build_filenamev([this.path, 'stylesheet.css']);
        provider.load_from_path(path);
        Gtk.StyleContext.add_provider_for_display(
            Gdk.Display.get_default(),
            provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        );

        window.set_can_navigate_back(true);

        const settings = this.getSettings();
        const builder = new Gtk.Builder();
        builder.set_translation_domain(this.uuid);
        builder.add_from_file(`${this.path}/src/ui/prefs.ui`);

        // Add general preference page
        window.add(builder.get_object('general'));

        // Add keybindings preference page
        window.add(builder.get_object('keybindings'));

        // Add layouts preference page on condition of advanced setting
        const layoutsPage = builder.get_object('layouts');
        settings.connect(`changed::${Settings.ENABLE_ADV_EXP_SETTINGS}`, () => {
            settings.get_boolean(Settings.ENABLE_ADV_EXP_SETTINGS)
                ? window.add(layoutsPage)
                : window.remove(layoutsPage);
        });

        if (settings.get_boolean(Settings.ENABLE_ADV_EXP_SETTINGS))
            window.add(layoutsPage);

        // Bind settings to GUI
        this._bindSwitches(settings, builder);
        this._bindSpinbuttons(settings, builder);
        this._bindComboRows(settings, builder);
        this._bindRadioButtons(settings, builder);
        this._bindKeybindings(settings, builder);
        this._bindColorButtons(settings, builder);

        // LayoutPrefs manages everything related to layouts on the
        // prefs side (including the keyboard shortcuts)
        new LayoutPrefs(settings, builder, this.path);

        // Set visibility for deprecated settings
        this._setDeprecatedSettings(settings, builder);

        // Add a button into the headerbar with info
        this._addHeaderBarInfoButton(window, settings, builder);
    }

    /*
    * Bind GUI switches to settings.
    */
    _bindSwitches(settings, builder) {
        const switches = [
            Settings.ENABLE_TILING_POPUP,
            Settings.POPUP_ALL_WORKSPACES,
            Settings.RAISE_TILE_GROUPS,
            Settings.TILEGROUPS_IN_APP_SWITCHER,
            Settings.MAXIMIZE_WITH_GAPS,
            Settings.SHOW_LAYOUT_INDICATOR,
            Settings.ENABLE_ADV_EXP_SETTINGS,
            Settings.DISABLE_TILE_GROUPS,
            Settings.LOW_PERFORMANCE_MOVE_MODE,
            Settings.MONITOR_SWITCH_GRACE_PERIOD,
            Settings.ADAPT_EDGE_TILING_TO_FAVORITE_LAYOUT,
            Settings.ENABLE_TILE_ANIMATIONS,
            Settings.ENABLE_UNTILE_ANIMATIONS,
            Settings.ENABLE_HOLD_INVERSE_LANDSCAPE,
            Settings.ENABLE_HOLD_INVERSE_PORTRAIT
        ];

        switches.forEach(key => {
            const widget = builder.get_object(key.replaceAll('-', '_'));
            settings.bind(key, widget, 'active', Gio.SettingsBindFlags.DEFAULT);
        });
    }

    /*
    * Bind GUI spinbuttons to settings.
    */
    _bindSpinbuttons(settings, builder) {
        const spinButtons = [
            Settings.WINDOW_GAP,
            Settings.SINGLE_SCREEN_GAP,
            Settings.SCREEN_TOP_GAP,
            Settings.SCREEN_LEFT_GAP,
            Settings.SCREEN_RIGHT_GAP,
            Settings.SCREEN_BOTTOM_GAP,
            Settings.ACTIVE_WINDOW_HINT_BORDER_SIZE,
            Settings.ACTIVE_WINDOW_HINT_INNER_BORDER_SIZE,
            Settings.INVERSE_TOP_MAXIMIZE_TIMER,
            Settings.VERTICAL_PREVIEW_AREA,
            Settings.HORIZONTAL_PREVIEW_AREA
        ];

        spinButtons.forEach(key => {
            const widget = builder.get_object(key.replaceAll('-', '_'));
            settings.bind(key, widget, 'value', Gio.SettingsBindFlags.DEFAULT);
        });
    }

    /*
    * Bind GUI AdwComboRows to settings.
    */
    _bindComboRows(settings, builder) {
        const comboRows = [
            Settings.ADAPTIVE_TILING_MOD,
            Settings.FAVORITE_LAYOUT_MOD,
            Settings.IGNORE_TA_MOD,
            Settings.RESTORE_SIZE_ON
        ];

        comboRows.forEach(key => {
            const widget = builder.get_object(key.replaceAll('-', '_'));
            settings.bind(key, widget, 'selected', Gio.SettingsBindFlags.DEFAULT);
            widget.set_selected(settings.get_int(key));
        });
    }

    /*
    * Bind GUI color buttons to settings.
    */
    _bindColorButtons(settings, builder) {
        const switches = [
            Settings.ACTIVE_WINDOW_HINT_COLOR
        ];

        switches.forEach(key => {
            const widget = builder.get_object(`${key.replaceAll('-', '_')}_button`);
            widget.connect('color-set', () => {
                settings.set_string(key, widget.get_rgba().to_string());
            });

            // initilaize color
            const rgba = new Gdk.RGBA();
            rgba.parse(settings.get_string(key));
            widget.set_rgba(rgba);
        });
    }

    /*
    * Bind radioButtons to settings.
    */
    _bindRadioButtons(settings, builder) {
        // These 'radioButtons' are basically just used as a 'fake ComboBox' with
        // explanations for the different options. So there is just *one* gsetting
        // (an int) which saves the current 'selection'.
        const radioButtons = [
            {
                key: Settings.DYNAMIC_KEYBINDINGS,
                rowNames: [
                    'dynamic_keybinding_disabled_row',
                    'dynamic_keybinding_window_focus_row',
                    'dynamic_keybinding_tiling_state_row',
                    'dynamic_keybinding_tiling_state_windows_row',
                    'dynamic_keybinding_favorite_layout_row'
                ]
            },
            {
                key: Settings.ACTIVE_WINDOW_HINT,
                rowNames: [
                    'active_window_hint_disabled_row',
                    'active_window_hint_minimal_row',
                    'active_window_hint_always_row'
                ]
            },
            {
                key: Settings.DEFAULT_MOVE_MODE,
                rowNames: [
                    'edge_tiling_row',
                    'adaptive_tiling_row',
                    'favorite_layout_row',
                    'ignore_ta_row'
                ]
            }
        ];

        radioButtons.forEach(({ key, rowNames }) => {
            const currActive = settings.get_int(key);

            rowNames.forEach((name, idx) => {
                const row = builder.get_object(name.replaceAll('-', '_'));
                const checkButton = row.activatable_widget;
                checkButton.connect('toggled', () => settings.set_int(key, idx));

                // Set initial state
                if (idx === currActive)
                    checkButton.activate();
            });
        });
    }

    /*
    * Bind keybinding widgets to settings.
    */
    _bindKeybindings(settings, builder) {
        const shortcuts = Shortcuts.getAllKeys();
        shortcuts.forEach(key => {
            const shortcut = builder.get_object(key.replaceAll('-', '_'));
            shortcut.initialize(key, settings);
        });
    }

    /**
     * Sets the visibility of deprecated settings. Those setting aren't visible
     * in the GUI unless they have a user set value. That means they aren't
     * discoverable through the GUI and need to first be set with the gsetting.
     * The normal rows should have the id of: GSETTING_WITH_UNDERSCORES_row.
     * ShortcutListeners have the format of GSETTING_WITH_UNDERSCORES.
     */
    _setDeprecatedSettings(settings, builder) {
        // Keybindings
        ['toggle-tiling-popup', 'auto-tile'].forEach(s => {
            const isNonDefault = settings.get_strv(s)[0] !== settings.get_default_value(s).get_strv()[0];
            builder.get_object(s.replaceAll('-', '_')).set_visible(isNonDefault);
        });

        // Switches
        ['tilegroups-in-app-switcher'].forEach(s => {
            const isNonDefault = settings.get_boolean(s) !== settings.get_default_value(s).get_boolean();
            builder.get_object(`${s.replaceAll('-', '_')}_row`).set_visible(isNonDefault);
        });
    }

    _addHeaderBarInfoButton(window, settings, builder) {
        // Add headerBar button for menu
        // TODO: is this a 'reliable' method to access the headerbar?
        const page = builder.get_object('general');
        const gtkStack = page
            .get_parent()
            .get_parent()
            .get_parent();
        const adwHeaderBar = gtkStack
            .get_next_sibling()
            .get_first_child()
            .get_first_child()
            .get_first_child();

        adwHeaderBar.pack_start(builder.get_object('info_menu'));

        // Setup menu actions
        const actionGroup = new Gio.SimpleActionGroup();
        window.insert_action_group('prefs', actionGroup);

        const bugReportAction = new Gio.SimpleAction({ name: 'open-bug-report' });
        bugReportAction.connect('activate', this._openBugReport.bind(this, window));
        actionGroup.add_action(bugReportAction);

        const userGuideAction = new Gio.SimpleAction({ name: 'open-user-guide' });
        userGuideAction.connect('activate', this._openUserGuide.bind(this, window));
        actionGroup.add_action(userGuideAction);

        const changelogAction = new Gio.SimpleAction({ name: 'open-changelog' });
        changelogAction.connect('activate', this._openChangelog.bind(this, window));
        actionGroup.add_action(changelogAction);

        const licenseAction = new Gio.SimpleAction({ name: 'open-license' });
        licenseAction.connect('activate', this._openLicense.bind(this, window));
        actionGroup.add_action(licenseAction);

        const hiddenSettingsAction = new Gio.SimpleAction({ name: 'open-hidden-settings' });
        hiddenSettingsAction.connect('activate', this._openHiddenSettings.bind(this, window, builder));
        actionGroup.add_action(hiddenSettingsAction);

        // Button to return to main settings page
        const returnButton = builder.get_object('hidden_settings_return_button');
        returnButton.connect('clicked', () => window.close_subpage());
    }

    _openBugReport(window) {
        Gtk.show_uri(window, 'https://github.com/Leleat/Tiling-Assistant/issues', Gdk.CURRENT_TIME);
    }

    _openUserGuide(window) {
        Gtk.show_uri(window, 'https://github.com/Leleat/Tiling-Assistant/wiki', Gdk.CURRENT_TIME);
    }

    _openChangelog(window) {
        Gtk.show_uri(window, 'https://github.com/Leleat/Tiling-Assistant/blob/main/CHANGELOG.md', Gdk.CURRENT_TIME);
    }

    _openLicense(window) {
        Gtk.show_uri(window, 'https://github.com/Leleat/Tiling-Assistant/blob/main/LICENSE', Gdk.CURRENT_TIME);
    }

    _openHiddenSettings(window, builder) {
        const hiddenSettingsPage = builder.get_object('hidden_settings');
        window.present_subpage(hiddenSettingsPage);
    }
}
