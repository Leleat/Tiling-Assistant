#!/bin/bash

# exit, if a command fails
set -e

# cd to repo dir
cd -P -- "$(dirname -- "$0")"/../

# compile settings
glib-compile-schemas tiling-assistant@leleat-on-github/schemas

# compile tl: requires gettext
for FILE in translations/*.po; do
    LANG=$(basename "$FILE" .po)
    mkdir -p "tiling-assistant@leleat-on-github/locale/$LANG/LC_MESSAGES"
    msgfmt -c "$FILE" -o "tiling-assistant@leleat-on-github/locale/$LANG/LC_MESSAGES/tiling-assistant@leleat-on-github.mo"
done

# create zip package
cd tiling-assistant@leleat-on-github
zip -FSqr tiling-assistant@leleat-on-github.shell-extension.zip ./*
mv -f tiling-assistant@leleat-on-github.shell-extension.zip ./../
cd ..

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
