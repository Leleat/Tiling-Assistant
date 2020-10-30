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

        // shortcut configuration taken from drop-down-terminal@gs-extensions.zzrough.org - https://extensions.gnome.org/extension/442/drop-down-terminal/
        // settings name for shortcut
        this.TILE_TOP_HALF_SETTING = "tile-top-half";
        this.TILE_LEFT_SETTING = "tile-left-half";
        this.TILE_RIGHT_SETTING = "tile-right-half";
        this.TILE_BOTTOM_HALF_SETTING = "tile-bottom-half";
        this.TILE_TOP_LEFT_SETTING = "tile-topleft-quarter";
        this.TILE_TOP_RIGHT_SETTING = "tile-topright-quarter";
        this.TILE_BOTTOM_LEFT_SETTING = "tile-bottomleft-quarter";
        this.TILE_BOTTOM_RIGHT_SETTING = "tile-bottomright-quarter";
 
        this.configureShortcutTreeView(builder);
        
        this.topHalfListStore = builder.get_object("top-half-liststore");
        this.leftHalfListStore = builder.get_object("left-liststore");
        this.rightHalfListStore = builder.get_object("right-liststore");
        this.bottomHalfListStore = builder.get_object("bottom-half-liststore");
        this.topLeftListStore = builder.get_object("top-left-liststore");
        this.topRightListStore = builder.get_object("top-right-liststore");
        this.bottomLeftListStore = builder.get_object("bottom-left-liststore");
        this.bottomRightListStore = builder.get_object("bottom-right-liststore");

        this.tileTopHalfRow = this.topHalfListStore.append();
        this.tileBottomHalfRow = this.bottomHalfListStore.append();
        this.tileTopLeftRow = this.topLeftListStore.append();
        this.tileTopRightRow = this.topRightListStore.append();
        this.tileBottomLeftRow = this.bottomLeftListStore.append();
        this.tileBottomRightRow = this.bottomRightListStore.append();
        this.tileLeftRow = this.leftHalfListStore.append();
        this.tileRightRow = this.rightHalfListStore.append();

        this.updateShortcutRow(this.settings.get_strv(this.TILE_TOP_HALF_SETTING)[0], this.TILE_TOP_HALF_SETTING);
        this.updateShortcutRow(this.settings.get_strv(this.TILE_BOTTOM_HALF_SETTING)[0], this.TILE_BOTTOM_HALF_SETTING);
        this.updateShortcutRow(this.settings.get_strv(this.TILE_TOP_LEFT_SETTING)[0], this.TILE_TOP_LEFT_SETTING);
        this.updateShortcutRow(this.settings.get_strv(this.TILE_TOP_RIGHT_SETTING)[0], this.TILE_TOP_RIGHT_SETTING);
        this.updateShortcutRow(this.settings.get_strv(this.TILE_BOTTOM_LEFT_SETTING)[0], this.TILE_BOTTOM_LEFT_SETTING);
        this.updateShortcutRow(this.settings.get_strv(this.TILE_BOTTOM_RIGHT_SETTING)[0], this.TILE_BOTTOM_RIGHT_SETTING);
        this.updateShortcutRow(this.settings.get_strv(this.TILE_LEFT_SETTING)[0], this.TILE_LEFT_SETTING);
        this.updateShortcutRow(this.settings.get_strv(this.TILE_RIGHT_SETTING)[0], this.TILE_RIGHT_SETTING);
    },

    configureShortcutTreeView: function(builder) {
        let treeView = builder.get_object("tile-top-half-treeview");

        let renderer = new Gtk.CellRendererAccel({editable: true});
        renderer.connect("accel-edited", this.onShortcutAccelEdited.bind(this));
        renderer.connect("accel-cleared", this.onShortcutAccelCleared.bind(this));

        let column = new Gtk.TreeViewColumn();
        column.pack_start(renderer, true);
        column.add_attribute(renderer, "accel-key", 0);
        column.add_attribute(renderer, "accel-mods", 1);

        treeView.append_column(column);

        //

        let treeView2 = builder.get_object("tile-bottom-half-treeview");

        let renderer2 = new Gtk.CellRendererAccel({editable: true});
        renderer2.connect("accel-edited", this.onShortcutAccelEdited2.bind(this));
        renderer2.connect("accel-cleared", this.onShortcutAccelCleared2.bind(this));

        let column2 = new Gtk.TreeViewColumn();
        column2.pack_start(renderer2, true);
        column2.add_attribute(renderer2, "accel-key", 0);
        column2.add_attribute(renderer2, "accel-mods", 1);

        treeView2.append_column(column2);

        //

        let treeView3 = builder.get_object("tile-top-left-treeview");

        let renderer3 = new Gtk.CellRendererAccel({editable: true});
        renderer3.connect("accel-edited", this.onShortcutAccelEdited3.bind(this));
        renderer3.connect("accel-cleared", this.onShortcutAccelCleared3.bind(this));

        let column3 = new Gtk.TreeViewColumn();
        column3.pack_start(renderer3, true);
        column3.add_attribute(renderer3, "accel-key", 0);
        column3.add_attribute(renderer3, "accel-mods", 1);

        treeView3.append_column(column3);

        //

        let treeView4 = builder.get_object("tile-top-right-treeview");

        let renderer4 = new Gtk.CellRendererAccel({editable: true});
        renderer4.connect("accel-edited", this.onShortcutAccelEdited4.bind(this));
        renderer4.connect("accel-cleared", this.onShortcutAccelCleared4.bind(this));

        let column4 = new Gtk.TreeViewColumn();
        column4.pack_start(renderer4, true);
        column4.add_attribute(renderer4, "accel-key", 0);
        column4.add_attribute(renderer4, "accel-mods", 1);

        treeView4.append_column(column4);

        //

        let treeView5 = builder.get_object("tile-bottom-left-treeview");

        let renderer5 = new Gtk.CellRendererAccel({editable: true});
        renderer5.connect("accel-edited", this.onShortcutAccelEdited5.bind(this));
        renderer5.connect("accel-cleared", this.onShortcutAccelCleared5.bind(this));

        let column5 = new Gtk.TreeViewColumn();
        column5.pack_start(renderer5, true);
        column5.add_attribute(renderer5, "accel-key", 0);
        column5.add_attribute(renderer5, "accel-mods", 1);

        treeView5.append_column(column5);

        //

        let treeView6 = builder.get_object("tile-bottom-right-treeview");

        let renderer6 = new Gtk.CellRendererAccel({editable: true});
        renderer6.connect("accel-edited", this.onShortcutAccelEdited6.bind(this));
        renderer6.connect("accel-cleared", this.onShortcutAccelCleared6.bind(this));

        let column6 = new Gtk.TreeViewColumn();
        column6.pack_start(renderer6, true);
        column6.add_attribute(renderer6, "accel-key", 0);
        column6.add_attribute(renderer6, "accel-mods", 1);

        treeView6.append_column(column6);

        //

        let treeView7 = builder.get_object("tile-right-treeview");

        let renderer7 = new Gtk.CellRendererAccel({editable: true});
        renderer7.connect("accel-edited", this.onShortcutAccelEdited7.bind(this));
        renderer7.connect("accel-cleared", this.onShortcutAccelCleared7.bind(this));

        let column7 = new Gtk.TreeViewColumn();
        column7.pack_start(renderer7, true);
        column7.add_attribute(renderer7, "accel-key", 0);
        column7.add_attribute(renderer7, "accel-mods", 1);

        treeView7.append_column(column7);

        //

        let treeView8 = builder.get_object("tile-left-treeview");

        let renderer8 = new Gtk.CellRendererAccel({editable: true});
        renderer8.connect("accel-edited", this.onShortcutAccelEdited8.bind(this));
        renderer8.connect("accel-cleared", this.onShortcutAccelCleared8.bind(this));

        let column8 = new Gtk.TreeViewColumn();
        column8.pack_start(renderer8, true);
        column8.add_attribute(renderer8, "accel-key", 0);
        column8.add_attribute(renderer8, "accel-mods", 1);

        treeView8.append_column(column8);
    },
    
    onShortcutAccelEdited: function(renderer, path, key, mods, hwCode) {
        let accel = Gtk.accelerator_name(key, mods);
        this.updateShortcutRow(accel, this.TILE_TOP_HALF_SETTING);

        this.settings.set_strv(this.TILE_TOP_HALF_SETTING, [accel]);
    },

    onShortcutAccelEdited2: function(renderer, path, key, mods, hwCode) {
        let accel = Gtk.accelerator_name(key, mods);
        this.updateShortcutRow(accel, this.TILE_BOTTOM_HALF_SETTING);

        this.settings.set_strv(this.TILE_BOTTOM_HALF_SETTING, [accel]);
    },

    onShortcutAccelEdited3: function(renderer, path, key, mods, hwCode) {
        let accel = Gtk.accelerator_name(key, mods);
        this.updateShortcutRow(accel, this.TILE_TOP_LEFT_SETTING);

        this.settings.set_strv(this.TILE_TOP_LEFT_SETTING, [accel]);
    },

    onShortcutAccelEdited4: function(renderer, path, key, mods, hwCode) {
        let accel = Gtk.accelerator_name(key, mods);
        this.updateShortcutRow(accel, this.TILE_TOP_RIGHT_SETTING);

        this.settings.set_strv(this.TILE_TOP_RIGHT_SETTING, [accel]);
    },

    onShortcutAccelEdited5: function(renderer, path, key, mods, hwCode) {
        let accel = Gtk.accelerator_name(key, mods);
        this.updateShortcutRow(accel, this.TILE_BOTTOM_LEFT_SETTING);

        this.settings.set_strv(this.TILE_BOTTOM_LEFT_SETTING, [accel]);
    },

    onShortcutAccelEdited6: function(renderer, path, key, mods, hwCode) {
        let accel = Gtk.accelerator_name(key, mods);
        this.updateShortcutRow(accel, this.TILE_BOTTOM_RIGHT_SETTING);

        this.settings.set_strv(this.TILE_BOTTOM_RIGHT_SETTING, [accel]);
    },

    onShortcutAccelEdited7: function(renderer, path, key, mods, hwCode) {
        let accel = Gtk.accelerator_name(key, mods);
        this.updateShortcutRow(accel, this.TILE_RIGHT_SETTING);

        this.settings.set_strv(this.TILE_RIGHT_SETTING, [accel]);
    },

    onShortcutAccelEdited8: function(renderer, path, key, mods, hwCode) {
        let accel = Gtk.accelerator_name(key, mods);
        this.updateShortcutRow(accel, this.TILE_LEFT_SETTING);

        this.settings.set_strv(this.TILE_LEFT_SETTING, [accel]);
    },

    onShortcutAccelCleared: function(renderer, path) {
        this.updateShortcutRow(null, this.TILE_TOP_HALF_SETTING);
        this.settings.set_strv(this.TILE_TOP_HALF_SETTING, []);
    },

    onShortcutAccelCleared2: function(renderer, path) {
        this.updateShortcutRow(null, this.TILE_BOTTOM_HALF_SETTING);
        this.settings.set_strv(this.TILE_BOTTOM_HALF_SETTING, []);
    },

    onShortcutAccelCleared3: function(renderer, path) {
        this.updateShortcutRow(null, this.TILE_TOP_LEFT_SETTING);
        this.settings.set_strv(this.TILE_TOP_LEFT_SETTING, []);
    },

    onShortcutAccelCleared4: function(renderer, path) {
        this.updateShortcutRow(null, this.TILE_TOP_RIGHT_SETTING);
        this.settings.set_strv(this.TILE_TOP_RIGHT_SETTING, []);
    },

    onShortcutAccelCleared5: function(renderer, path) {
        this.updateShortcutRow(null, this.TILE_BOTTOM_LEFT_SETTING);
        this.settings.set_strv(this.TILE_BOTTOM_LEFT_SETTING, []);
    },

    onShortcutAccelCleared6: function(renderer, path) {
        this.updateShortcutRow(null, this.TILE_BOTTOM_RIGHT_SETTING);
        this.settings.set_strv(this.TILE_BOTTOM_RIGHT_SETTING, []);
    },

    onShortcutAccelCleared7: function(renderer, path) {
        this.updateShortcutRow(null, this.TILE_RIGHT_SETTING);
        this.settings.set_strv(this.TILE_RIGHT_SETTING, []);
    },

    onShortcutAccelCleared8: function(renderer, path) {
        this.updateShortcutRow(null, this.TILE_LEFT_SETTING);
        this.settings.set_strv(this.TILE_LEFT_SETTING, []);
    },

    updateShortcutRow: function(accel, settingsName) {
        let [key, mods] = (accel !== null) ? Gtk.accelerator_parse(accel) : [0, 0];

        switch (settingsName) {
            case this.TILE_TOP_HALF_SETTING: 
                this.topHalfListStore.set(this.tileTopHalfRow, [0, 1], [key, mods]);
                break;

            case this.TILE_BOTTOM_HALF_SETTING: 
                this.bottomHalfListStore.set(this.tileBottomHalfRow, [0, 1], [key, mods]);
                break;

            case this.TILE_TOP_LEFT_SETTING: 
                this.topLeftListStore.set(this.tileTopLeftRow, [0, 1], [key, mods]);
                break;

            case this.TILE_TOP_RIGHT_SETTING: 
                this.topRightListStore.set(this.tileTopRightRow, [0, 1], [key, mods]);
                break;

            case this.TILE_BOTTOM_LEFT_SETTING: 
                this.bottomLeftListStore.set(this.tileBottomLeftRow, [0, 1], [key, mods]);
                break;

            case this.TILE_BOTTOM_RIGHT_SETTING: 
                this.bottomRightListStore.set(this.tileBottomRightRow, [0, 1], [key, mods]);
                break;

            case this.TILE_RIGHT_SETTING: 
                this.rightHalfListStore.set(this.tileRightRow, [0, 1], [key, mods]);
                break;

            case this.TILE_LEFT_SETTING: 
                this.leftHalfListStore.set(this.tileLeftRow, [0, 1], [key, mods]);
                break;
        }
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
