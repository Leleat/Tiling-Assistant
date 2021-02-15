"use strict";

const {Gdk, Gio, GLib, Gtk, GObject} = imports.gi;
const Me = imports.misc.extensionUtils.getCurrentExtension();

const Gettext = imports.gettext;
Gettext.textdomain("tiling-assistant@leleat-on-github");
Gettext.bindtextdomain("tiling-assistant@leleat-on-github", Me.dir.get_child("locale").get_path());
const _ = Gettext.gettext;

function init () {
};

function buildPrefsWidget () {
	const widget = new MyPrefsWidget();
	widget.show_all();
	return widget;
};

const MyPrefsWidget = new GObject.Class({
	Name : "MyTilingPrefsWidget",
	GTypeName : "MyTilingPrefsWidget",
	Extends : Gtk.ScrolledWindow,

	_init: function (params) {
		const gschema = Gio.SettingsSchemaSource.new_from_directory(
			Me.dir.get_child("schemas").get_path(),
			Gio.SettingsSchemaSource.get_default(),
			false
		);

		this._settingsSchema = gschema.lookup("org.gnome.shell.extensions.tiling-assistant", true);
		this.settings = new Gio.Settings({settings_schema: this._settingsSchema});

		this.parent(params);

		this.builder = new Gtk.Builder();
		this.builder.add_from_file(Me.path + '/prefs.ui');
		this.add(this.builder.get_object('main_prefs'));
		this.set_min_content_height(700);

		// bind settings to the UI objects
		// make sure the objects in prefs.ui have the same name as the keys in the settings (schema.xml)
		this._settingsSchema.list_keys().forEach(key => {
			const bindProperty = this.getBindProperty(key);
			const builderObject = this.builder.get_object(key);
			if (builderObject !== null && bindProperty)
				this.settings.bind(key, builderObject, bindProperty, Gio.SettingsBindFlags.DEFAULT);
		});

		// bind keybindings
		const shortcuts = ["toggle-dash", "replace-window", "tile-maximize", "tile-empty-space",
				"tile-right-half", "tile-left-half", "tile-top-half", "tile-bottom-half",
				"tile-bottomleft-quarter", "tile-bottomright-quarter", "tile-topright-quarter", "tile-topleft-quarter",
				"layout1", "layout2", "layout3", "layout4", "layout5", "layout6", "layout7", "layout8", "layout9", "layout10"];
		shortcuts.forEach(sc => this.makeShortcutEdit(sc));

		// translations
		this.setupTranslations();

		////////////////
		////////////////
		// Layouts gui:
		// this.layouts is an array of arrays. The inner arrays contain "rects" in the format {x: NR, y: NR, width: NR, height: NR}
		// layouts with apps attached are in the format [{x: NR, y: NR, width: NR, height: NR}, appName].
		// NR is a float between 0 to 1.
		// the user defines the rects via Gtk.Entrys in the format xVal--yVal--widthVal--heightVal.
		this.loadLayouts();
		const drawAreas = [];
		this.buttonIconSize = 16;

		// layout reload button
		this.builder.get_object("reloadLayoutsButton").connect("clicked", () => {
			this.loadLayouts();
			drawAreas.forEach(d => d.queue_draw());
		});

		// layout save button
		this.builder.get_object("saveLayoutsButton").connect("clicked", () => {
			this.saveLayouts();
			this.loadLayouts();
			drawAreas.forEach(d => d.queue_draw());
		});

		// other layout buttons (each layout has at least 1 of them)
		// Nr (10) of layouts are "hardcoded"
		for (let i = 0; i < 10; i++) {
			const layoutListBox = this.builder.get_object(`LayoutListbox${i}`);
			const hasAppButton = layoutListBox.get_row_at_index(0).get_child().get_children().length === 3;

			// delete buttons
			// resets Gtk.entries and add app buttons
			this.builder.get_object(`deleteLayoutButton${i}`).connect("clicked", () => {
				for (let j = 0; j < 8; j++) { // 8 Gtk.entries / possible rects in a layout
					const entry = layoutListBox.get_row_at_index(j).get_child().get_children()[1];
					entry.set_text("");

					if (hasAppButton) {
						const appButton = layoutListBox.get_row_at_index(j).get_child().get_children()[2];
						const img = Gtk.Image.new_from_icon_name("list-add", this.buttonIconSize);
						appButton.set_image(img);
						appButton.appInfo = null;
					}
				}
			});

			// add button (each Gtk.entry / rectangle has one):
			// opens an AppChooserDialog
			if (hasAppButton) {
				for (let j = 0; j < 8; j++) { // 8 Gtk.entries / possible rects in a layout
					const appButton = layoutListBox.get_row_at_index(j).get_child().get_children()[2];
					appButton.connect("clicked", () => {
						const chooserDialog = new Gtk.AppChooserDialog({
							transient_for: this.get_toplevel(),
							modal: true
						});

						chooserDialog.get_widget().set({
							show_all: true,
							show_other: true
						});

						chooserDialog.connect('response', (dlg, id) => {
							if (id === Gtk.ResponseType.OK) {
								const appInfo = chooserDialog.get_widget().get_app_info();
								const img = Gtk.Image.new_from_gicon(appInfo.get_icon(), this.buttonIconSize);
								appButton.set_image(img);
								appButton.appInfo = appInfo;
							}

							chooserDialog.destroy();
						});

						chooserDialog.show();
					});
				}
			}

			// draw preview rects in the right column
			const drawArea = this.builder.get_object(`DrawArea${i}`);
			drawAreas.push(drawArea);
			drawArea.connect("draw", (widget, cr) => {
				if (!this.layouts)
					return;

				const layout = this.layouts[i];
				const [layoutIsValid, errMsg] = this.layoutIsValid(layout, hasAppButton);
				if (layoutIsValid) {
					// remove error label from overlay, if it exists
					const gtkOverlay = widget.get_parent().get_parent();
					if (gtkOverlay.get_children().length > 1)
						gtkOverlay.remove(gtkOverlay.get_children()[1]);

					this.drawLayoutsRects(widget, cr, layout, hasAppButton);

				} else {
					// add error label to overlay;
					// only change old label text, if it already exists
					const gtkOverlay = widget.get_parent().get_parent();
					if (gtkOverlay.get_children().length > 1) {
						gtkOverlay.get_children()[1].set_text(errMsg);
					} else {
						const label = new Gtk.Label({
							label: errMsg,
							halign:  Gtk.Align.CENTER,
							valign:  Gtk.Align.CENTER,
							visible: true,
							wrap: true
						});
						gtkOverlay.add_overlay(label);
					}
				}
			});
		}
	},

	// manually add the keys to the arrays in this function
	getBindProperty: function(key) {
		const ints = ["icon-size", "icon-margin", "window-gaps"];
		const bools = ["enable-dash", "use-anim"];

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

	// load from ~/.TilingAssistantExtension.layouts.json
	loadLayouts: function () {
		const path = GLib.build_filenamev([GLib.get_home_dir(), ".TilingAssistantExtension.layouts.json"]);
		const file = Gio.File.new_for_path(path);

		try {
			file.create(Gio.FileCreateFlags.NONE, null);
		} catch (e) {

		}

		const [success, contents] = file.load_contents(null);
		if (!success)
			return null;

		if (!contents.length) {
			GLib.free(contents);
			return null;
		}

		// reset layout's entries' text
		for (let i = 0; i < 10; i++) {
			const layoutListBox = this.builder.get_object(`LayoutListbox${i}`);
			const hasAppButton = layoutListBox.get_row_at_index(0).get_child().get_children().length === 3;

			for (let j = 0; j < 8; j++) {
				const entry = layoutListBox.get_row_at_index(j).get_child().get_children()[1];
				entry.set_text("");

				if (hasAppButton) {
					const appButton = layoutListBox.get_row_at_index(j).get_child().get_children()[2];
					const img = Gtk.Image.new_from_icon_name("list-add", this.buttonIconSize);
					appButton.set_image(img);
					appButton.appInfo = null;
				}
			}
		}

		// set text for Gtk.entries & appButtons
		const layouts = JSON.parse(contents);
		layouts.forEach((layout, index) => {
			const layoutListBox = this.builder.get_object(`LayoutListbox${index}`);
			const hasAppButton = layoutListBox.get_row_at_index(0).get_child().get_children().length === 3;

			layout.forEach((item, idx) => {
				const rect = (hasAppButton) ? item[0] : item;
				const appName = (hasAppButton) ? item[1] : null;

				const entry = layoutListBox.get_row_at_index(idx).get_child().get_children()[1];
				entry.set_text(`${rect.x}--${rect.y}--${rect.width}--${rect.height}`);

				if (hasAppButton) {
					const appButton = layoutListBox.get_row_at_index(idx).get_child().get_children()[2];
					const appInfo = Gio.AppInfo.get_all().find((info) => info.get_name() === appName);
					const img = appInfo ? Gtk.Image.new_from_gicon(appInfo.get_icon(), this.buttonIconSize) : Gtk.Image.new_from_icon_name("list-add", this.buttonIconSize);
					appButton.set_image(img);
					appButton.appInfo = appInfo;
				}
			});
		});

		GLib.free(contents);
		this.layouts = layouts;
	},

	// save to ~/.TilingAssistantExtension.layouts.json
	saveLayouts: function () {
		const allLayouts = [];
		const rectProps = ["x", "y", "width", "height"];

		// for each possible layout
		for (let i = 0; i < 10; i++) {
			const layout = [];
			const layoutListBox = this.builder.get_object(`LayoutListbox${i}`);
			const hasAppButton = layoutListBox.get_row_at_index(0).get_child().get_children().length === 3;

			// for each possible rect in the layout
			for (let j = 0; j < 8; j++) {
				const rect = {};

				const entry = layoutListBox.get_row_at_index(j).get_child().get_children()[1];
				if (!entry.get_text_length())
					continue;

				const text = entry.get_text();
				const splits = text.split("--");
				if (splits.length !== 4) {
					layout.push({x: 0, y: 0, width: 0, height: 0});
					continue;
				}

				for (let k = 0; k < 4; k++) {
					const propValue = parseFloat(splits[k].trim());
					if (Number.isNaN(propValue)) {
						layout.push({x: 0, y: 0, width: 0, height: 0});
						continue;
					}

					rect[rectProps[k]] = propValue;
				}

				const appButton = (hasAppButton) ? layoutListBox.get_row_at_index(j).get_child().get_children()[2] : null;
				layout.push((!appButton) ? rect : (appButton.appInfo) ? [rect, appButton.appInfo.get_name()] : {x: 0, y: 0, width: 0, height: 0});
			}

			allLayouts.push(layout);
		}

		const path = GLib.build_filenamev([GLib.get_home_dir(), ".TilingAssistantExtension.layouts.json"]);
		const file = Gio.File.new_for_path(path);

		try {
			file.create(Gio.FileCreateFlags.NONE, null);
		} catch (e) {

		}

		const [success] = file.replace_contents(JSON.stringify(allLayouts), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
		return success;
	},

	layoutIsValid: function (layout, hasAppButton) {
		if (!layout)
			return [false, "No layout."];

		// calculate the surface area of an overlap
		const rectsOverlap = function(r1, r2) {
			return Math.max(0, Math.min(r1.x + r1.width, r2.x + r2.width) - Math.max(r1.x, r2.x)) * Math.max(0, Math.min(r1.y + r1.height, r2.y + r2.height) - Math.max(r1.y, r2.y));
		}

		for (let i = 0; i < layout.length; i++) {
			const r = (hasAppButton) ? layout[i][0] : layout[i];
			const appName = (hasAppButton) ? layout[i][1] : null;

			if (hasAppButton && ((r && !appName) || (!r && appName)))
				return [false, _("Missing rectangle or app.")];

			// rects is/reaches outside of screen (i. e. > 1)
			if (r.x < 0 || r.y < 0 || r.width <= 0 || r.height <= 0 || r.x + r.width > 1 || r.y + r.height > 1)
				return [false, _("Rectangle %d is (partly) outside of the screen.").format(i + 1)];

			for (let j = i + 1; j < layout.length; j++) {
				if (rectsOverlap(r, layout[j]))
					return [false, _("Rectangles %d and %d overlap.").format(i + 1, j + 1)];
			}
		}

		return [true, ""];
	},

	// layout format = [{x: 0, y: 0, width: .5, height: .5}, {x: 0, y: 0.5, width: 1, height: .5}, ...]
	drawLayoutsRects: function (layoutWidget, cr, layout, hasAppButton) {
		const color = new Gdk.RGBA();
		const width = layoutWidget.get_allocated_width();
		const height = layoutWidget.get_allocated_height();

		cr.setLineWidth(1.0);

		layout.forEach(item => {
			const r = (!hasAppButton) ? item : item[0];
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

		cr.$dispose();
	},

	setupTranslations: function () {
		const widgetNames = ["generalTabLabel", "keybindingsTabLabel", "layoutsTabLabel", "helpTabLabel"
				, "enableDashLabel", "dashIconSizeLabel", "dashIconMarginLabel", "enableAnimationsLabel", "animationsTooltipHint","gabLabel"
				, "toggleMaximizationLabel", "tileToTopHalfLabel", "tileToBottomHalfLabel", "tileToRightHalfLabel", "tileToLeftHalfLabel"
				, "tileToTopLeftQuarterLabel", "tileToTopRightQuarterLabel", "tileToBottomLeftQuarterLabel", "tileToBottomRightQuarterLabel"
				, "tileToEmptySpaceLabel", "tileToOtherTiledWindowLabel", "toggleDashLabel"
				, "FixedTilingHeadingLabel", "DynamicTilingHeadingLabel", "OtherHeadingLabel", "LayoutsHeadingLabel"
				, "layout1KeybindingLabel", "layout2KeybindingLabel", "layout3KeybindingLabel", "layout4KeybindingLabel", "layout5KeybindingLabel"
				, "layout6KeybindingLabel", "layout7KeybindingLabel", "layout8KeybindingLabel", "layout9KeybindingLabel", "layout10KeybindingLabel"
				, "saveLayoutsButton", "reloadLayoutsButton", "tooltipLayoutsEntry", "issueLabel", "licenseLabel"
		];

		for (const name of widgetNames) {
			const widget = this.builder.get_object(name);
			if (!widget || !(widget instanceof Gtk.Widget))
				return;

			const tooltipText = widget.get_tooltip_text();
			tooltipText && widget.set_tooltip_text(_(tooltipText));
			GLib.free(tooltipText);

			if (widget instanceof Gtk.Label) {
				const widgetText = widget.get_label();
				if (widgetText) {
					(widget.get_use_markup()) ? widget.set_label(_(widgetText))
							: widget.set_text(_(widgetText));
				}

			} else if (widget instanceof Gtk.Entry) {
				const placeholderText = widget.get_placeholder_text();
				placeholderText && widget.set_placeholder_text(_(placeholderText));

			} else if (widget instanceof Gtk.Button) {
				const widgetText = widget.get_label();
				widgetText && widget.set_label(_(widgetText));
			}
		}
	},
});
