import { Gdk, Gtk, GObject } from '../dependencies/prefs/gi.js';
import { _ } from '../dependencies/prefs.js';

import { Layout } from '../common.js';
import { LayoutRowEntry } from './layoutRowEntry.js';

/**
 * 1 LayoutRow represents 1 Layout in the preference window. It's just instanced
 * by layoutsPrefs.js (see that file for more details and general information
 * about layouts). 1 LayoutRow has a bunch of LayoutRowEntries, which each
 * represent a LayoutItem. A LayoutItem is a simple JS Object and has a
 * { rect, appId, loopType }. The rect is mandatory, the rest not.
 */

export const LayoutRow = GObject.registerClass({
    GTypeName: 'TilingLayoutRow',
    Template: import.meta.url.replace(/prefs\/(.*)\.js$/, 'ui/$1.ui'),
    InternalChildren: [
        'addRowEntryButton',
        'deleteButton',
        'drawingArea',
        'entryBox',
        'errorLabel',
        'expanderButton',
        'nameEntry',
        'rectCountLabel',
        'shortcut',
        'revealer'
    ],
    Signals: { 'changed': { param_types: [GObject.TYPE_BOOLEAN] } }
}, class TilingLayoutRow extends Gtk.ListBoxRow {
    // Use a static variable to make sure the indices are unique since just using
    // something like the child index isn't enough because the user may add *and*
    // delete rows at random... so 1 child index may appear multiple times
    static instanceCount = 0;

    /**
     * @returns {number} the number of created LayoutRows since the last time
     *      the layouts were loaded into the preference window.
     */
    static getInstanceCount() {
        return TilingLayoutRow.instanceCount;
    }

    static resetInstanceCount() {
        TilingLayoutRow.instanceCount = 0;
    }

    /**
     * @param {{_name: string, _items: {rect: object, appId: ?string, loopType: ?string}[]
     *      }|null} layout a parsed JS object representing a layout from the
     *      layouts.json file.
     */
    _init(layout, settings) {
        super._init();

        this._settings = settings;
        this._layout = new Layout(layout);
        this._idx = TilingLayoutRow.instanceCount++;
        this._shortcutKey = `activate-layout${this._idx}`;

        // Initialize shortcut and its clear-button
        this._shortcut.initialize(this._shortcutKey, this._settings);

        // Set name. Don't use a placeholder, if there is one because of a bug
        // when reloading the layouts
        const name = this._layout.getName();
        this._nameEntry.get_buffer().set_text(name, -1);
        this._nameEntry.set_placeholder_text(name ? '' : 'Nameless Layout...');

        // Load the entries with values from the layout
        const items = this._layout.getItems();
        items.forEach((item, idx) => {
            const rowEntry = new LayoutRowEntry(idx, item);
            rowEntry.connect('changed', this._onRowEntryChanged.bind(this));
            this._entryBox.append(rowEntry);
        });

        // Show the nr of rects for a quicker overview.
        this._rectCountLabel.set_label(items.length ? `(${items.length})` : '');

        // Add one empty entry row
        this._onAddRowEntryButtonClicked();

        // Update the preview / show the errorLabel
        this._updatePreview();
    }

    destroy() {
        this.get_parent().remove(this);
    }

    activate() {
        this._nameEntry.grab_focus();
    }

    /**
     * toggles whether the layout's rects are visible.
     */
    toggleReveal() {
        this._revealer.reveal_child = !this._revealer.reveal_child;
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
     * @returns {[boolean, string]} whether the preview was successful and a
     *      potential error message.
     */
    _updatePreview() {
        const [ok, errMsg] = this._layout.validate();
        if (!ok) {
            // Print error in the preview area
            this._errorLabel.set_label(errMsg);
            this._drawingArea.set_draw_func(() => {});
        } else {
            // Draw the actual preview for the rects
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
        const name = this._nameEntry.get_buffer().get_text();
        this._nameEntry.set_tooltip_text(name);
        this._layout.setName(name);
        const [ok] = this._layout.validate();
        this.emit('changed', ok);
    }

    _onDeleteButtonClicked() {
        this._settings.set_strv(this._shortcutKey, []);
        this.emit('changed', true);
        this.destroy();
    }

    _onExpanderButtonClicked() {
        this.toggleReveal();
    }

    _onClearShortcutButtonClicked() {
        this._settings.set_strv(`activate-layout${this._idx}`, []);
    }

    _onAddRowEntryButtonClicked() {
        const rowEntry = new LayoutRowEntry(this._layout.getItemCount(), this._layout.addItem());
        rowEntry.connect('changed', this._onRowEntryChanged.bind(this));
        this._entryBox.append(rowEntry);
    }

    _onRowEntryChanged(entry, ok) {
        // ok only is about the change being ok for the *individual* entry
        // i. e. whether their format is correct
        if (!ok) {
            this.emit('changed', ok);
            return;
        }

        // allOk is about whether the guiEntries are also valid as a whole
        const [allOk] = this._updatePreview();
        this.emit('changed', allOk);
    }
});
