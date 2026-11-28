#!/bin/sh
set -eu
source=$1
target=$2
parent=$3
cache=$4
backup="$source.bak"
fail() {
    printf '%s\n' "$1" > "$cache/install-error.txt"
    rm -f "$source"
    exit 1
}
attempt=0
while kill -0 "$parent" 2>/dev/null; do
    attempt=$((attempt + 1))
    [ "$attempt" -le 120 ] || fail 'Portiva did not exit; the application was not replaced.'
    sleep 1
done
cp -p "$target" "$backup" || fail 'Could not preserve the existing application.'
mv -f "$source" "$target" || fail 'Could not replace the application; the previous binary is preserved.'
"$target" >/dev/null 2>&1 &
restarted=$!
sleep 1
if ! kill -0 "$restarted" 2>/dev/null; then
    mv -f "$backup" "$target"
    fail 'Could not restart Portiva; the previous binary was restored.'
fi
rm -f "$backup"
# Keep the cache for diagnosis; the application can show an install-error.txt next time.
