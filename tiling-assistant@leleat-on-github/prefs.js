"use strict";

const {Gdk, Gio, GLib, Gtk, GObject} = imports.gi;
const Me = imports.misc.extensionUtils.getCurrentExtension();
const shellVersion = parseFloat(imports.misc.config.PACKAGE_VERSION);

function init() {
};

function buildPrefsWidget() {
	const widget = new MyPrefsWidget();
	shellVersion < 40 && widget.show_all();
	return widget;
};

const MyPrefsWidget = new GObject.Class({
	Name : "MyTilingPrefsWidget",
	GTypeName : "MyTilingPrefsWidget",
	Extends : Gtk.ScrolledWindow,

	_init: function(params) {
		const gschema = Gio.SettingsSchemaSource.new_from_directory(
			Me.dir.get_child("schemas").get_path(),
			Gio.SettingsSchemaSource.get_default(),
			false
		);

		const settingsSchema = gschema.lookup("org.gnome.shell.extensions.tiling-assistant", true);
		this.settings = new Gio.Settings({settings_schema: settingsSchema});

		this.parent(params);

		this.builder = new Gtk.Builder();
		this.builder.add_from_file(Me.path + "/prefs.ui");
		const mainPrefs = this.builder.get_object("main_prefs");
		shellVersion < 40 ? this.add(mainPrefs) : this.set_child(mainPrefs);

		this.set_min_content_height(700);

		this.bindWidgetsToSettings(settingsSchema.list_keys());
		this.bindKeybindings();

		this.setupLayoutsGUI();
		this.loadLayouts();
	},

	bindWidgetsToSettings: function(settingsKeys) {
		// widgets in prefs.ui need to have same ID
		// as the keys in the gschema.xml file
		const getBindProperty = function(key) {
			const ints = ["icon-size", "icon-margin", "window-gaps"];
			const bools = ["enable-dash", "use-anim"];

			if (ints.includes(key))
				return "value"; // Gtk.Spinbox.value
			else if (bools.includes(key))
				return "active"; //  Gtk.Switch.active
			else
				return null;
		}

		settingsKeys.forEach(key => {
			const bindProperty = getBindProperty(key);
			const widget = this.builder.get_object(key);
			if (widget && bindProperty)
				this.settings.bind(key, widget, bindProperty, Gio.SettingsBindFlags.DEFAULT);
		});
	},

	bindKeybindings: function() {
		const shortcuts = ["toggle-dash", "replace-window", "tile-maximize", "tile-empty-space",
				"tile-right-half", "tile-left-half", "tile-top-half", "tile-bottom-half",
				"tile-bottomleft-quarter", "tile-bottomright-quarter", "tile-topright-quarter", "tile-topleft-quarter",
				"layout1", "layout2", "layout3", "layout4", "layout5", "layout6", "layout7", "layout8", "layout9", "layout10"];
		shortcuts.forEach(sc => this._makeShortcutEdit(sc));
	},

	// taken from Overview-Improved by human.experience
	// https://extensions.gnome.org/extension/2802/overview-improved/
	_makeShortcutEdit: function(settingKey) {
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
			// compatibility GNOME 40: GTK4's func returns 3 values / GTK3's only 2
			const array = accel ? Gtk.accelerator_parse(accel) : [0, 0];
			const [key, mods] = [array[array.length - 2], array[array.length - 1]];
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

	// this.layouts is an array of arrays. The inner arrays contain "rects" in the format:
	// {x: NR, y: NR, width: NR, height: NR} -> NR is a float between 0 to 1.
	// the user defines the rects via Gtk.Entrys in the format xVal--yVal--widthVal--heightVal.
	setupLayoutsGUI: function() {
		// layout reload button
		this.builder.get_object("reloadLayoutsButton").connect("clicked", () => {
			this.loadLayouts();
		});

		// layout save button
		this.builder.get_object("saveLayoutsButton").connect("clicked", () => {
			this._saveLayouts();
			this.loadLayouts();
		});

		// Nr of layouts is "hardcoded" (i. e. 10 layouts)
		for (let i = 0; i < 10; i++) {
			// delete buttons: resets a layout's Gtk.Entries
			this.builder.get_object(`deleteLayoutButton${i}`).connect("clicked", () => {
				const layoutListBox = this.builder.get_object(`LayoutListbox${i}`);
				for (let j = 0; j < 8; j++) // 8 Gtk.entries / possible rects in a layout
					this._setEntryText(this._getChildAtIndex(layoutListBox.get_row_at_index(j).get_child(), 1), "");
			});

			// draw preview rects in the right column
			const drawArea = this.builder.get_object(`DrawArea${i}`);
			if (shellVersion < 40)
				drawArea.connect("draw", (widget, cr) => this._drawLayoutsRects(i, widget, cr));
			else
				drawArea.set_draw_func(this._drawLayoutsRects.bind(this, [i]));
		}
	},

	// load from ~/.TilingAssistantExtension.layouts.json
	loadLayouts: function() {
		const path = GLib.build_filenamev([GLib.get_home_dir(), ".TilingAssistantExtension.layouts.json"]);
		const file = Gio.File.new_for_path(path);

		try {
			file.create(Gio.FileCreateFlags.NONE, null);
		} catch (e) {

		}

		const [success, contents] = file.load_contents(null);
		if (!success)
			return;

		if (!contents.length)
			return;

		// reset layout's entries' text
		for (let i = 0; i < 10; i++) {
			const layoutListBox = this.builder.get_object(`LayoutListbox${i}`);
			for (let j = 0; j < 8; j++)
				this._setEntryText(this._getChildAtIndex(layoutListBox.get_row_at_index(j).get_child(), 1), "");
		}

		// set text for Gtk.entries
		this.layouts = JSON.parse(contents);
		this.layouts.forEach((layout, index) => {
			const layoutListBox = this.builder.get_object(`LayoutListbox${index}`);
			layout.forEach((rect, idx) => this._setEntryText(
					this._getChildAtIndex(layoutListBox.get_row_at_index(idx).get_child(), 1),
					`${rect.x}--${rect.y}--${rect.width}--${rect.height}`
			));
		});

		// redraw layout previews
		for (let idx = 0; idx < 10; idx++) {
			const layout = this.layouts[idx];
			const [layoutIsValid, errMsg] = this._layoutIsValid(layout);

			const drawArea = this.builder.get_object(`DrawArea${idx}`);
			const gtkOverlay = drawArea.get_parent().get_parent();
			const errorLabel = this._getChildAtIndex(gtkOverlay, 1);
			drawArea.queue_draw();

			if (layoutIsValid)
				errorLabel && (shellVersion < 40 ? gtkOverlay.remove(errorLabel)
						: gtkOverlay.remove_overlay(errorLabel));
			else
				errorLabel ? errorLabel.set_text(errMsg)
						: gtkOverlay.add_overlay(new Gtk.Label({
							label: errMsg,
							halign:  Gtk.Align.CENTER,
							valign:  Gtk.Align.CENTER,
							visible: true,
							wrap: true
						}));
		}
	},

	// save to ~/.TilingAssistantExtension.layouts.json
	_saveLayouts: function() {
		const allLayouts = [];
		const props = ["x", "y", "width", "height"];

		// for each layout
		for (let i = 0; i < 10; i++) {
			const layout = [];
			const layoutListBox = this.builder.get_object(`LayoutListbox${i}`);

			// for each rect in *a* layout
			for (let j = 0; j < 8; j++) {
				const rect = {};
				const entry = this._getChildAtIndex(layoutListBox.get_row_at_index(j).get_child(), 1);
				if (!entry.get_text_length())
					continue;

				const text = shellVersion < 40 ? entry.get_text() : entry.get_buffer().get_text();
				const splits = text.split("--");
				if (splits.length !== 4) {
					layout.push({x: 0, y: 0, width: 0, height: 0});
					continue;
				}

				for (let k = 0; k < 4; k++) {
					const value = parseFloat(splits[k].trim());
					if (Number.isNaN(value)) {
						layout.push({x: 0, y: 0, width: 0, height: 0});
						continue;
					}

					rect[props[k]] = value;
				}

				layout.push(rect);
			}

			allLayouts.push(layout);
		}

		const path = GLib.build_filenamev([GLib.get_home_dir(), ".TilingAssistantExtension.layouts.json"]);
		const file = Gio.File.new_for_path(path);

		try {
			file.create(Gio.FileCreateFlags.NONE, null);
		} catch (e) {

		}

		const [success] = file.replace_contents(JSON.stringify(allLayouts), null, false,
				Gio.FileCreateFlags.REPLACE_DESTINATION, null);
		return success;
	},

	_layoutIsValid: function(layout) {
		if (!layout)
			return [false, "No layout."];

		// calculate the surface area of an overlap
		const rectsOverlap = function(r1, r2) {
			return Math.max(0, Math.min(r1.x + r1.width, r2.x + r2.width) - Math.max(r1.x, r2.x))
					* Math.max(0, Math.min(r1.y + r1.height, r2.y + r2.height) - Math.max(r1.y, r2.y));
		}

		for (let i = 0; i < layout.length; i++) {
			const rect = layout[i];
			// rects is/reaches outside of screen (i. e. > 1)
			if (rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0
						|| rect.x + rect.width > 1 || rect.y + rect.height > 1)
				return [false, `Rectangle ${i + 1} is (partly) outside of the screen.`];

			for (let j = i + 1; j < layout.length; j++) {
				if (rectsOverlap(rect, layout[j]))
					return [false, `Rectangles ${i + 1} and ${j + 1} overlap.`];
			}
		}

		return [true, ""];
	},

	// layout format: [{x: 0, y: 0, width: .5, height: .5}, {x: 0, y: 0.5, width: 1, height: .5}, ...]
	_drawLayoutsRects: function(idx, drawArea, cr) {
		const layout = this.layouts[idx];
		const [layoutIsValid, ] = this._layoutIsValid(layout);
		if (!layoutIsValid)
			layout = [{x: 0, y: 0, width: 0, height: 0}];

		const color = new Gdk.RGBA();
		const width = drawArea.get_allocated_width();
		const height = drawArea.get_allocated_height();

		cr.setLineWidth(1.0);

		layout.forEach(rect => {
			// 1px outline for rect in transparent white
			// 5 px gaps between rects
			color.parse("rgba(255, 255, 255, .2)");
			Gdk.cairo_set_source_rgba(cr, color);
			cr.moveTo(rect.x * width + 5, rect.y * height + 5);
			cr.lineTo((rect.x + rect.width) * width - 5, rect.y * height + 5);
			cr.lineTo((rect.x + rect.width) * width - 5, (rect.y + rect.height) * height - 5);
			cr.lineTo(rect.x * width + 5, (rect.y + rect.height) * height - 5);
			cr.lineTo(rect.x * width + 5, rect.y * height + 5);
			cr.strokePreserve();

			// fill rect in transparent black
			color.parse("rgba(0, 0, 0, .15)");
			Gdk.cairo_set_source_rgba(cr, color);
			cr.fill();
		});

		cr.$dispose();
	},

	_setEntryText(entry, text) {
		shellVersion < 40 ? entry.set_text(text) : entry.get_buffer().set_text(text, -1);
	},

	_getChildAtIndex(widget, idx) {
		if (shellVersion < 40)
			return widget.get_children()[idx];

		if (idx < 0)
			return null;

		let child = widget.get_first_child();
		for (; idx > 0 && child; idx--)
			child = child.get_next_sibling();
		return child;
	}
});
