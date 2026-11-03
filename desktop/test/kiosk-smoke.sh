#!/bin/bash
#
# The kiosk window enters with an operator's key, not the master.
#
#   desktop/test/kiosk-smoke.sh [path-to-shell-binary] [path-to-orchidlightsd]
#
# The master key walks through the access mask, so a kiosk that carried it
# was caged by its interface and its PIN alone. Asserted from outside:
#
#   1. --kiosk pairs ONE operate device for the window and keeps its key in
#      ~/.orchidlights/kiosk-key, owner only;
#   2. the window's own connection is that device -- the remote screen says
#      so -- and the key cannot build anything;
#   3. a second launch reuses the key: one kiosk in the device list, not one
#      per boot;
#   4. a revoked kiosk key is replaced on the next launch, and the stale row
#      goes with it.
#
# Runs with a throwaway HOME: the keys it pairs are not yours. Needs a display
# (xvfb-run in CI) -- the kiosk is a fullscreen window.

set -euo pipefail

REPO=$(cd "$(dirname "$0")/../.." && pwd)
SHELL_BIN=${1:-"$REPO/desktop/src-tauri/target/debug/orchidlights-desktop"}
DAEMON=${2:-"$REPO/build/server/src/orchidlightsd"}

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

[ -x "$SHELL_BIN" ] || fail "no shell binary at $SHELL_BIN (cargo build first)"
[ -x "$DAEMON" ] || fail "no daemon at $DAEMON"
[ -f "$REPO/web/dist/index.html" ] || fail "web/dist is not built (pnpm build first)"

PLUGINS=$("$REPO/desktop/scripts/dev-plugin-dir.sh" "$(dirname "$(dirname "$(dirname "$DAEMON")")")")
export ORCHID_SIDECAR="$DAEMON"
export ORCHID_PLUGIN_DIR="$PLUGINS"

WORK=$(mktemp -d)
export HOME="$WORK/home"
mkdir -p "$HOME"
KEY_FILE="$HOME/.orchidlights/kiosk-key"
SHELL_PID=""
# WebKit's helper processes outlive the shell by a moment and keep writing
# their caches; the first rm can race them.
cleanup() {
    kill -9 $SHELL_PID 2>/dev/null || true
    rm -rf "$WORK" 2>/dev/null || { sleep 1; rm -rf "$WORK"; }
}
trap cleanup EXIT

BASE=""
MASTER=""
DAEMON_PID=""

launch() {
    "$SHELL_BIN" --kiosk >> "$WORK/shell.log" 2>&1 &
    SHELL_PID=$!

    DAEMON_PID=""
    for _ in $(seq 1 120); do
        DAEMON_PID=$(pgrep -P "$SHELL_PID" orchidlightsd | head -1 || true)
        [ -n "$DAEMON_PID" ] && break
        kill -0 $SHELL_PID 2>/dev/null || { cat "$WORK/shell.log" >&2; fail "the shell exited before starting the daemon"; }
        sleep 0.5
    done
    [ -n "$DAEMON_PID" ] || fail "the shell never started a daemon"

    local port=""
    for _ in $(seq 1 60); do
        port=$(tr '\0' '\n' < "/proc/$DAEMON_PID/cmdline" 2>/dev/null | grep -A1 '^--port$' | tail -1 || true)
        [ -n "$port" ] && break
        sleep 0.25
    done
    BASE="http://127.0.0.1:$port/api/v1"

    for _ in $(seq 1 100); do
        [ -f "$HOME/.orchidlights/api-token" ] \
            && [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/status")" = "401" ] && break
        sleep 0.3
    done
    MASTER=$(cat "$HOME/.orchidlights/api-token")
}

close() {
    kill -TERM "$SHELL_PID"
    wait "$SHELL_PID" 2>/dev/null || true
    for _ in $(seq 1 40); do
        kill -0 "$DAEMON_PID" 2>/dev/null || return 0
        sleep 0.25
    done
    fail "the daemon outlived its shell"
}

kiosks() {
    curl -sf -H "Authorization: Bearer $MASTER" "$BASE/devices" | python3 -c '
import json, sys
print(" ".join(str(d["id"]) for d in json.load(sys.stdin)["devices"] if d["name"] == "Kiosko de este equipo"))'
}

# The window's own WebSocket, as the remote screen lists it.
window_is_kiosk_device() {
    for _ in $(seq 1 60); do
        if curl -sf -H "Authorization: Bearer $MASTER" "$BASE/remote" | python3 -c '
import json, sys
clients = json.load(sys.stdin)["clients"]
sys.exit(0 if any(c.get("device") == "Kiosko de este equipo" and c.get("role") == "operate"
                  for c in clients) else 1)' 2>/dev/null; then
            return 0
        fi
        sleep 0.5
    done
    return 1
}

# --- 1 and 2: the first launch pairs, and the window is that device ---------

launch
for _ in $(seq 1 40); do [ -f "$KEY_FILE" ] && break; sleep 0.25; done
[ -f "$KEY_FILE" ] || { cat "$WORK/shell.log" >&2; fail "no kiosk key at $KEY_FILE"; }
[ "$(stat -c %a "$KEY_FILE")" = "600" ] || fail "the kiosk key is $(stat -c %a "$KEY_FILE"), wanted 600"
KEY=$(cat "$KEY_FILE")
[ "$KEY" != "$MASTER" ] || fail "the kiosk key IS the master"
echo "ok   --kiosk pairs a key of its own, owner only"

ROLE=$(curl -sf -H "Authorization: Bearer $KEY" "$BASE/access" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["role"])')
[ "$ROLE" = "operate" ] || fail "the kiosk key reads as $ROLE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $KEY" \
    -H 'Content-Type: application/json' -d '{"type":"Scene","name":"Desde el kiosko"}' "$BASE/functions")
[ "$CODE" = "403" ] || fail "the kiosk key built a function ($CODE)"
echo "ok   the kiosk key is an operator's: it cannot build"

window_is_kiosk_device || { cat "$WORK/shell.log" >&2; fail "the kiosk window is not connected as the kiosk device"; }
echo "ok   the window itself is on the desk as that device"

FIRST=$(kiosks)
[ -n "$FIRST" ] && [ "$(echo "$FIRST" | wc -w)" = "1" ] || fail "kiosk devices after the first launch: '$FIRST'"
close

# --- 3: a second launch reuses it --------------------------------------------

launch
window_is_kiosk_device || fail "the second kiosk window is not the kiosk device"
[ "$(cat "$KEY_FILE")" = "$KEY" ] || fail "the second launch replaced a key that still worked"
[ "$(kiosks)" = "$FIRST" ] || fail "the second launch paired another kiosk: '$(kiosks)'"
echo "ok   a second launch reuses the key: one kiosk, not one per boot"

# --- 4: revoked, and replaced ------------------------------------------------

curl -sf -X DELETE -H "Authorization: Bearer $MASTER" "$BASE/devices/$FIRST" > /dev/null \
    || fail "could not revoke the kiosk"
close

launch
window_is_kiosk_device || fail "after a revoke the kiosk window did not come back as the kiosk device"
NEW=$(cat "$KEY_FILE")
[ "$NEW" != "$KEY" ] || fail "a revoked key was kept"
SECOND=$(kiosks)
[ "$(echo "$SECOND" | wc -w)" = "1" ] && [ "$SECOND" != "$FIRST" ] \
    || fail "kiosk devices after a revoke: '$SECOND' (first was $FIRST)"
echo "ok   a revoked kiosk key is replaced, and only one kiosk is listed"
close

echo "Kiosk smoke test passed."
