#!/bin/bash
#
# The script checker and the audio waveform, proved on known inputs.
#
#   server/test/scriptaudio-smoke.sh [path-to-orchidlightsd]
#
# The checker must point at the LINE that is wrong (the engine's own
# tokenizer, not a lookalike); the waveform of one second of sine followed by
# one second of silence must read loud-then-nothing, bucket by bucket -- a
# waveform that cannot tell sound from silence is decoration.

set -euo pipefail

DAEMON=${1:-orchidlightsd}
PORT=${PORT:-9939}

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

# A deterministic test tone: 1 s of 440 Hz at ~85 % of full scale, 1 s of
# silence. The waveform of THIS file is known in advance.
python3 - "$WORK/tone.wav" <<'PY'
import math, struct, sys, wave
w = wave.open(sys.argv[1], 'w')
w.setnchannels(1); w.setsampwidth(2); w.setframerate(44100)
frames = []
for i in range(44100):
    frames.append(struct.pack('<h', int(28000 * math.sin(2 * math.pi * 440 * i / 44100))))
frames.append(b'\x00\x00' * 44100)
w.writeframes(b''.join(frames)); w.close()
PY

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

# --- The checker points at the line -----------------------------------------
curl -s -X POST "${JSON[@]}" \
    -d '{"data":"wait:1000\nesto no es un comando\nsetfixture:0 ch:0 val:255"}' \
    "$BASE/script/check" > "$WORK/check.json"
python3 - "$WORK/check.json" <<'CHECK' || fail "the checker missed the bad line"
import json, sys
body = json.load(open(sys.argv[1]))
assert body["errors"] == [2], body
CHECK

curl -s -X POST "${JSON[@]}" -d '{"data":"wait:1000\nblackout:on"}' \
    "$BASE/script/check" > "$WORK/clean.json"
python3 - "$WORK/clean.json" <<'CHECK' || fail "a clean script was accused"
import json, sys
assert json.load(open(sys.argv[1]))["errors"] == [], "expected no errors"
CHECK

# --- The gel books are served -----------------------------------------------
curl -s "$BASE/colorfilters" > "$WORK/filters.json"
python3 - "$WORK/filters.json" <<'CHECK' || fail "the gel books did not arrive"
import json, sys
books = json.load(open(sys.argv[1]))["filters"]
named = next(b for b in books if b["name"] == "Named RGB")
snow = next(c for c in named["colors"] if c["name"] == "Snow")
assert snow["rgb"].upper() == "#FFFAFA", snow
CHECK

# --- The waveform tells sound from silence ----------------------------------
AUDIO=$(curl -s -X POST "${JSON[@]}" -d '{"type":"Audio","name":"Tono"}' "$BASE/functions" \
    | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -sf -X PUT "${JSON[@]}" -d "{\"source\":\"$WORK/tone.wav\"}" \
    "$BASE/functions/$AUDIO/body" > /dev/null || fail "the audio source was refused"

curl -s "$BASE/functions/$AUDIO/waveform?points=10" > "$WORK/wave.json"
python3 - "$WORK/wave.json" <<'CHECK' || fail "the waveform cannot tell sound from silence"
import json, sys
body = json.load(open(sys.argv[1]))
points = body["points"]
assert len(points) == 10, points
# First half: the sine, loud and steady (85 +/- 3). Second half: nothing.
assert all(80 <= p <= 90 for p in points[:5]), points
assert all(p <= 2 for p in points[5:]), points
assert abs(body["duration"] - 2000) < 100, body["duration"]
CHECK

echo "Script/audio smoke test passed."
