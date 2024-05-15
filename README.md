# Tiling Assistant

Tiling Assistant is a GNOME Shell extension which adds a Windows-like snap assist to the GNOME desktop. It expands GNOME's 2 column tiling layout and adds many more features.

## Features

Please visit the [wiki](https://github.com/Leleat/Tiling-Assistant/wiki) for a list of all features. You'll also find videos and explanations for each of them there.

## Supported GNOME Versions

The [metadata](https://github.com/Leleat/Tiling-Assistant/blob/main/tiling-assistant%40leleat-on-github/metadata.json#L4) file lists all currently supported GNOME Shell versions. Generally, only the most recent GNOME Shell is supported. That means older releases may not include all features and bug fixes. You can look at the revisions of the wiki articles to find out when a feature was added, changed, or improved. The [changelog](https://github.com/Leleat/Tiling-Assistant/blob/main/CHANGELOG.md) will show all changes in chronological order.

Here is a table showing the GNOME Shell releases and the latest extension version supporting them.

| GNOME Shell | Tiling Assistant |
| :---------: | :--------------: |
|     45      |        44        |
|     44      |        43        |
|     43      |        43        |
|     42      |        36        |
|     41      |        32        |
|     40      |        32        |
|    3.38     |        23        |
|    3.36     |        23        |

## Installation

You can install it via https://extensions.gnome.org/extension/3733/tiling-assistant/. Alternatively, or if you want an up-to-date version, download / clone the repository and run the `scripts/build.sh` script with the `-i` flag. Make sure to have `gettext` installed. If you've manually installed the extension, you need to reload GNOME Shell afterwards (e.g. by logging out). It's also on the AUR but that repository is maintained by a 3rd party.

## Translation

Translations are welcome! If you are already familiar with how it works, feel free to directly open a pull request with a `YOUR_LANG.po` file at `translations/`. Don't worry, in case you don't know how to create a `.po` file. Just open an issue and I'll set everything up. You'll only need a text editor and your language skills 🙂.

## License

This extension is distributed under the terms of the GNU General Public License, version 2 or later. See the license file for details.
