#!/bin/bash
#
# Stage the daemon and everything it needs into the shell's bundle resources.
#
#   desktop/scripts/collect-sidecar.sh
#
# There is exactly ONE source of truth for what a self-contained OrchidLights
# needs -- the CMake install rules behind -Dappimage=ON, the same ones the
# headless AppImage ships with. This script runs that install into a staging
# directory and rearranges the result into the layout desktop/src-tauri's
# layout.rs expects:
#
#   resources/sidecar/
#     bin/orchidlightsd
#     lib/                       engine + Qt6 + icu
#     qtplugins/platforms/       offscreen + minimal
#     plugins/orchidlights/      13 output plugins + audio/ decoders
#     share/orchidlights/        fixtures, gobos, inputprofiles, midi
#                                templates, modifier templates, rgbscripts,
#                                web, Sample.qxw
#
# Duplicating that list here instead would be the classic two-copies bug: the
# AppImage gains a dependency, the desktop bundle silently loses audio.
#
# The web must be built first (pnpm build) -- CMake installs web/dist as-is.

set -euo pipefail

REPO=$(cd "$(dirname "$0")/../.." && pwd)
BUILD="$REPO/build-sidecar"
STAGE=$(mktemp -d)
OUT="$REPO/desktop/src-tauri/resources/sidecar"

trap 'rm -rf "$STAGE"' EXIT

[ -f "$REPO/web/dist/index.html" ] || {
    echo "web/dist is not built; run pnpm build in web/ first" >&2
    exit 1
}

cmake -S "$REPO" -B "$BUILD" -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -Dserver=ON -Dappimage=ON \
      -DINSTALL_ROOT="$STAGE" > /dev/null
cmake --build "$BUILD" --parallel "$(nproc || echo 4)"
cmake --install "$BUILD" > /dev/null

# The same non-negotiable the AppImage script has: a bundle without the
# fixture library looks like it works, which is worse than not working.
[ -f "$STAGE/share/orchidlights/fixtures/FixturesMap.xml" ] || {
    echo "the fixture library was not installed" >&2
    exit 1
}
[ -f "$STAGE/share/orchidlights/web/index.html" ] || {
    echo "the web interface was not installed" >&2
    exit 1
}

rm -rf "$OUT"
mkdir -p "$OUT/bin" "$OUT/qtplugins"

cp "$STAGE/usr/bin/orchidlightsd" "$OUT/bin/"
cp -r "$STAGE/usr/lib" "$OUT/lib"
# Keep libraries out of the systemd unit's way: that file is for a system
# install, not for a bundle.
rm -rf "$OUT/lib/systemd"
cp -r "$STAGE/usr/plugins/platforms" "$OUT/qtplugins/platforms"
cp -r "$STAGE/lib/qt6/plugins/orchidlights" "$OUT/plugins"
mv "$OUT/plugins" "$OUT/plugins.tmp"
mkdir -p "$OUT/plugins"
mv "$OUT/plugins.tmp" "$OUT/plugins/orchidlights"
cp -r "$STAGE/share" "$OUT/share"

# The icu glob in the CMake rules is deliberately wide and drags in static
# archives nothing at runtime can use; a bundle is no place for 80 MB of .a.
find "$OUT/lib" -name '*.a' -delete

strip "$OUT/bin/orchidlightsd" 2>/dev/null || true
find "$OUT/lib" -name 'libqlcplusengine.so*' -exec strip {} \; 2>/dev/null || true

# The daemon's audio decoders live under <plugins>/audio; assert rather than
# assume, because a silent bundle is the bug this whole script exists to stop.
[ -f "$OUT/plugins/orchidlights/audio/libsndfileplugin.so" ] || {
    echo "the audio decoder did not make it into the sidecar" >&2
    exit 1
}

echo "sidecar staged at $OUT"
du -sh "$OUT" | cut -f1
