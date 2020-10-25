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
    Name : "My.Prefs.Widget",
    GTypeName : "MyPrefsWidget",
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
        
        let builder = new Gtk.Builder();
        builder.add_from_file(Me.path + '/prefs.ui');   
    
        this.add(builder.get_object('main_prefs'));

        // bind settings to the UI objects
        // make sure the objects in prefs.ui have the same name as the keys in the settings (schema.xml)
        this._settingsSchema.list_keys().forEach(key => {
            if (builder.get_object(key) != null)
                this.settings.bind(key, builder.get_object(key), this.getBindProperty(key), Gio.SettingsBindFlags.DEFAULT);
        });
    },

    // manually add the keys to the arrays in this function
    getBindProperty : function(key) {
        let ints = ["icon-size", "icon-margin"];
        let strings = [];
        let bools = ["show-label", "use-anim"];

        if (ints.includes(key)) 
            return "value"; // spinbox.value
            
        else if (strings.includes(key))
            return "text"; // entry.text

        else if (bools.includes(key))
            return "active"; //  switch.active
    },
});
