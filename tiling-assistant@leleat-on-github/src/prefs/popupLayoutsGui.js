'use strict';

const { Gdk, Gio, Gtk, GObject } = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const Layout = Me.imports.src.common.Layout;

const Gettext = imports.gettext;
const Domain = Gettext.domain(Me.metadata.uuid);
const _ = Domain.gettext;

/**
 * Gui for managing popup layouts. It's just instanced by layoutsPrefs.js
 * (see it for more details and general information about layouts). But basically
 * 1 GuiRow represents 1 Layout and 1 GuiEntry represents 1 item within that layout.
 * A LayoutItem is a simple JS Object and has a { rect, appId, loopType }. The
 * rect is mandatory, the rest not.
 */

var GuiRow = GObject.registerClass({ // eslint-disable-line no-unused-vars
    Signals: { 'changed': { param_types: [GObject.TYPE_BOOLEAN] } }
}, class PopupLayoutRow extends Gtk.ListBoxRow {

    // Use a static variable to make sure the indices are unique since just using
    // something like the child index isn't enough because the user may add *and*
    // delete rows at random... so 1 child index may appear multiple times
    static instanceCount = 0;

    /**
     * @returns {number} the number of created LayoutRows since the last time
     *      the layouts were loaded into the preference window.
     */
    static getInstanceCount() {
        return PopupLayoutRow.instanceCount;
    }

    static resetInstanceCount() {
        PopupLayoutRow.instanceCount = 0;
    }

    /**
     * @param {{_name: string, _items: {rect: object, appId: ?string, loopType: ?string}[]
     *      }|null} layout a parsed JS object representing a layout from the
     *      layouts.json file.
     */
    _init(layout) {
        super._init({
            selectable: false,
            margin_bottom: 12
        });

        this._layout = new Layout(layout);
        this._idx = PopupLayoutRow.instanceCount++;

        const mainFrame = new Gtk.Frame({
            label_xalign: 0.5,
            margin_top: 8,
            margin_bottom: 8,
            margin_start: 8,
            margin_end: 8
        });
        this.set_child(mainFrame);

        const mainBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12
        });
        mainFrame.set_child(mainBox);

        /************************************
         * Top row: keybinding & name entry *
         ************************************/

        const topBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            homogeneous: true,
            spacing: 12
        });
        mainBox.append(topBox);

        // Left side (keybinding)
        this._listStore = new Gtk.ListStore();
        this._listStore.set_column_types([GObject.TYPE_INT, GObject.TYPE_INT]);
        this._treeView = new Gtk.TreeView({
            model: this._listStore,
            halign: Gtk.Align.START,
            valign: Gtk.Align.CENTER,
            headers_visible: false,
            enable_search: false,
            hover_selection: true,
            activate_on_single_click: true
        });
        const keybindingFrame = new Gtk.Frame({ margin_end: 8 });
        keybindingFrame.set_child(this._treeView);
        topBox.append(keybindingFrame);

        // Right side (name entry)
        this._nameEntry = new Gtk.Entry({
            // For some reason the text and placeholder would
            // sometimes be both shown...
            placeholder_text: this._layout.getName() === ''
                ? _('Nameless Layout...')
                : ''
        });
        this._nameEntry.connect('changed', this._onNameEntryChanged.bind(this));
        topBox.append(this._nameEntry);

        /*********************************************
         * Middle row: guiEntries and layout preview *
         *********************************************/

        const middleBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            homogeneous: true,
            spacing: 12,
            height_request: 175
        });
        mainBox.append(middleBox);

        // Left column (rect entries + add-new-entry button)
        const rectEntriesScrollWindow = new Gtk.ScrolledWindow({
            vscrollbar_policy: Gtk.PolicyType.ALWAYS
        });
        const middleLeftBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            margin_end: 8
        });
        const rectEntriesBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8
        });
        middleBox.append(rectEntriesScrollWindow);
        rectEntriesScrollWindow.set_child(middleLeftBox);
        middleLeftBox.append(rectEntriesBox);

        // The add-new-entry button below the guiEntries
        const addGuiEntryButton = Gtk.Button.new_from_icon_name('list-add-symbolic');
        addGuiEntryButton.connect('clicked', () => {
            const guiEntry = new GuiEntry(this._layout.getItemCount(), this._layout.addItem()
            );
            guiEntry.connect('changed', this._onGuiEntryChanged.bind(this));
            rectEntriesBox.append(guiEntry);
        });
        middleLeftBox.append(addGuiEntryButton);

        // Right column (layout preview)
        const errorOverlay = new Gtk.Overlay();
        const previewFrame = new Gtk.Frame();
        this._drawingArea = new Gtk.DrawingArea();
        this._errorLabel = new Gtk.Label({
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            visible: true,
            wrap: true
        });
        middleBox.append(errorOverlay);
        errorOverlay.set_child(previewFrame);
        previewFrame.set_child(this._drawingArea);
        errorOverlay.add_overlay(this._errorLabel);

        /************************************
         * Bottom row: delete layout button *
         ************************************/

        const deleteButton = Gtk.Button.new_from_icon_name('edit-delete-symbolic');
        deleteButton.connect('clicked', () => {
            this.emit('changed', true);
            this.destroy();
        });
        mainBox.append(deleteButton);

        /**************
         * Initialize *
         **************/

        mainFrame.set_label('    ' + _('Layout') + ` ${this._idx}` + '    ');
        this._nameEntry.get_buffer().set_text(this._layout.getName(), -1);

        // Load entries with values from the layout
        this._layout.getItems().forEach((item, idx) => {
            const guiEntry = new GuiEntry(idx, item);
            guiEntry.connect('changed', this._onGuiEntryChanged.bind(this));
            rectEntriesBox.append(guiEntry);
        });

        // Add one empty entry row
        const guiEntry = new GuiEntry(this._layout.getItemCount(), this._layout.addItem());
        guiEntry.connect('changed', this._onGuiEntryChanged.bind(this));
        rectEntriesBox.append(guiEntry);

        this._updatePreview();
    }

    destroy() {
        this.get_parent().remove(this);
    }

    /**
     * @returns {Gtk.TreeView} the Gtk.TreeView of this layout's
     *      keyboard shortcut.
     */
    getTreeView() {
        return this._treeView;
    }

    /**
     * @returns {Gtk.ListStore} the Gtk.ListStore of this layout's
     *      keyboard shortcut.
     */
    getListStore() {
        return this._listStore;
    }

    /**
     * @returns {number} the index of this layout.
     */
    getIdx() {
        return this._idx;
    }

    /**
     * @returns {{_name: string, _items: {rect: object, appId: ?string, loopType: ?string}[]
     *      }|null} the layout object represented by this row.
     */
    getLayout() {
        // First, filter out empty rows (i. e. rows without valid rects)
        this._layout.setItems(this._layout.getItems());

        // Then, remove problematic items, if the rects have problems. E. g.,
        // they may overlap each other, extend outside of the screen etc...
        // This is irreversible but fine since this function is only called
        // when the user presses the save button. Before that there will be
        // error messages shown in the preview area.
        let [ok, , idx] = this._layout.validate();
        while (this._layout.getItemCount() && !ok) {
            this._layout.removeItem(idx);
            [ok, , idx] = this._layout.validate();
        }

        return this._layout.getItemCount() ? this._layout : null;
    }

    /**
     * @returns {[boolean, string]} wether the preview was successful and a
     *      potential error message.
     */
    _updatePreview() {
        const [ok, errMsg] = this._layout.validate();
        if (!ok) {
            // Print error in the preview area
            this._errorLabel.set_label(errMsg);
            this._drawingArea.set_draw_func(() => {});

        } else {
            // Draw the acual preview for the rects
            this._errorLabel.set_label('');
            this._drawingArea.set_draw_func((drawingArea, cr) => {
                const color = new Gdk.RGBA();
                const width = drawingArea.get_allocated_width();
                const height = drawingArea.get_allocated_height();

                cr.setLineWidth(1.0);

                this._layout.getItems().forEach(item => {
                    // Rects are in a slightly transparent white with a 1px outline
                    // and a 5px gap between the different rects
                    const rect = item.rect;
                    color.parse('rgba(255, 255, 255, .2)');
                    Gdk.cairo_set_source_rgba(cr, color);
                    cr.moveTo(rect.x * width + 5, rect.y * height + 5);
                    cr.lineTo((rect.x + rect.width) * width - 5, rect.y * height + 5);
                    cr.lineTo((rect.x + rect.width) * width - 5, (rect.y + rect.height) * height - 5);
                    cr.lineTo(rect.x * width + 5, (rect.y + rect.height) * height - 5);
                    cr.lineTo(rect.x * width + 5, rect.y * height + 5);
                    cr.strokePreserve();

                    // Fill the rects in transparent black.
                    // If the rect is a 'loop', lower the transparency.
                    color.parse(`rgba(0, 0, 0, ${item.loopType ? .1 : .3})`);
                    Gdk.cairo_set_source_rgba(cr, color);
                    cr.fill();
                });

                cr.$dispose();
            });
        }

        this._drawingArea.queue_draw();
        return [ok, errMsg];
    }

    _onNameEntryChanged() {
        this._layout.setName(this._nameEntry.get_buffer().get_text());
        const [ok] = this._layout.validate();
        this.emit('changed', ok);
    }

    /**
     * @param {GuiEntry} guiEntry src of the event.
     * @param {boolean} ok wether the change follows the proper format.
     */
    _onGuiEntryChanged(guiEntry, ok) {
        // ok only is about the change being ok for the *individual* guiEntry
        // i. e. wether their format is correct
        if (!ok) {
            this.emit('changed', ok);
            return;
        }

        // allOk is about wether the guiEntries are also valid as a whole
        const [allOk] = this._updatePreview();
        this.emit('changed', allOk);
    }
});

const GuiEntry = GObject.registerClass({
    Signals: { 'changed': { param_types: [GObject.TYPE_BOOLEAN] } }
}, class PopupLayoutGuiEntry extends Gtk.Box {

    /**
     * @param {number} idx the index of this entry within the layout.
     * @param {{rect: object, appId: number|null, loopType: string|null}} item
     *      a LayoutItem. It may be empty, that means it may
     *      not have valid rects defined.
     */
    _init(idx, item) {
        super._init({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8
        });

        this._item = item;

        const label = new Gtk.Label({ label: `${idx}:` });
        const loop = item.loopType ? `${'--' + item.loopType}` : '';
        const rect = item.rect;
        const text = Object.keys(rect).length !== 0
            ? `${rect.x}--${rect.y}--${rect.width}--${rect.height}${loop}`
            : '';
        const entry = new Gtk.Entry({
            buffer: new Gtk.EntryBuffer({ text }),
            tooltip_text: _("Check out the 'Guide' in the repository (see the 'Help' Tab)."),
            // For some reason the text and placeholder would
            // sometimes be both shown...
            placeholder_text: idx === 0 && item._name === ''
                ? _('This tooltip for help...')
                : '',
            hexpand: true
        });
        entry.connect('changed', this._onEntryChanged.bind(this));
        const appInfo = item.appId && Gio.DesktopAppInfo.new(item.appId);
        const appButton = Gtk.Button.new_from_icon_name(
            appInfo?.get_icon().to_string() ?? 'list-add-symbolic');
        appButton.connect('clicked', this._onAppButtonClicked.bind(this));

        this.append(label);
        this.append(entry);
        this.append(appButton);
    }

    /**
     * @param {Gtk.Button} appButton src of the event.
     */
    _onAppButtonClicked(appButton) {
        // Reset app button, if it already has an app attached
        if (this._item.appId) {
            appButton.set_icon_name('list-add-symbolic');
            this._item.appId = null;
            this.emit('changed', true);

        // Attach app to the button
        } else {
            const chooserDialog = new Gtk.AppChooserDialog({ modal: true });
            chooserDialog.get_widget().set({ show_all: true, show_other: true });
            chooserDialog.connect('response', (dlg, id) => {
                if (id === Gtk.ResponseType.OK) {
                    const appInfo = chooserDialog.get_widget().get_app_info();
                    appButton.set_icon_name(appInfo.get_icon().to_string());
                    this._item.appId = appInfo.get_id();
                    this.emit('changed', true);
                }

                chooserDialog.destroy();
            });

            chooserDialog.show();
        }
    }

    /**
     * @param {Gtk.Entry} entry src of the event.
     */
    _onEntryChanged(entry) {
        const text = entry.get_buffer().get_text();
        const [ok] = this._validateFormat(text);
        if (ok) {
            const values = text.split('--');
            this._item.rect = {
                x: parseFloat(values[0].trim()),
                y: parseFloat(values[1].trim()),
                width: parseFloat(values[2].trim()),
                height: parseFloat(values[3].trim())
            };
            this._item.loopType = values[4] || null;

        } else {
            this._item.rect = {};
            this._item.loopType = null;
        }

        this.emit('changed', ok);
    }

    /**
     * Validates wether `text` follows the format \
     * 'Float--Float--Float--Float[--String]'
     *
     * @param {string} text
     * @returns {[boolean, string]} wether the `text` is valid and a
     *      potential error message.
     */
    _validateFormat(text) {
        const values = text.split('--');
        // 4 -> x, y, width, height; 5 -> additionally, a loopType
        if (values.length < 4 || values.length > 5)
            return [false, 'Wrong format: invalid count.'];

        const notJustNrs = ['x', 'y', 'width', 'height'].some((p, idx) => {
            return Number.isNaN(parseFloat(values[idx].trim()));
        });

        return notJustNrs
            ? [false, 'Wrong format: only numbers are allowed.']
            : [true, ''];
    }
});
