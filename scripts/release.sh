#!/bin/bash

# exit, if a command fails
set -e

# cd to repo dir
SCRIPT_DIR="$( cd "$( dirname "$0" )" && pwd )"
cd "$SCRIPT_DIR"/../

METADATA=tiling-assistant@leleat-on-github/metadata.json

# get new version nr
VERSION_LINE=$(cat $METADATA | grep \"version\":)
# split after ":" and trim the spaces
VERSION_NR=$(echo "$VERSION_LINE" | cut -d ':' -f 2 | xargs)
NEW_VERSION_NR=$((VERSION_NR + 1))

# switch to new release branch
git checkout -b "release-$NEW_VERSION_NR"

# bump up version nr in metadata.json
echo Updating metadata.json...
sed -i "s/\"version\": $VERSION_NR/\"version\": $NEW_VERSION_NR/" $METADATA
echo Metadata updated.
echo

# bump up version nr in AUR files
PKGBUILD=scripts/aur-build/PKGBUILD
echo Updating Arch\'s PKGBUILD...
sed -i "s/pkgver=$VERSION_NR/pkgver=$NEW_VERSION_NR/" $PKGBUILD
cd scripts/aur-build/
makepkg --printsrcinfo > .SRCINFO
cd ../../
echo PKGBUILD updated.
echo

# update translations
bash scripts/update-tl.sh
echo

# package zip for EGO
bash scripts/build.sh

# commit changes
echo Committing version bump...
git add $METADATA $PKGBUILD CHANGELOG.md scripts/aur-build/.SRCINFO translations/*.po translations/*.pot
git commit -m "Release: Bump version to $NEW_VERSION_NR"
echo

echo Release done.
echo

echo TODO:
echo
echo [] Push release branch and and create pull request
echo [] Create and push tag
echo [] Upload the extension to EGO
