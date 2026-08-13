#!/bin/bash
#
# Build a self contained OrchidLights AppImage.
#
# Requires wget and chrpath. To bundle the official Qt packages instead of the
# system ones, export QTDIR first:
#   export QTDIR=/home/user/Qt/6.5.0/gcc_64

set -e

SOURCE_DIR=$(cd "$(dirname "$0")" && pwd)
TARGET_DIR=${TARGET_DIR:-$HOME/orchidlights.AppDir}
BUILD_DIR=$SOURCE_DIR/build-appimage

for tool in chrpath wget; do
    if ! command -v $tool >/dev/null 2>&1; then
        echo "$tool could not be found. Install it before running this script"
        exit 1
    fi
done

rm -rf "$BUILD_DIR" "$TARGET_DIR"
mkdir -p "$BUILD_DIR"

if [ -n "$QTDIR" ]; then
    QT_PREFIX="$QTDIR/lib/cmake/"
else
    QT_PREFIX="/usr/lib/x86_64-linux-gnu/cmake/Qt6"
fi

cmake -S "$SOURCE_DIR" -B "$BUILD_DIR" \
      -DCMAKE_PREFIX_PATH="$QT_PREFIX" \
      -DCMAKE_BUILD_TYPE=Release \
      -Dserver=ON -Dappimage=ON \
      -DINSTALL_ROOT="$TARGET_DIR"

cmake --build "$BUILD_DIR" --parallel "$(nproc || echo 8)"
cmake --install "$BUILD_DIR"

# The fixture library is not optional baggage. Without it every patched fixture
# degrades to a generic dimmer, so a bundle that omits it is worse than useless:
# it looks like it works.
#
# Note the AppImage layout: appimage=ON makes DATADIR relative, so the data
# lands in <AppDir>/share while the binary stays in <AppDir>/usr/bin.
if [ ! -f "$TARGET_DIR/share/orchidlights/fixtures/FixturesMap.xml" ]; then
    echo "ERROR: the fixture library was not installed into the AppDir"
    exit 1
fi

cp -v "$SOURCE_DIR/resources/icons/svg/orchidlights.svg" "$TARGET_DIR/"
cp -v "$SOURCE_DIR/platforms/linux/orchidlights.desktop" "$TARGET_DIR/"

strip "$TARGET_DIR/usr/bin/orchidlightsd"
find "$TARGET_DIR/usr/lib/" -name 'libqlcplusengine.so*' -exec strip -v {} \;
chrpath -r "../lib" "$TARGET_DIR/usr/bin/orchidlightsd" || true

# Our own AppRun, not the AppImageKit one: see the comment inside it for why.
cp -v "$SOURCE_DIR/platforms/linux/AppRun" "$TARGET_DIR/AppRun"
chmod a+x "$TARGET_DIR/AppRun"

wget -c https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage \
     -O /tmp/appimagetool-x86_64.AppImage
chmod a+x /tmp/appimagetool-x86_64.AppImage

OUTPUT=${OUTPUT:-$SOURCE_DIR/OrchidLights-x86_64.AppImage}
ARCH=x86_64 /tmp/appimagetool-x86_64.AppImage --no-appstream "$TARGET_DIR" "$OUTPUT"

echo "The application is now available at $OUTPUT"
