#!/bin/bash
#
# A flat plugin directory for running the daemon uninstalled.
#
# The build scatters each output plugin into build/plugins/<name>/src/, and the
# daemon's plugin loader reads exactly one flat directory with an audio/
# subdirectory -- there is deliberately no source-tree fallback for this. This
# script builds that directory out of symlinks and prints its path, so:
#
#   export ORCHID_PLUGIN_DIR=$(desktop/scripts/dev-plugin-dir.sh)
#
# Idempotent: re-running refreshes the links.

set -euo pipefail

REPO=$(cd "$(dirname "$0")/../.." && pwd)
BUILD=${1:-"$REPO/build"}
OUT="$BUILD/dev-plugins"

[ -d "$BUILD/plugins" ] || { echo "no hay build de plugins en $BUILD" >&2; exit 1; }

mkdir -p "$OUT/audio"

shopt -s nullglob
for so in "$BUILD"/plugins/*/src/*.so; do
    ln -sf "$so" "$OUT/"
done

# The audio decoders are built under the engine, not under plugins/, and the
# daemon looks for them in <plugins>/audio specifically.
for so in "$BUILD"/engine/audio/plugins/*/*.so; do
    ln -sf "$so" "$OUT/audio/"
done

count=$(ls "$OUT"/*.so 2>/dev/null | wc -l)
[ "$count" -gt 0 ] || { echo "no se enlazó ningún plugin desde $BUILD" >&2; exit 1; }

echo "$OUT"
