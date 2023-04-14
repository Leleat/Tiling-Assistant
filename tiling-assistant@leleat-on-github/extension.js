/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

'use strict';

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const { AssistantManager } = Me.imports.src.assistantManager;
const { WindowManager } = Me.imports.src.window;
const { Settings, Timeouts } = Me.imports.src.util;

class Extension {
    #assistantManager = null;
    #settings = null;
    #timeouts = null;
    #windowManager = null;

    constructor() {
        ExtensionUtils.initTranslations();
    }

    enable() {
        this.#assistantManager = AssistantManager.get();
        this.#settings = Settings.get();
        this.#timeouts = Timeouts.get();
        this.#windowManager = WindowManager.get();
    }

    disable() {
        this.#assistantManager.destroy();
        this.#assistantManager = null;

        this.#windowManager.destroy();
        this.#windowManager = null;

        this.#settings.destroy();
        this.#settings = null;

        this.#timeouts.destroy();
        this.#timeouts = null;
    }
}

function init() {
    return new Extension();
}
