"use strict";

const {GObject, Gdk, Gtk, Gio} = imports.gi;
const Me = imports.misc.extensionUtils.getCurrentExtension();

const Gettext = imports.gettext;
Gettext.textdomain("tiling-assistant@leleat-on-github");
Gettext.bindtextdomain("tiling-assistant@leleat-on-github", Me.dir.get_child("locale").get_path());
const _ = Gettext.gettext;

function init () {
};

function buildPrefsWidget () {
	let widget = new MyPrefsWidget();
	widget.show_all();
	return widget;
};

const MyPrefsWidget = new GObject.Class({
		Name : "MyTilingPrefsWidget",
		GTypeName : "MyTilingPrefsWidget",
		Extends : Gtk.ScrolledWindow,
	
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
	
			let gtkNotebook = this.builder.get_object('main_prefs');
			this.add(gtkNotebook);

			this.set_min_content_height(700);

			// bind settings to the UI objects
			// make sure the objects in prefs.ui have the same name as the keys in the settings (schema.xml)
			this._settingsSchema.list_keys().forEach(key => {
				let bindProperty = this.getBindProperty(key);
				let builderObject = this.builder.get_object(key);
				if (builderObject != null && bindProperty)
					this.settings.bind(key, builderObject, bindProperty, Gio.SettingsBindFlags.DEFAULT);
			});

			// bind keybindings
			let shortcuts = ["toggle-dash", "half-vertically", "half-horizontally", "replace-window", "tile-maximize", "tile-empty-space", "tile-right-half", "tile-left-half", "tile-top-half", "tile-bottom-half", "tile-bottomleft-quarter", "tile-bottomright-quarter", "tile-topright-quarter", "tile-topleft-quarter",
					"layout1", "layout2", "layout3", "layout4", "layout5", "layout6", "layout7", "layout8", "layout9", "layout10"];
			shortcuts.forEach((sc) => {
				this.makeShortcutEdit(sc);
			});

			// draw Layout rects
			for (let i = 0; i <= 9; i++) {
				let drawArea = this.builder.get_object("DrawArea" + i);
				drawArea.connect("draw", (widget, cr) => {
					let rects = this.getLayoutRects(i);
					let layoutIsValid = this.isLayoutValid(rects);

					if (layoutIsValid) {
						this.drawLayoutRects(widget, cr, rects);

					} else { // TODO error message

					}
				});
			}

			this.builder.get_object("reloadLayoutsButton").connect("clicked", () => {
				for (let i = 0; i <= 9; i++) {
					let drawArea = this.builder.get_object("DrawArea" + i);
					drawArea.queue_draw();
				}
			});

			this.setupTranslations();
		},

		// manually add the keys to the arrays in this function
		getBindProperty: function(key) {
			let ints = ["icon-size", "icon-margin", "window-gaps"];
			let bools = ["enable-dash", "show-label", "use-anim"];

			if (ints.includes(key)) 
				return "value"; // spinbox.value

			else if (bools.includes(key))
				return "active"; //  switch.active

			else
				return null;
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

		// format should be: x--y--width--height where the variables range from 0.0 to 1.0
		// for ex.: 0 -- 0 -- .25 -- 0.75
		// return null, if wrong format
		getLayoutRects: function(layoutIndex) {
			let rects = [];
			let rectProps = ["x", "y", "width", "height"];

			let layoutListBox = this.builder.get_object("LayoutListbox" + layoutIndex)
			for (let i = 0; i < 8; i++) {
				let r = {};

				let entry = layoutListBox.get_row_at_index(i).get_child().get_children()[1];
				if (!entry.get_text_length())
					continue;

				let text = entry.get_text();
				let splits = text.split("--");
				if (splits.length != 4)
					return null;

				for (let j = 0; j < 4; j++) {
					let propValue = parseFloat(splits[j].trim());
					if (Number.isNaN(propValue))
						return null;			

					r[rectProps[j]] = propValue;
				}

				rects.push(r);
			}

			return rects;
		},

		isLayoutValid(rects) {
			// wrong format for rects in Gtk.Entrys
			// or no text in entries
			if (!rects || !rects.length)	
				return false;

			// calculate the surface area of an overlap
			let rectsOverlap = function(r1, r2) {
				return Math.max(0, Math.min(r1.x + r1.width, r2.x + r2.width) - Math.max(r1.x, r2.x)) * Math.max(0, Math.min(r1.y + r1.height, r2.y + r2.height) - Math.max(r1.y, r2.y));
			}

			for (let i = 0, len = rects.length; i < len; i++) {
				let r = rects[i];

				// rects is/reaches outside of screen (i. e. > 1)
				if (r.x < 0 || r.y < 0 || r.width < 0 || r.height < 0 || r.x + r.width > 1 || r.y + r.height > 1)
					return false;

				for (let j = i + 1; j < len; j++) {
					if (rectsOverlap(r, rects[j]))
						return false;
				}
			}

			return true;
		},

		drawLayoutRects: function(layoutWidget, cr, rects) {
			//rects = [{x: 0, y: 0, width: .5, height: .5}]			 
			let color = new Gdk.RGBA();
			let width = layoutWidget.get_allocated_width();
			let height = layoutWidget.get_allocated_height();
			
			cr.setLineWidth(1.0);

			rects.forEach(r => {
				// 1px outline for rect in transparent white
				color.parse("rgba(255, 255, 255, .2)");
				Gdk.cairo_set_source_rgba(cr, color);

				// 5 px gaps between rects
				cr.moveTo(r.x * width + 5, r.y * height + 5);
				cr.lineTo((r.x + r.width) * width - 5, r.y * height + 5);
				cr.lineTo((r.x + r.width) * width - 5, (r.y + r.height) * height - 5);
				cr.lineTo(r.x * width + 5, (r.y + r.height) * height - 5);
				cr.lineTo(r.x * width + 5, r.y * height + 5);
				cr.strokePreserve();
				
				// fill rect in transparent black
				color.parse("rgba(0, 0, 0, .15)");
				Gdk.cairo_set_source_rgba(cr, color);
				cr.fill();
			});
			
			cr.$dispose(); // TODO neccessary?
		},

		setupTranslations: function() {
			// tab labels
			this.builder.get_object("generalLabel").set_text(_("General"));
			this.builder.get_object("keybindingsLabel").set_text(_("Keybindings"));
			this.builder.get_object("layoutsLabel").set_text(_("Layouts"));
			this.builder.get_object("helpLabel").set_text(_("Help"));

			// other settings labels
			this.builder.get_object("label12").set_text(_("Dash icon size"));
			this.builder.get_object("label13").set_text(_("Dash icon margin"));
			this.builder.get_object("label14").set_text(_("Show app name"));
			this.builder.get_object("label15").set_text(_("Enable animations"));
			this.builder.get_object("label2").set_text(_("Gap between tiled windows"));
			this.builder.get_object("label3").set_text(_("Toggle maximization"));
			this.builder.get_object("label20").set_text(_("Tile to top half"));
			this.builder.get_object("label21").set_text(_("Tile to bottom half"));
			this.builder.get_object("label26").set_text(_("Tile to right half"));
			this.builder.get_object("label27").set_text(_("Tile to left half"));
			this.builder.get_object("label22").set_text(_("Tile to top left quarter"));
			this.builder.get_object("label23").set_text(_("Tile to  top right quarter"));
			this.builder.get_object("label24").set_text(_("Tile to bottom left quarter"));
			this.builder.get_object("label25").set_text(_("Tile to bottom right quarter"));
			this.builder.get_object("label1").set_text(_("Tile to empty space"));
			this.builder.get_object("label4").set_text(_("Tile to other tiled window"));
			this.builder.get_object("issueLabel").set_text(_("If you want to report a bug or make a feature request, please open an issue on Github."));
			this.builder.get_object("licenseLabel").set_markup(_("<span size='small'>This extension is licensed under the <a href='https://www.gnu.org/licenses/old-licenses/gpl-2.0.html'>GNU General Public License, version 2 or later</a> and comes with <u><b>NO WARRANTY</b></u>.  A copy of this license can be found in the Github repository.</span>"));

			// tooltips
			this.builder.get_object("listboxrow14").set_tooltip_text(_("Show app names in the dash. Make sure the icons have a sufficient size, if you want to use this setting."));
			this.builder.get_object("listboxrow15").set_tooltip_text(_("Even if this setting is turned off, not all move/resize animations will be disabled. Some are native to GNOME and thus unaffected by this setting."));

			this.builder.get_object("reloadLayoutsButton").set_label(_("Reload"));
		},
});