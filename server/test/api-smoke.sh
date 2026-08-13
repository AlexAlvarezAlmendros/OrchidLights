#!/bin/bash
#
# End-to-end check of the web API against a real project.
#
# Starts the daemon, drives it over HTTP, and stops it. Runs the same way
# locally and in CI so a failure here is reproducible on a desk.
#
#   server/test/api-smoke.sh [path-to-orchidlightsd] [path-to-project.qxw]

set -euo pipefail

DAEMON=${1:-orchidlightsd}
PROJECT=${2:-resources/samples/Sample.qxw}
PORT=${PORT:-9998}
BASE="http://127.0.0.1:$PORT/api/v1"

export QT_QPA_PLATFORM=offscreen

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

# --no-output: this is a test, it has no business putting DMX on the network.
"$DAEMON" --port "$PORT" --no-output "$PROJECT" > /tmp/orchid-api-smoke.log 2>&1 &
DAEMON_PID=$!
trap 'kill $DAEMON_PID 2>/dev/null || true' EXIT

# Wait for the port instead of sleeping blind: engine startup parses a 1700
# fixture library and takes noticeably longer on a cold cache.
for _ in $(seq 1 100); do
    if curl -sf --max-time 1 "$BASE/status" > /dev/null 2>&1; then
        break
    fi
    if ! kill -0 $DAEMON_PID 2>/dev/null; then
        cat /tmp/orchid-api-smoke.log >&2
        fail "the daemon exited before it started listening"
    fi
    sleep 0.2
done

STATUS=$(curl -sf --max-time 5 "$BASE/status") || fail "GET /status did not answer"
echo "$STATUS"

python3 - "$STATUS" <<'PY' || exit 1
import json, sys
s = json.loads(sys.argv[1])
assert s["apiVersion"] == 1, s
assert s["manufacturers"] > 100, s["manufacturers"]
assert s["fixtures"] > 0, s
assert s["functions"] > 0, s
assert s["runningFunctions"] == 0, s
PY

# Every fixture in the sample must have resolved to a real definition, not a
# generic dimmer standing in for one.
curl -sf --max-time 5 "$BASE/fixtures" | python3 -c '
import json, sys
fixtures = json.load(sys.stdin)
assert fixtures, "no fixtures"
unresolved = [f["name"] for f in fixtures if not f["resolved"]]
assert not unresolved, f"unresolved fixtures: {unresolved}"
assert all(f["universe"] >= 1 and f["address"] >= 1 for f in fixtures), "addresses must be 1-based"
' || fail "GET /fixtures"

# Pick a scene and drive it.
FUNC=$(curl -sf --max-time 5 "$BASE/functions" | python3 -c '
import json, sys
scenes = [f for f in json.load(sys.stdin) if f["type"] == "Scene"]
assert scenes, "no scenes in the project"
print(scenes[0]["id"])
') || fail "GET /functions"

CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST --max-time 5 "$BASE/functions/$FUNC/start")
[ "$CODE" = "202" ] || fail "POST start answered $CODE, expected 202 Accepted"

# The engine transitions on its next tick, so poll rather than assume.
for _ in $(seq 1 25); do
    RUNNING=$(curl -sf --max-time 5 "$BASE/status" | python3 -c 'import json,sys; print(json.load(sys.stdin)["runningFunctions"])')
    [ "$RUNNING" -gt 0 ] && break
    sleep 0.2
done
[ "$RUNNING" -gt 0 ] || fail "the function never started"

curl -sf --max-time 5 "$BASE/functions" | python3 -c "
import json, sys
running = [f for f in json.load(sys.stdin) if f['running']]
assert any(f['id'] == $FUNC for f in running), f'function $FUNC is not among {running}'
" || fail "the started function is not reported as running"

# Blackout is the button every desk has; it must stop everything.
curl -sf -X POST --max-time 5 "$BASE/blackout" > /dev/null || fail "POST /blackout"
for _ in $(seq 1 25); do
    RUNNING=$(curl -sf --max-time 5 "$BASE/status" | python3 -c 'import json,sys; print(json.load(sys.stdin)["runningFunctions"])')
    [ "$RUNNING" -eq 0 ] && break
    sleep 0.2
done
[ "$RUNNING" -eq 0 ] || fail "blackout left $RUNNING functions running"

curl -sf -X DELETE --max-time 5 "$BASE/blackout" > /dev/null || fail "DELETE /blackout"

# Unknown ids must 404 rather than crash or silently succeed.
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST --max-time 5 "$BASE/functions/999999/start")
[ "$CODE" = "404" ] || fail "an unknown function answered $CODE, expected 404"

# Nothing outside loopback by default: there is no authentication yet.
if command -v ss > /dev/null; then
    ss -ltn "sport = :$PORT" | grep -qE '127\.0\.0\.1|\[::1\]' \
        || fail "the daemon is not bound to loopback only"
fi

echo "API smoke test passed."
