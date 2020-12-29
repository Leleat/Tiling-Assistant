const {GObject, Gtk, Gio} = imports.gi;
const Me = imports.misc.extensionUtils.getCurrentExtension();

function init () {
}

function buildPrefsWidget () {
	let widget = new MyPrefsWidget();
	widget.show_all();
	return widget;
}

const MyPrefsWidget = new GObject.Class({
		Name : "MyTilingPrefsWidget",
		GTypeName : "MyTilingPrefsWidget",
		Extends : Gtk.Box, // or ScrolledWindow if this gets too big
	
		_init : function (params) {
			let gschema = Gio.SettingsSchemaSource.new_from_directory(
				Me.dir.get_child('schemas').get_path(),
				Gio.SettingsSchemaSource.get_default(),
				false
			);

			this._settingsSchema = gschema.lookup("org.gnome.shell.extensions.tiling-assistant", true);
			this.settings = new Gio.Settings({
				settings_schema: this._settingsSchema
			});
	
			this.parent(params);
			
			this.builder = new Gtk.Builder();
			this.builder.add_from_file(Me.path + '/prefs.ui');   
	
			this.add(this.builder.get_object('main_prefs'));

			// bind settings to the UI objects
			// make sure the objects in prefs.ui have the same name as the keys in the settings (schema.xml)
			this._settingsSchema.list_keys().forEach(key => {
				let bindProperty = this.getBindProperty(key);
				let builderObject = this.builder.get_object(key);
				if (builderObject != null && bindProperty)
					this.settings.bind(key, builderObject, bindProperty, Gio.SettingsBindFlags.DEFAULT);
			});

			let shortcuts = ["replace-window", "tile-maximize", "tile-empty-space", "tile-right-half", "tile-left-half", "tile-top-half", "tile-bottom-half", "tile-bottomleft-quarter", "tile-bottomright-quarter", "tile-topright-quarter", "tile-topleft-quarter"];
			shortcuts.forEach((sc) => {
				this.makeShortcutEdit(sc);
			});
		},

		// taken from Overview-Improved by human.experience
		// https://extensions.gnome.org/extension/2802/overview-improved/
		makeShortcutEdit: function(settingKey) {
			const COLUMN_KEY = 0;
			const COLUMN_MODS = 1;

			const view = this.builder.get_object(settingKey + "-treeview");
			const store = this.builder.get_object(settingKey + "-liststore");
			const iter = store.append();
			const renderer = new Gtk.CellRendererAccel({ editable: true });
			const column = new Gtk.TreeViewColumn();
			column.pack_start(renderer, true);
			column.add_attribute(renderer, "accel-key", COLUMN_KEY);
			column.add_attribute(renderer, "accel-mods", COLUMN_MODS);
			view.append_column(column);

			const updateShortcutRow = (accel) => {
				const [key, mods] = accel ? Gtk.accelerator_parse(accel) : [0, 0];
				store.set(iter, [COLUMN_KEY, COLUMN_MODS], [key, mods]);
			};

			renderer.connect("accel-edited", (renderer, path, key, mods, hwCode) => {
				const accel = Gtk.accelerator_name(key, mods);
				updateShortcutRow(accel);
				this.settings.set_strv(settingKey, [accel]);
			});

			renderer.connect("accel-cleared", () => {
				updateShortcutRow(null);
				this.settings.set_strv(settingKey, []);
			});

			this.settings.connect("changed::" + settingKey, () => {
				updateShortcutRow(this.settings.get_strv(settingKey)[0]);
			});

			updateShortcutRow(this.settings.get_strv(settingKey)[0]);
		},

		// manually add the keys to the arrays in this function
		getBindProperty: function(key) {
			let ints = ["icon-size", "icon-margin", "window-gaps"];
			let bools = ["show-label", "use-anim"];

			if (ints.includes(key)) 
				return "value"; // spinbox.value

			else if (bools.includes(key))
				return "active"; //  switch.active

			else
				return null;
		},
});