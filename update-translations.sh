#!/usr/bin/env bash
set -euo pipefail

DOMAIN="update-extension@purejava.org"
LOCALE_DIR="locale"
POT_FILE="$LOCALE_DIR/$DOMAIN.pot"

for po in "$LOCALE_DIR"/*/"$DOMAIN.po"; do
    [ -e "$po" ] || continue

    lang_dir="$(dirname "$po")"
    lang="$(basename "$lang_dir")"
    mo_dir="$lang_dir/LC_MESSAGES"
    mo_file="$mo_dir/$DOMAIN.mo"

    echo "=== $lang ==="

    echo "Updating $po"
    msgmerge --update --backup=none "$po" "$POT_FILE"

    if [ -d "$mo_dir" ]; then
        echo "Compiling $mo_file"
        msgfmt "$po" -o "$mo_file"
    else
        echo "Skipping $lang (no LC_MESSAGES directory)"
    fi
done
