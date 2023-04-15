#!/bin/bash

# exit, if a command fails
set -e

# cd to repo dir
cd -P -- "$(dirname -- "$0")"/../

METADATA=tiling-assistant@leleat-on-github/metadata.json

# get version nr
VERSION_LINE=$(cat $METADATA | grep \"version\":)
# split after ":" and trim the spaces
VERSION_NR=$(echo "$VERSION_LINE" | cut -d ':' -f 2 | xargs)

# reset version bump commit
echo resetting version bump commit...
git reset --hard HEAD^
echo

# delete git tag
echo Deleting git tag...
git tag -d v"$VERSION_NR"
echo

# delete package zip
echo Deleting package zip...
rm -f tiling-assistant@leleat-on-github.shell-extension.zip
echo

echo Unrelease done.