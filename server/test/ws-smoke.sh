#!/bin/bash
#
# End-to-end check of the WebSocket live feed.
#
#   server/test/ws-smoke.sh [path-to-orchidlightsd] [path-to-project.qxw]
#
# Needs Node 22 or newer for its built-in WebSocket; nothing to install.

set -euo pipefail

DAEMON=${1:-orchidlightsd}
PROJECT=${2:-resources/samples/Sample.qxw}
PORT=${PORT:-9991}
BASE="http://127.0.0.1:$PORT/api/v1"
HERE=$(cd "$(dirname "$0")" && pwd)

export QT_QPA_PLATFORM=offscreen

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

wait_for_port() {
    local expect=$1 pid=$2
    for _ in $(seq 1 100); do
        local code
        code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 "$BASE/status" || true)
        [ "$code" = "$expect" ] && return 0
        kill -0 "$pid" 2>/dev/null || return 1
        sleep 0.2
    done
    return 1
}

# ---------------------------------------------------------------------------
# Open feed
# ---------------------------------------------------------------------------

"$DAEMON" --port "$PORT" --no-output "$PROJECT" > /tmp/orchid-ws.log 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT

wait_for_port 200 $PID || { cat /tmp/orchid-ws.log >&2; fail "the daemon never came up"; }

# A chaser, not a scene: a static scene changes the universe once and then
# holds, and the engine only emits on change, so it would prove nothing about
# streaming.
CHASER=$(curl -sf --max-time 5 "$BASE/functions" | python3 -c '
import json, sys
chasers = [f for f in json.load(sys.stdin) if f["type"] == "Chaser"]
assert chasers, "the project has no chaser to run"
print(chasers[0]["id"])
') || fail "could not pick a chaser"

REPORT=$(FUNCTION_ID=$CHASER node "$HERE/ws-client.mjs" "ws://127.0.0.1:$PORT/ws") \
    || fail "the websocket client failed: $REPORT"
echo "$REPORT"

python3 - "$REPORT" <<'PY' || exit 1
import json, sys
r = json.loads(sys.argv[1])
assert r["error"] is None, r["error"]
assert r["hello"], "no hello frame"
assert r["hello"]["apiVersion"] == 1, r["hello"]
assert r["hello"]["authRequired"] is False, "loopback should not demand a token"
assert r["functions"] > 0, "no function snapshot arrived"
assert not r["errors"], r["errors"]
# A running chaser rewrites its universe continuously, so the feed has to carry
# more than a single frame or the streaming is not actually streaming.
assert r["binaryFrames"] >= 2, f"only {r['binaryFrames']} binary frames"
assert r["universesInFrames"] == [1], r["universesInFrames"]
assert r["frameBytes"] > 2, "a frame carried a header and no channel data"
PY

kill $PID 2>/dev/null || true
wait $PID 2>/dev/null || true
trap - EXIT

# ---------------------------------------------------------------------------
# Authenticated feed
# ---------------------------------------------------------------------------

AUTH_PORT=$((PORT + 1))
BASE="http://127.0.0.1:$AUTH_PORT/api/v1"

"$DAEMON" --port "$AUTH_PORT" --no-output --require-auth "$PROJECT" \
    > /tmp/orchid-ws-auth.log 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT

wait_for_port 401 $PID || { cat /tmp/orchid-ws-auth.log >&2; fail "the daemon never came up"; }

TOKEN_PATH=$(grep -oE '/[^ ]*api-token' /tmp/orchid-ws-auth.log | head -1)
TOKEN=$(cat "$TOKEN_PATH")

# Wrong token: the socket must be closed, not merely ignored.
REPORT=$(FUNCTION_ID=$CHASER node "$HERE/ws-client.mjs" "ws://127.0.0.1:$AUTH_PORT/ws" wrong || true)
echo "$REPORT"
python3 - "$REPORT" <<'PY' || exit 1
import json, sys
r = json.loads(sys.argv[1])
assert r["hello"]["authRequired"] is True, r["hello"]
assert r["authenticated"] is False, "a wrong token was accepted"
assert r["binaryFrames"] == 0, "an unauthenticated socket received DMX"
PY

# Correct token: everything works.
REPORT=$(FUNCTION_ID=$CHASER node "$HERE/ws-client.mjs" "ws://127.0.0.1:$AUTH_PORT/ws" "$TOKEN") \
    || fail "the authenticated client failed: $REPORT"
echo "$REPORT"
python3 - "$REPORT" <<'PY' || exit 1
import json, sys
r = json.loads(sys.argv[1])
assert r["error"] is None, r["error"]
assert r["authenticated"] is True, "the correct token was rejected"
assert r["functions"] > 0, "no function snapshot after authenticating"
assert r["binaryFrames"] >= 2, f"only {r['binaryFrames']} binary frames"
PY

echo "WebSocket smoke test passed."
