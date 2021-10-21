'use strict';

const { Gio, Gtk, GObject } = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const LayoutPrefs = Me.imports.src.prefs.layoutsPrefs.Prefs;
const { ShortcutWidget } = Me.imports.src.prefs.shortcutWidget;
const { Settings, Shortcuts } = Me.imports.src.common;

function init() {
    ExtensionUtils.initTranslations(Me.metadata.uuid);
}

function buildPrefsWidget() {
    return new PrefsWidget();
}

const PrefsWidget = GObject.registerClass(
class TilingAssistantPrefs extends Gtk.Box {
    _init(params) {
        super._init(params);

        // Use a new settings object instead of the 'global' src.common.Settings
        // class, so we don't have to keep track of the signal connections, which
        // would need cleanup after the prefs window was closed.
        this._settings = ExtensionUtils.getSettings(Me.metadata['settings-schema']);
        this.connect('destroy', () => this._settings.run_dispose());

        this._builder = new Gtk.Builder();
        this._builder.add_from_file(`${Me.path}/src/ui/prefs.ui`);

        const mainPrefs = this._builder.get_object('main-prefs');
        this.append(mainPrefs);

        this._bindSwitches();
        this._bindSpinbuttons();
        this._bindComboBoxes();
        this._bindRadioButtons();
        this._bindKeybindings();

        // LayoutPrefs manages everything related to layouts on the
        // prefs side (including the keyboard shortcuts)
        this._layoutsPrefs = new LayoutPrefs(this._builder, this._settings);

        // Setup titlebar and size
        mainPrefs.connect('realize', () => {
            // Titlebar
            const prefsDialog = mainPrefs.get_root();
            prefsDialog.set_titlebar(this._builder.get_object('titlebar'));

            // Window size
            prefsDialog.set_default_size(600, 750);

            // Info-popup-menu actions
            const actionGroup = new Gio.SimpleActionGroup();
            prefsDialog.insert_action_group('prefs', actionGroup);

            const bugReportAction = new Gio.SimpleAction({ name: 'open-bug-report' });
            bugReportAction.connect('activate', this._openBugReport.bind(this, prefsDialog));
            actionGroup.add_action(bugReportAction);

            const userGuideAction = new Gio.SimpleAction({ name: 'open-user-guide' });
            userGuideAction.connect('activate', this._openUserGuide.bind(this, prefsDialog));
            actionGroup.add_action(userGuideAction);

            const changelogAction = new Gio.SimpleAction({ name: 'open-changelog' });
            changelogAction.connect('activate', this._openChangelog.bind(this, prefsDialog));
            actionGroup.add_action(changelogAction);

            const licenseAction = new Gio.SimpleAction({ name: 'open-license' });
            licenseAction.connect('activate', this._openLicense.bind(this, prefsDialog));
            actionGroup.add_action(licenseAction);

            const hiddenSettingsAction = new Gio.SimpleAction({ name: 'open-hidden-settings' });
            hiddenSettingsAction.connect('activate', this._openHiddenSettings.bind(this));
            actionGroup.add_action(hiddenSettingsAction);
        });

        // Allow the activation of the 'main widget' by clicking a ListBoxRow
        // TODO: port prefs to a Template class as well and get rid of this
        for (let i = 0; i < 20; i++) {
            this._builder.get_object(`listBox${i}`)?.connect('row-activated',
                this._onListBoxRowActivated.bind(this));
        }
    }

    /**
     * Activate the 'main widget' of the row. The row should always have a
     * Gtk.Box as a child. The Gtk.Box should contain the 'main widget'.
     *
     * @param {Gtk.ListBox} listBox
     * @param {Gtk.ListBoxRow} row
     */
    _onListBoxRowActivated(listBox, row) {
        const gtkBox = row.get_first_child();

        for (let child = gtkBox.get_first_child(); !!child; child = child.get_next_sibling()) {
            if (child instanceof Gtk.Switch) {
                child.activate();
                break;
            } else if (child instanceof Gtk.CheckButton) {
                child.activate();
                break;
            } else if (child instanceof Gtk.SpinButton) {
                // Just grab focus since the action to take is ambiguous.
                child.grab_focus();
                break;
            } else if (child instanceof ShortcutWidget) {
                child.activate();
                break;
            } else if (child instanceof Gtk.ComboBox) {
                child.popup_shown ? child.popdown() : child.popup();
                break;
            }
        }
    }

    _openBugReport(prefsDialog) {
        Gio.AppInfo.launch_default_for_uri(
            'https://github.com/Leleat/Tiling-Assistant/issues',
            prefsDialog.get_display().get_app_launch_context()
        );
    }

    _openUserGuide(prefsDialog) {
        Gio.AppInfo.launch_default_for_uri(
            'https://github.com/Leleat/Tiling-Assistant/blob/main/GUIDE.md',
            prefsDialog.get_display().get_app_launch_context()
        );
    }

    _openChangelog(prefsDialog) {
        Gio.AppInfo.launch_default_for_uri(
            'https://github.com/Leleat/Tiling-Assistant/blob/main/CHANGELOG.md',
            prefsDialog.get_display().get_app_launch_context()
        );
    }

    _openLicense(prefsDialog) {
        Gio.AppInfo.launch_default_for_uri(
            'https://github.com/Leleat/Tiling-Assistant/blob/main/LICENSE',
            prefsDialog.get_display().get_app_launch_context()
        );
    }

    _openHiddenSettings() {
        const hiddenSettings = this._builder.get_object('hidden-settings-page');
        hiddenSettings.set_visible(!hiddenSettings.get_visible());
    }

    _bindSwitches() {
        const switches = [
            Settings.ENABLE_TILING_POPUP,
            Settings.POPUP_ALL_WORKSPACES,
            Settings.RAISE_TILE_GROUPS,
            Settings.MAXIMIZE_WITH_GAPS,
            Settings.ENABLE_ADV_EXP_SETTINGS,
            Settings.ENABLE_TILE_ANIMATIONS,
            Settings.ENABLE_UNTILE_ANIMATIONS,
            Settings.ENABLE_HOLD_INVERSE_LANDSCAPE,
            Settings.ENABLE_HOLD_INVERSE_PORTRAIT
        ];

        switches.forEach(key => {
            const widget = this._builder.get_object(key);
            this._settings.bind(key, widget, 'active', Gio.SettingsBindFlags.DEFAULT);
        });
    }

    _bindSpinbuttons() {
        const spinButtons = [
            Settings.WINDOW_GAP,
            Settings.INVERSE_TOP_MAXIMIZE_TIMER,
            Settings.VERTICAL_PREVIEW_AREA,
            Settings.HORIZONTAL_PREVIEW_AREA
        ];

        spinButtons.forEach(key => {
            const widget = this._builder.get_object(key);
            this._settings.bind(key, widget, 'value', Gio.SettingsBindFlags.DEFAULT);
        });
    }

    _bindComboBoxes() {
        const comboBoxes = [
            Settings.SPLIT_TILE_MOD,
            Settings.FIXED_LAYOUT_MOD,
            Settings.RESTORE_SIZE_ON
        ];

        comboBoxes.forEach(key => {
            const widget = this._builder.get_object(key);
            widget.connect('changed', () =>
                this._settings.set_enum(key, widget.get_active()));

            widget.set_active(this._settings.get_enum(key));
        });
    }

    _bindRadioButtons() {
        // These 'radioButtons' are basically just used as a ComboBox with more
        // text. The key is a gsetting (a string) saving the current 'selection',
        // the buttons are the ids of the Gtk.CheckButtons. The button's labels
        // will be used as the options.
        const radioButtons = [
            {
                key: Settings.DYNAMIC_KEYBINDINGS,
                buttonNames: [
                    'dynamic-keybinding-button-disabled',
                    'dynamic-keybinding-button-focus',
                    'dynamic-keybinding-button-tiling-state',
                    'dynamic-keybinding-button-tiling-state-windows'
                ]
            },
            {
                key: Settings.DEFAULT_MOVE_MODE,
                buttonNames: [
                    'edge-tiling-checkbutton',
                    'split-tiles-checkbutton',
                    'fixed-layout-checkbutton'
                ]
            }
        ];

        radioButtons.forEach(({ key, buttonNames }) => {
            const currActive = this._settings.get_string(key);

            buttonNames.forEach(buttonName => {
                const button = this._builder.get_object(buttonName);
                const label = this._builder.get_object(`${buttonName}-label`).get_label();
                button.connect('toggled', () => {
                    this._settings.set_string(key, label);
                });

                if (label === currActive)
                    button.activate();
            });
        });
    }

    _bindKeybindings() {
        const shortcuts = Shortcuts.getAllKeys();
        shortcuts.forEach(key => {
            const shortcutWidget = this._builder.get_object(key);
            shortcutWidget.initialize(key, this._settings);
        });
    }
});
