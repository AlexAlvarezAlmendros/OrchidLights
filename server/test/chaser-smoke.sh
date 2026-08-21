#!/bin/bash
#
# The chaser and sequence editors, proved on the wire and in the file.
#
#   server/test/chaser-smoke.sh [path-to-orchidlightsd]
#
# Per-step fades are MEASURED (a fadeIn of 1200 ms must leave many distinct
# intermediate frames on the wire); the reorder is a permutation the .qxw
# carries byte-visibly; a sequence's edited values are what the next run
# plays. Speeds acknowledged but not heard would rehearse a show on a lie.

set -euo pipefail

DAEMON=${1:-orchidlightsd}
PORT=${PORT:-9942}
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
read -r -a EXTRA <<< "${ORCHID_TEST_ARGS:-}"

"$DAEMON" --port "$PORT" --no-output --projects "$WORK" \
    "${EXTRA[@]+"${EXTRA[@]}"}" > "$WORK/daemon.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true; rm -rf "$WORK"' EXIT

for _ in $(seq 1 100); do
    curl -sf --max-time 1 "http://127.0.0.1:$PORT/api/v1/status" > /dev/null 2>&1 && break
    kill -0 $PID 2>/dev/null || { cat "$WORK/daemon.log" >&2; fail "the daemon exited early"; }
    sleep 0.2
done

node "$HERE/chaser-client.mjs" "http://127.0.0.1:$PORT" "ws://127.0.0.1:$PORT/ws" \
    "$WORK/pasos.qxw" || fail "the chaser did not do what it says"

echo "Chaser smoke test passed."
