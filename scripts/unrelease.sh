#!/bin/bash

# exit, if a command fails
set -e

# cd to repo dir
SCRIPT_DIR="$( cd "$( dirname "$0" )" && pwd )"
cd $SCRIPT_DIR/../

METADATA=tiling-assistant@leleat-on-github/metadata.json

# get version nr
VERSION_LINE=$(cat $METADATA | grep \"version\":)
# split after ":" and trim the spaces
VERSION_NR=$(echo $(echo $VERSION_LINE | cut -d ':' -f 2) | xargs)
PREV_VERSION_NR=$((VERSION_NR - 1))

# reset version bump commit
echo resetting version bump commit...
git reset --hard HEAD^
echo

# delete git tag
echo Deleting git tag...
git tag -d v$VERSION_NR
echo

# delete package zip
echo Deleting package zip...
rm -f tiling-assistant@leleat-on-github.shell-extension.zip
echo

echo Unrelease done.