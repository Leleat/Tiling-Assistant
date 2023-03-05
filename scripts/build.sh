#!/bin/bash

# exit, if a command fails
set -e

# cd to repo dir
SCRIPT_DIR="$( cd "$( dirname "$0" )" && pwd )"
cd "$SCRIPT_DIR"/../

# compile settings
glib-compile-schemas tiling-assistant@leleat-on-github/schemas

# compile tl: requires gettext
for FILE in translations/*.po; do
    LANG=$(basename "$FILE" .po)
    mkdir -p "locale/$LANG/LC_MESSAGES"
    msgfmt -c "$FILE" -o "locale/$LANG/LC_MESSAGES/tiling-assistant@leleat-on-github.mo"
done

# create zip package and delete locale directory
rm -f tiling-assistant@leleat-on-github.shell-extension.zip
mv locale tiling-assistant@leleat-on-github/
cd tiling-assistant@leleat-on-github
zip -qr tiling-assistant@leleat-on-github.shell-extension.zip ./*
rm -rf locale
cd ..
mv tiling-assistant@leleat-on-github/tiling-assistant@leleat-on-github.shell-extension.zip ./

while getopts i FLAG; do
    case $FLAG in

        i)  echo Installing extension...
            gnome-extensions install --force tiling-assistant@leleat-on-github.shell-extension.zip && \
            rm -f tiling-assistant@leleat-on-github.shell-extension.zip && \
            echo Installation complete. Restart GNOME Shell and enable the extension to use it. || \
            exit 1;;

        *)  echo Don\'t use any flags to just create an extension package. Use \'-i\' to additionally install the extension.
            exit 1;;
    esac
done
