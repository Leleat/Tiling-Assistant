/**
 * @file This file contains a collection of classes to handle the various shortcuts.
 */

'use strict';

const { Meta, Shell } = imports.gi;
const { main: Main } = imports.ui;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const { AssistantManager } = Me.imports.src.assistantManager;
const { WindowManager } = Me.imports.src.window;
const { TileMode, Shortcuts, Settings } = Me.imports.src.util;

/**
 * High level class that handles the keyboard shortcuts. It should only be
 * instanced by the AssistantManager.
*/
var ShortcutHandler = class ShortcutHandler {
    constructor() {
        Shortcuts.forEach(key => {
            Main.wm.addKeybinding(
                key,
                Settings.get().wrappedObj,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL,
                () => this.#onShortcutActivated(key)
            );
        });
    }

    destroy() {
        Shortcuts.forEach(key => Main.wm.removeKeybinding(key));
    }

    /** @param {string} shortcut */
    #onShortcutActivated(shortcut) {
        log('func: #onShortcutActivated');

        const focus = WindowManager.get().getFocusedWindow();
        if (!focus)
            return;

        const assistantManager = AssistantManager.get();
        const tileGroupManager = assistantManager.getCurrentTileGroupManager();
        const tileMode = TileMode.getForShortcut(shortcut);
        tileGroupManager.tileWindow(focus, tileMode);

        log('\nShortcut handled. Current layout:');
        focus.tile?.tileGroup.tiles.forEach(tile =>
            log(tile.window?.getWmClass(), tile.rect.x, tile.rect.y, tile.rect.width, tile.rect.height));
        log('');
    }
};
