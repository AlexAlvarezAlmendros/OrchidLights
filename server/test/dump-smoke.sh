#!/bin/bash
#
# The dump: what the desk holds, frozen into a scene -- exactly, no more.
#
#   server/test/dump-smoke.sh [path-to-orchidlightsd]
#
# The proof is the FILE: after the dump and a save, the .qxw must contain
# precisely the values the filters admit. A dump that writes more is a look
# that comes back wrong next week; one that writes less is a look that never
# comes back at all.

set -euo pipefail

DAEMON=${1:-orchidlightsd}
PORT=${PORT:-9951}

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
TOKEN=$(cat "$HOME/.orchidlights/api-token")
AUTH=(-H "Authorization: Bearer $TOKEN")

# A rig with mixed channel kinds: an RGBW bar (all four channels are group
# Intensity) and a MAC500 whose channel 0 is a Shutter. Plus, on the Simple
# Desk, a grip on bare wire at 500 where nothing is patched.
curl -sf -X POST "${JSON[@]}" \
    -d '{"manufacturer":"Generic","model":"Generic RGBW","mode":"RGBW","universe":1,"address":1}' \
    "$BASE/fixtures" > /dev/null || fail "patch RGBW"
curl -sf -X POST "${JSON[@]}" \
    -d '{"manufacturer":"Martin","model":"MAC500","mode":"DMX1","universe":1,"address":10}' \
    "$BASE/fixtures" > /dev/null || fail "patch MAC500"

# Simple Desk holds: bar R=255 G=128 B=0, the MAC's shutter=77, bare 500=99.
curl -sf -X PUT "${JSON[@]}" \
    -d '{"values":{"1":255,"2":128,"3":0,"10":77,"500":99}}' \
    "$BASE/simpledesk/1/channels" > /dev/null || fail "hold desk channels"
# And two grips through the LIVE desk (the plan's): the bar's W at 66 -- the
# dump must merge BOTH desks -- and the bar's R at 200, which the Simple Desk
# ALSO holds (at 255). One channel, two hands: the Simple Desk is the
# higher-priority fader on the wire, so its 255 must be the dumped truth.
curl -sf -X PUT "${JSON[@]}" \
    -d '{"values":[{"fixture":0,"channel":3,"value":66},{"fixture":0,"channel":0,"value":200}]}' \
    "$BASE/live" > /dev/null || fail "hold live values"
sleep 0.5

# --- The counter tells the whole truth --------------------------------------
curl -s "$BASE/dump" > "$WORK/state.json"
python3 - "$WORK/state.json" <<'CHECK' || fail "the counter lies"
import json, sys
state = json.load(open(sys.argv[1]))
# 4 desk values land on fixtures (bar R,G,B + shutter) + 1 live (bar W).
# The live grip on R is a DUPLICATE of the desk's: one channel, one entry.
assert state["count"] == 5, state
# Channel 500 has no fixture: counted APART, never silently dropped.
assert state["bare"] == 1, state
assert "Intensity" in state["groups"] and "Shutter" in state["groups"], state
CHECK

# --- Dump non-zero, Intensity only ------------------------------------------
# Admitted: bar R=255, G=128 and the live W=66. Refused: B (zero), the
# shutter (wrong group), channel 500 (no fixture to speak for it).
curl -s -X POST "${JSON[@]}" \
    -d '{"name":"Congelado","nonZeroOnly":true,"groups":["Intensity"]}' \
    "$BASE/dump" > "$WORK/made.json"
SCENE=$(python3 -c "import json;print(json.load(open('$WORK/made.json'))['scene'])")
WRITTEN=$(python3 -c "import json;print(json.load(open('$WORK/made.json'))['written'])")
[ "$WRITTEN" = "3" ] || fail "wrote $WRITTEN values, wanted 3 (255, 128 and the live 66)"

# --- The .qxw contains EXACTLY those SceneValues ----------------------------
curl -sf -X POST "${AUTH[@]}" "${JSON[@]}" -d "{\"path\":\"$WORK/dumped.qxw\"}" \
    "$BASE/project/save-as" > /dev/null || fail "save-as refused"
python3 - "$WORK/dumped.qxw" <<'CHECK' || fail "the .qxw is not exactly the filtered set"
import sys
import xml.etree.ElementTree as ET
tree = ET.parse(sys.argv[1])
scenes = [f for f in tree.iter() if f.tag.split('}')[-1] == 'Function'
          and f.get('Type') == 'Scene' and f.get('Name') == 'Congelado']
assert len(scenes) == 1, f"{len(scenes)} scenes named Congelado"
fixture_values = [e for e in scenes[0] if e.tag.split('}')[-1] == 'FixtureVal']
got = {e.get('ID'): (e.text or '') for e in fixture_values}
# One fixture, three (channel,value) pairs, sorted by channel -- and NOTHING
# else: no shutter, no zero, no bare wire, no second FixtureVal.
assert got == {'0': '0,255,1,128,3,66'}, got
CHECK

# --- Merge into the same scene: record-over means update --------------------
curl -sf -X PUT "${JSON[@]}" -d '{"values":{"1":10}}' "$BASE/simpledesk/1/channels" > /dev/null
sleep 0.3
curl -s -X POST "${JSON[@]}" \
    -d "{\"sceneId\":$SCENE,\"nonZeroOnly\":true,\"groups\":[\"Intensity\"]}" \
    "$BASE/dump" > /dev/null
curl -s "$BASE/functions/$SCENE/body" > "$WORK/body.json"
python3 - "$WORK/body.json" <<'CHECK' || fail "record-over did not update the value"
import json, sys
body = json.load(open(sys.argv[1]))
values = {(v["fixture"], v["channel"]): v["value"] for v in body["values"]}
assert values[(0, 0)] == 10, values
assert values[(0, 1)] == 128, values
CHECK

# --- Nothing to dump is an error, not an empty scene ------------------------
curl -sf -X DELETE "$BASE/simpledesk/1" > /dev/null
curl -sf -X DELETE "$BASE/live" > /dev/null
sleep 0.3
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${JSON[@]}" -d '{}' "$BASE/dump")
[ "$CODE" = "409" ] || fail "an empty dump answered $CODE, wanted 409"

echo "Dump smoke test passed."
