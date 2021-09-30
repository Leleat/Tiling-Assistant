#!/bin/bash

# exit, if a command fails
set -e

# cd to repo dir
SCRIPT_DIR="$( cd "$( dirname "$0" )" && pwd )"
cd $SCRIPT_DIR/../

# create extension zip including the schemas and translations
echo Packaging extension...
gnome-extensions pack tiling-assistant@leleat-on-github \
    --force \
    --podir="../translations" \
    --extra-source="src" \
    --extra-source="prefs.ui"
echo Packaging complete.
echo

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
