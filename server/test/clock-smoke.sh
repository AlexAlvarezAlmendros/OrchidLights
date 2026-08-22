#!/bin/bash
#
# The clock's weekly agenda, running in the daemon.
#
#   server/test/clock-smoke.sh [path-to-orchidlightsd]
#
# An alarm that only rings while a browser is open is not an alarm: the
# schedule is written into the console, every client disconnects, and the
# function must START anyway -- read from the wire-facing API, not from any
# UI. A schedule for the wrong weekday must NOT fire, and a stop time stops.

set -euo pipefail

DAEMON=${1:-orchidlightsd}
PORT=${PORT:-9936}

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

BASE="http://127.0.0.1:$PORT/api/v1"
JSON=(-H "Content-Type: application/json")

# Scenes with a VALUE: an empty scene stops itself the instant it starts,
# which reads exactly like an alarm that never rang.
curl -sf -X POST "${JSON[@]}" \
    -d '{"manufacturer":"Generic","model":"Generic RGBW","mode":"RGBW","universe":1,"address":1}' \
    "$BASE/fixtures" > /dev/null || fail "patch fixture"
SCENE=$(curl -s -X POST "${JSON[@]}" -d '{"type":"Scene","name":"Alarma"}' "$BASE/functions" \
    | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
OTHER=$(curl -s -X POST "${JSON[@]}" -d '{"type":"Scene","name":"NoHoy"}' "$BASE/functions" \
    | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -sf -X POST "${JSON[@]}" -d '{"fixture":0,"channel":0,"value":200}' \
    "$BASE/functions/$SCENE/values" > /dev/null
curl -sf -X POST "${JSON[@]}" -d '{"fixture":0,"channel":1,"value":200}' \
    "$BASE/functions/$OTHER/values" > /dev/null

CLOCK=$(curl -s -X POST "${JSON[@]}" -d '{"type":"clock","caption":"Agenda"}' "$BASE/vc/widgets" \
    | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# Two schedules: one three seconds from now with a stop three seconds later,
# one at the same time but masked to the WRONG weekday.
NOW_PLUS_3=$(date -d '+3 seconds' +%H:%M:%S)
NOW_PLUS_6=$(date -d '+6 seconds' +%H:%M:%S)
TODAY_BIT=$((1 << ($(date +%u) - 1)))
WRONG_MASK=$(( (~TODAY_BIT) & 0x7F ))

curl -sf -X PATCH "${JSON[@]}" \
    -d "{\"schedules\":[
          {\"function\":$SCENE,\"start\":\"$NOW_PLUS_3\",\"stop\":\"$NOW_PLUS_6\"},
          {\"function\":$OTHER,\"start\":\"$NOW_PLUS_3\",\"weekFlags\":$WRONG_MASK}
        ]}" \
    "$BASE/vc/widgets/$CLOCK" > /dev/null || fail "the agenda was refused"

running() {
    curl -s "$BASE/functions" | python3 -c "
import json, sys
functions = {f['id']: f['running'] for f in json.load(sys.stdin)}
print('yes' if functions.get($1, False) else 'no')"
}

# Nothing yet: the alarm is set, not ringing.
[ "$(running "$SCENE")" = "no" ] || fail "the alarm rang before its time"

# Within ~6 s the scene must have started, and the wrong-day one must not.
STARTED=no
for _ in $(seq 1 25); do
    sleep 0.4
    [ "$(running "$SCENE")" = "yes" ] && { STARTED=yes; break; }
done
[ "$STARTED" = "yes" ] || fail "the alarm never rang (and no browser was open to blame)"
[ "$(running "$OTHER")" = "no" ] || fail "a schedule for the wrong weekday fired"

# And the stop hand puts it away.
STOPPED=no
for _ in $(seq 1 25); do
    sleep 0.4
    [ "$(running "$SCENE")" = "no" ] && { STOPPED=yes; break; }
done
[ "$STOPPED" = "yes" ] || fail "the stop time never stopped it"

echo "Clock smoke test passed."
