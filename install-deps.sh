#!/bin/bash
#
# Install everything needed to build OrchidLights on Debian and Ubuntu.
#
# This is the single source of truth for the dependency list: the README points
# here and CI runs it, so the two cannot drift apart.
#
#   --appimage   also install what create-appimage.sh needs

set -e

PACKAGES=(
    build-essential
    cmake
    ninja-build
    pkg-config

    # Qt 6.4 or newer: QHttpServer became an official module in 6.4.
    qt6-base-dev
    qt6-httpserver-dev
    qt6-websockets-dev
    qt6-declarative-dev
    qt6-multimedia-dev
    qt6-tools-dev
    qt6-serialport-dev   # the dmxusb plugin needs it, and upstream never says so
    libgl1-mesa-dev

    libudev-dev          # hotplugmonitor needs it, and upstream never says so
    libasound2-dev
    libusb-1.0-0-dev
    libftdi1-dev
    libmad0-dev
    libsndfile1-dev
    libfftw3-dev
)

if [ "${1:-}" = "--appimage" ]; then
    PACKAGES+=(chrpath wget)
fi

SUDO=""
if [ "$(id -u)" != "0" ]; then
    SUDO="sudo"
fi

$SUDO apt-get update
DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y --no-install-recommends "${PACKAGES[@]}"

echo
echo "Done. Next:"
echo "  cmake -S . -B build -G Ninja -Dserver=ON -DCMAKE_BUILD_TYPE=Release"
echo "  cmake --build build"
