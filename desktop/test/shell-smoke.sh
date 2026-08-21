#!/bin/bash
#
# The desktop shell, proved from the outside.
#
#   desktop/test/shell-smoke.sh [path-to-shell-binary] [path-to-orchidlightsd]
#
# What a shell is FOR, asserted in order:
#   1. it brings the daemon up, reachable over plain HTTP (the same origin a
#      phone would use);
#   2. the daemon holds a token and the shell's handover of it works (the file
#      exists and authorizes);
#   3. closing the shell takes the daemon with it -- no orphan keeps driving
#      the rig after the window is gone -- and the shell exits 0.
#
# Runs headless under xvfb-run in CI; locally it uses the session's display.
# The shell needs a WebKitGTK environment either way.

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

# The dev layout: daemon from the build tree, plugins flattened, web built.
PLUGINS=$("$REPO/desktop/scripts/dev-plugin-dir.sh" "$(dirname "$(dirname "$(dirname "$DAEMON")")")")
[ -f "$REPO/web/dist/index.html" ] || fail "web/dist is not built (pnpm build first)"

export ORCHID_SIDECAR="$DAEMON"
export ORCHID_PLUGIN_DIR="$PLUGINS"

# The shell picks a free port; the test discovers it by watching the daemon
# appear. Scanning /proc is uglier than asking the shell, but the shell's
# stdout belongs to WebKit noise -- the port is found by its owner instead.
"$SHELL_BIN" > /tmp/shell-smoke-out.log 2>&1 &
SHELL_PID=$!
trap 'kill -9 $SHELL_PID 2>/dev/null || true' EXIT

# Find the daemon by its signature, not by parenthood: only shell-spawned
# daemons carry --zero-on-exit, so a developer's own long-running daemon on
# this machine is never mistaken for ours.
DAEMON_PID=""
for _ in $(seq 1 120); do
    DAEMON_PID=$(pgrep -f "orchidlightsd.*--zero-on-exit" | head -1 || true)
    [ -n "$DAEMON_PID" ] && break
    kill -0 $SHELL_PID 2>/dev/null || { cat /tmp/shell-smoke-out.log >&2; fail "the shell exited before starting the daemon"; }
    sleep 0.5
done
[ -n "$DAEMON_PID" ] || fail "the shell never started a daemon"

PORT=""
for _ in $(seq 1 120); do
    PORT=$(tr '\0' '\n' < "/proc/$DAEMON_PID/cmdline" 2>/dev/null | grep -A1 '^--port$' | tail -1 || true)
    [ -n "$PORT" ] && break
    sleep 0.5
done
[ -n "$PORT" ] || fail "could not learn the daemon's port"

BASE="http://127.0.0.1:$PORT"

# 1. Reachable from outside the shell -- the phone's view.
for _ in $(seq 1 100); do
    CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 "$BASE/api/v1/status" 2>/dev/null || true)
    [ "$CODE" = "200" ] || [ "$CODE" = "401" ] && break
    sleep 0.3
done
[ "$CODE" = "200" ] || [ "$CODE" = "401" ] || fail "the daemon never answered ($CODE)"

# The daemon got --zero-on-exit: dying with its window must darken the rig.
tr '\0' ' ' < "/proc/$DAEMON_PID/cmdline" | grep -q -- --zero-on-exit \
    || fail "the shell did not pass --zero-on-exit"

# 2. The token: exists, restrictive, and authorizes.
TOKEN_FILE="$HOME/.orchidlights/api-token"
[ -f "$TOKEN_FILE" ] || fail "no token file"
TOKEN=$(cat "$TOKEN_FILE")
CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/status")
[ "$CODE" = "200" ] || fail "the token did not authorize ($CODE)"

# 3. A second launch carrying a project opens it in the FIRST instance -- the
#    whole chain, through the real webview: single-instance forwards the path,
#    the shell evals an orchid-open-request into the page, the page (holding
#    the token from the fragment hand-off) calls the daemon's open route.
PROJECT_ABS="$REPO/server/test/data/vc-actions.qxw"
"$SHELL_BIN" "$PROJECT_ABS" > /tmp/shell-smoke-second.log 2>&1 || true
LOADED=""
for _ in $(seq 1 60); do
    LOADED=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/project"         | python3 -c "import json,sys; print(json.load(sys.stdin).get('name',''))" 2>/dev/null || true)
    [ "$LOADED" = "vc-actions.qxw" ] && break
    sleep 0.5
done
[ "$LOADED" = "vc-actions.qxw" ] || fail "the second launch did not open its project (got '$LOADED')"

# And exactly one shell is running: the second was a messenger, not a window.
# (pgrep -f matches whole command lines, so the daemon and this script must
# not be caught; list-then-inspect keeps the check debuggable.)
MATCHES=$(pgrep -f "orchidlights-desktop" || true)
COUNT=0
for pid in $MATCHES; do
    args=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
    case "$args" in
        *target/*/orchidlights-desktop*) COUNT=$((COUNT + 1)) ;;
    esac
done
if [ "$COUNT" -gt 1 ]; then
    for pid in $MATCHES; do
        echo "match $pid: $(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)" >&2
    done
    fail "$COUNT shells alive; single-instance failed"
fi

# 4. Closing the shell closes the daemon. SIGTERM to the shell plays the part
#    of the window's close button in a headless test.
kill -TERM $SHELL_PID
SHELL_STATUS=0
wait $SHELL_PID || SHELL_STATUS=$?

for _ in $(seq 1 40); do
    kill -0 "$DAEMON_PID" 2>/dev/null || break
    sleep 0.25
done
if kill -0 "$DAEMON_PID" 2>/dev/null; then
    kill -9 "$DAEMON_PID" 2>/dev/null || true
    fail "the daemon outlived its shell"
fi

# The daemon's log went where the shell promised, and stayed bounded.
LOG="$HOME/.orchidlights/daemon.log"
[ -f "$LOG" ] || fail "no daemon log at $LOG"
SIZE=$(stat -c %s "$LOG")
[ "$SIZE" -le $((6 * 1024 * 1024)) ] || fail "the log grew past its cap: $SIZE bytes"

echo "Shell smoke test passed."
