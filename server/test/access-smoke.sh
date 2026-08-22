#!/bin/bash
#
# F20's access mask: the kiosk's cage, checked bar by bar.
#
#   server/test/access-smoke.sh [path-to-orchidlightsd]
#
# The mask closes AREAS to untrusted clients: writes answer 403 with the
# reason, reads stay open (it hides levers, not eyes), the strict token
# walks through it, and a kiosk phone cannot widen its own cage.

set -euo pipefail

DAEMON=${1:-orchidlightsd}
PORT=${PORT:-9953}

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

"$DAEMON" --port "$PORT" --no-output --projects "$WORK" "${EXTRA[@]+"${EXTRA[@]}"}" > "$WORK/daemon.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true; rm -rf "$WORK"' EXIT

for _ in $(seq 1 100); do
    curl -sf --max-time 1 "http://127.0.0.1:$PORT/api/v1/status" > /dev/null 2>&1 && break
    kill -0 $PID 2>/dev/null || { cat "$WORK/daemon.log" >&2; fail "the daemon exited early"; }
    sleep 0.2
done

BASE="http://127.0.0.1:$PORT/api/v1"
TOKEN=$(cat "$HOME/.orchidlights/api-token")
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

# Everything open by default.
[ "$(code -X POST -H 'Content-Type: application/json' -d '{"type":"Scene","name":"Libre"}' "$BASE/functions")" = 201 ] \
    || fail "with no mask set, creating a function should work"

# A phone cannot close (or open) the cage.
[ "$(code -X PUT -H 'Content-Type: application/json' -d '{"preset":"operate"}' "$BASE/access")" = 401 ] \
    || fail "setting the mask without the token should be 401"

# The operator's shell closes it to 'operate'.
[ "$(code -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"preset":"operate"}' "$BASE/access")" = 200 ] \
    || fail "setting the mask with the token should work"

# Reads say what is closed, so the web can hide it.
curl -s "$BASE/access" | grep -q '"functions":false' || fail "GET /access should say functions are closed"

# Writes in a closed area answer 403 with the reason...
[ "$(code -X POST -H 'Content-Type: application/json' -d '{"type":"Scene","name":"Presa"}' "$BASE/functions")" = 403 ] \
    || fail "creating a function under the operate mask should be 403"
curl -s -X POST -H 'Content-Type: application/json' -d '{"type":"Scene","name":"Presa"}' "$BASE/functions" \
    | grep -q "access mask" || fail "the 403 should say WHY"
[ "$(code -X POST -H 'Content-Type: application/json' -d '{"manufacturer":"Generic","model":"Generic RGBW","mode":"RGBW","universe":1,"address":1}' "$BASE/fixtures")" = 403 ] \
    || fail "patching a fixture under the mask should be 403"

# ...reads stay open (levers, not eyes)...
[ "$(code "$BASE/functions")" = 200 ] || fail "reading functions should stay open"

# ...the desk itself stays usable under 'operate'...
[ "$(code -X PUT -H 'Content-Type: application/json' -d '{"values":{"1":128}}' "$BASE/simpledesk/1/channels")" = 200 ] \
    || fail "the simple desk should answer under operate"

# ...and the strict token walks through the cage.
[ "$(code -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"type":"Scene","name":"Duena"}' "$BASE/functions")" = 201 ] \
    || fail "the strict token should bypass the mask"

# Kiosk closes even the desk.
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"preset":"kiosk"}' "$BASE/access" > /dev/null
[ "$(code -X PUT -H 'Content-Type: application/json' -d '{"values":{"1":0}}' "$BASE/simpledesk/1/channels")" = 403 ] \
    || fail "the kiosk preset should close the simple desk"

# And back to all, so nothing leaks into other smokes' assumptions.
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"preset":"all"}' "$BASE/access" > /dev/null
[ "$(code -X POST -H 'Content-Type: application/json' -d '{"type":"Scene","name":"Otra"}' "$BASE/functions")" = 201 ] \
    || fail "the all preset should reopen everything"

echo "Access smoke test passed."
