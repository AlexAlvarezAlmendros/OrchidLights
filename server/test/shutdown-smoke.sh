#!/bin/bash
#
# A daemon that can be stopped on purpose, proved at both exits.
#
#   server/test/shutdown-smoke.sh [path-to-orchidlightsd]
#
# Three runs:
#   1. SIGTERM with --zero-on-exit  -> exit 0, last ArtNet frame dark
#   2. SIGTERM without the flag     -> exit 0, last ArtNet frame still holds
#      the look (walking away from a daemon mid-show must not black out the
#      venue)
#   3. POST /api/v1/shutdown        -> token demanded even on loopback, then
#      the same clean exit
#
# The frames are read off a UDP socket on 127.0.0.1:6454 -- the wire, not the
# model. Under blackout the engine's own stream keeps the old look while the
# plugins send zeros, so the wire is the only witness that can tell these
# runs apart.
#
# Needs Node 22 or newer.

set -euo pipefail

DAEMON=${1:-orchidlightsd}
PORT=${PORT:-9967}
HERE=$(cd "$(dirname "$0")" && pwd)

export QT_QPA_PLATFORM=offscreen

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/" 2>/dev/null; then
    fail "something is already listening on port $PORT; set PORT= to another one"
fi

WORK=$(mktemp -d)
PID=""
trap 'kill $PID 2>/dev/null || true; rm -rf "$WORK"' EXIT

# Extra daemon arguments -- the same hook the other smoke tests use, so an
# uninstalled build can point at a flat plugin directory.
read -r -a EXTRA <<< "${ORCHID_TEST_ARGS:-}"

TOKEN_FILE="$HOME/.orchidlights/api-token"

start_daemon() { # args: extra flags...
    "$DAEMON" --port "$PORT" "${EXTRA[@]+"${EXTRA[@]}"}" "$@" > "$WORK/daemon.log" 2>&1 &
    PID=$!

    for _ in $(seq 1 100); do
        curl -sf --max-time 1 "http://127.0.0.1:$PORT/api/v1/status" > /dev/null 2>&1 && return 0
        kill -0 $PID 2>/dev/null || { cat "$WORK/daemon.log" >&2; fail "the daemon exited early"; }
        sleep 0.2
    done
    fail "the daemon never answered on port $PORT"
}

# One run of the client against one daemon; $1 is yes/no for --zero-on-exit,
# $2 is the way the daemon dies: signal | route.
run_case() {
    local expect_zero=$1 exit_via=$2
    shift 2

    start_daemon "$@"
    local token
    token=$(cat "$TOKEN_FILE")

    # The client owns the sockets and the verdict; it prints READY-FOR-KILL
    # once the look is confirmed on the wire, and this script supplies the
    # death. A FIFO carries its output so the kill lands mid-listen.
    local out="$WORK/client-$expect_zero-$exit_via.log"
    node "$HERE/shutdown-client.mjs" "http://127.0.0.1:$PORT" "$token" "$expect_zero" \
        > "$out" 2>&1 &
    local CLIENT=$!

    for _ in $(seq 1 150); do
        grep -q "READY-FOR-KILL" "$out" 2>/dev/null && break
        kill -0 $CLIENT 2>/dev/null || { cat "$out" >&2; fail "the client gave up before the kill"; }
        sleep 0.2
    done
    grep -q "READY-FOR-KILL" "$out" || { cat "$out" >&2; fail "the look never reached the wire"; }

    if [ "$exit_via" = "route" ]; then
        local code
        code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
            -H "Authorization: Bearer $token" "http://127.0.0.1:$PORT/api/v1/shutdown")
        [ "$code" = "202" ] || fail "POST /shutdown with the token answered $code, wanted 202"
    else
        kill -TERM $PID
    fi

    # The exit code is half the point: a clean stop reports success.
    local status=0
    wait $PID || status=$?
    PID=""
    [ "$status" -eq 0 ] || { cat "$WORK/daemon.log" >&2; fail "the daemon exited $status, wanted 0"; }

    wait $CLIENT || { cat "$out" >&2; fail "the wire did not show what run '$expect_zero/$exit_via' promised"; }
    cat "$out"
}

echo "--- SIGTERM with --zero-on-exit: the rig goes dark ---"
run_case yes signal --zero-on-exit

echo "--- SIGTERM without the flag: the look survives the daemon ---"
run_case no signal

echo "--- POST /api/v1/shutdown: token-gated, then the same clean exit ---"
run_case yes route --zero-on-exit

echo "Shutdown smoke test passed."
