#!/bin/bash

# exit, if a command fails
set -e

# cd to repo dir
cd -P -- "$(dirname -- "$0")"/../

# update main.pot
echo -n Updating \'translations/main.pot\'
xgettext \
    --from-code=UTF-8 \
    --output=translations/main.pot \
    ./*/*/*/*.ui ./*/*.js ./*/*/*.js ./*/*/*/*.js
echo \ ......... done.

# update .po files
for FILE in translations/*.po; do
    echo -n "Updating '$FILE' "
    msgmerge -NU "$FILE" translations/main.pot
done
