#!/bin/bash
#
# Remote access, told honestly.
#
#   server/test/remote-smoke.sh [path-to-orchidlightsd] [path-to-project.qxw]
#
# Two daemons, two truths. One on --listen-all: /api/v1/remote is closed
# without the token, and with it names the machine's real doors -- URL with
# the token aboard -- plus every live WebSocket, each of which can be closed
# on purpose (the node half watches the close arrive on the wire). One on
# loopback: no doors at all, because a QR code to a URL that does not answer
# is worse than none.
#
# Needs Node 22+ (global WebSocket).

set -euo pipefail

DAEMON=${1:-orchidlightsd}
PROJECT=${2:-resources/samples/Sample.qxw}
PORT=${PORT:-9968}
PORT2=$((PORT + 1))
HERE=$(cd "$(dirname "$0")" && pwd)

export QT_QPA_PLATFORM=offscreen

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

for p in "$PORT" "$PORT2"; do
    if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$p/" 2>/dev/null; then
        fail "something is already listening on port $p; set PORT= to another one"
    fi
done

WORK=$(mktemp -d)
cp "$PROJECT" "$WORK/"
NAME=$(basename "$PROJECT")

read -r -a EXTRA <<< "${ORCHID_TEST_ARGS:-}"

"$DAEMON" --port "$PORT" --no-output --listen-all "${EXTRA[@]+"${EXTRA[@]}"}" \
    "$WORK/$NAME" > "$WORK/daemon.log" 2>&1 &
PID=$!
# Never `kill 0` here: with PID2 unset that would be the whole process
# group, this script and its caller included.
trap 'kill $PID 2>/dev/null || true; [ -n "${PID2:-}" ] && kill "$PID2" 2>/dev/null; rm -rf "$WORK"' EXIT

for _ in $(seq 1 100); do
    CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 "http://127.0.0.1:$PORT/api/v1/status" 2>/dev/null || true)
    [ "$CODE" != "000" ] && break
    kill -0 $PID 2>/dev/null || { cat "$WORK/daemon.log" >&2; fail "the daemon exited early"; }
    sleep 0.2
done

TOKEN=$(cat "$HOME/.orchidlights/api-token")
BASE="http://127.0.0.1:$PORT"
AUTH="Authorization: Bearer $TOKEN"

# Closed without the token: the join URL IS the key, so the route that hands
# it out must be behind the same door it opens.
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/remote")
[ "$CODE" = "401" ] || fail "/remote without a token answered $CODE, wanted 401"

STATE=$(curl -sf -H "$AUTH" "$BASE/api/v1/remote")

# Via the environment, not a pipe: the heredoc IS python's stdin.
STATE="$STATE" python3 - "$PORT" "$TOKEN" <<'PY' || exit 1
import json, os, sys

state = json.loads(os.environ['STATE'])
port, token = int(sys.argv[1]), sys.argv[2]

assert state['listenAll'] is True, f"listenAll: {state['listenAll']}"
assert state['authRequired'] is True, "listen-all must demand the token"
assert state['port'] == port, f"port: {state['port']} != {port}"
assert state['clients'] == [], f"nobody connected yet: {state['clients']}"

# A CI runner has a network interface; a door without the token in its URL
# would be a lock shown without its key.
assert len(state['addresses']) >= 1, f"no addresses: {state['addresses']}"
for door in state['addresses']:
    assert door['url'].startswith('http://'), door['url']
    assert f":{port}/" in door['url'], door['url']
    assert f"#token={token}" in door['url'], f"the join URL carries no token: {door['url']}"
    assert door['ip'] and door['ip'] != '127.0.0.1', f"loopback is not a door: {door['ip']}"
PY

# The live half: sockets appear in the list, and a DELETE reaches the wire.
node "$HERE/remote-client.mjs" "$BASE" "$TOKEN" || fail "the WebSocket half"

# The loopback daemon: same machine, no doors. Told apart from "no network"
# on purpose -- this daemon is not listening, and saying so is the feature.
"$DAEMON" --port "$PORT2" --no-output "${EXTRA[@]+"${EXTRA[@]}"}" \
    > "$WORK/daemon2.log" 2>&1 &
PID2=$!

for _ in $(seq 1 100); do
    curl -sf -o /dev/null --max-time 1 "http://127.0.0.1:$PORT2/api/v1/status" 2>/dev/null && break
    kill -0 $PID2 2>/dev/null || { cat "$WORK/daemon2.log" >&2; fail "the loopback daemon exited early"; }
    sleep 0.2
done

STATE2=$(curl -sf "http://127.0.0.1:$PORT2/api/v1/remote")
STATE="$STATE2" python3 - <<'PY' || exit 1
import json, os

state = json.loads(os.environ['STATE'])
assert state['listenAll'] is False, "loopback daemon claims to listen to the world"
assert state['addresses'] == [], f"doors that do not answer: {state['addresses']}"
assert state['localUrl'].startswith('http://127.0.0.1:'), state['localUrl']
PY

echo "Remote smoke test passed."
