#!/bin/bash
#
# Audio functions: whether they make a sound, measured.
#
#   server/test/audioplay-smoke.sh [path-to-orchidlightsd] [path-to-project.qxw]
#
# Everything else in this repository that claims to move light reads DMX back
# off the wire. This is the same idea for the one function type whose output is
# not DMX: the daemon plays a generated tone into a sink of its own, and the
# test records that sink and looks at the samples.
#
# Two things have to be true for an Audio function to make a sound -- a decoder
# that can read the file, and an output to put the samples on -- and until now
# neither was checked anywhere. A function that reads its file, reports its
# length and plays nothing looks exactly like one that has not been started.
#
# On a machine with no sound server (every CI runner) the whole measurement is
# impossible, so the test asserts the other half instead: that the daemon says
# it cannot play, and says which of the two things is missing.

set -euo pipefail

DAEMON=${1:-orchidlightsd}
PROJECT=${2:-server/test/data/vc-references.qxw}
PORT=${PORT:-9947}

export QT_QPA_PLATFORM=offscreen

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/" 2>/dev/null; then
    fail "something is already listening on port $PORT; set PORT= to another one"
fi

WORK=$(mktemp -d)
cp "$PROJECT" "$WORK/"
NAME=$(basename "$PROJECT")

# The decoders are not in one directory in the build tree -- each plugin builds
# into its own -- so gather what is needed into a directory shaped the way an
# install is. A test that only passes against an installed daemon is a test
# nobody runs while working.
PLUGINS="$WORK/plugins"
mkdir -p "$PLUGINS/audio"
found=0
for lib in build/engine/audio/plugins/*/*.so; do
    [ -e "$lib" ] || continue
    ln -sf "$(realpath "$lib")" "$PLUGINS/audio/$(basename "$lib")"
    found=1
done

# An installed daemon has them already; fall back to letting it resolve its own.
PLUGIN_ARGS=()
if [ "$found" = "1" ]; then
    # ioPlugins() only accepts a directory that holds at least one plugin, so
    # the output plugins have to be there too for the audio subdirectory to be
    # reached. Anything that loads will do; nothing is patched to them.
    for lib in build/plugins/*/*.so; do
        [ -e "$lib" ] || continue
        ln -sf "$(realpath "$lib")" "$PLUGINS/$(basename "$lib")"
    done
    PLUGIN_ARGS=(--plugins "$PLUGINS")
fi

# A tone of known amplitude, so the numbers coming back can be checked rather
# than merely being non-zero.
TONE="$WORK/tono.wav"
python3 - "$TONE" <<'PY'
import math, struct, sys, wave

RATE, SECONDS, PEAK = 44100, 3, 20000

with wave.open(sys.argv[1], 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(RATE)
    frames = bytearray()
    for i in range(RATE * SECONDS):
        v = int(PEAK * math.sin(2 * math.pi * 440 * i / RATE))
        frames += struct.pack('<hh', v, v)
    w.writeframes(bytes(frames))
PY

SINK=""
PID=""
cleanup() {
    [ -n "$PID" ] && kill "$PID" 2>/dev/null
    [ -n "$SINK" ] && pactl unload-module "$SINK" 2>/dev/null
    rm -rf "$WORK"
    return 0
}
trap cleanup EXIT

"$DAEMON" --port "$PORT" --no-output "${PLUGIN_ARGS[@]+"${PLUGIN_ARGS[@]}"}" \
    "$WORK/$NAME" > "$WORK/daemon.log" 2>&1 &
PID=$!

for _ in $(seq 1 100); do
    curl -sf --max-time 1 "http://127.0.0.1:$PORT/api/v1/status" > /dev/null 2>&1 && break
    kill -0 $PID 2>/dev/null || { cat "$WORK/daemon.log" >&2; fail "the daemon exited early"; }
    sleep 0.2
done

B="http://127.0.0.1:$PORT/api/v1"

# --no-output is a statement about the DMX network. It used to take the audio
# decoders with it, which meant every test in this repository ran with audio
# switched off and nobody could tell.
curl -sf --max-time 5 "$B/audio" | python3 -c "
import json, sys
a = json.load(sys.stdin)
assert a['formats'], ('no decoder was loaded under --no-output', a)
assert any(f.endswith('wav') for f in a['formats']), a['formats']
" || fail "the decoders did not load with --no-output"

# ---------------------------------------------------------------------------
# Without a sound server there is nothing to measure, and the daemon has to say
# so rather than offer a play button that does nothing.
# ---------------------------------------------------------------------------
if ! pactl info > /dev/null 2>&1 || ! command -v parec > /dev/null 2>&1; then
    curl -sf --max-time 5 "$B/audio" | python3 -c "
import json, sys
a = json.load(sys.stdin)
assert a['canPlay'] is False, ('claims it can play with no sound server', a)
assert a.get('silentBecause'), ('and does not say why', a)
print('no sound server here, so the daemon reports:', a['silentBecause'])
" || fail "the daemon claimed it could play with no sound server"
    echo "Audio playback smoke test: nothing to play through, honesty checked instead."
    exit 0
fi

SINK=$(pactl load-module module-null-sink sink_name=orchid_test \
       sink_properties=device.description=OrchidTest 2>/dev/null) \
    || { echo "could not create a test sink; skipping"; exit 0; }

# Let the daemon see the sink that was just created.
kill "$PID" 2>/dev/null
wait "$PID" 2>/dev/null || true
"$DAEMON" --port "$PORT" --no-output "${PLUGIN_ARGS[@]+"${PLUGIN_ARGS[@]}"}" \
    "$WORK/$NAME" > "$WORK/daemon.log" 2>&1 &
PID=$!
for _ in $(seq 1 100); do
    curl -sf --max-time 1 "$B/status" > /dev/null 2>&1 && break
    sleep 0.2
done

curl -sf --max-time 5 "$B/audio" | python3 -c "
import json, sys
a = json.load(sys.stdin)
assert a['canPlay'] is True, ('cannot play with a sink right there', a)
assert 'OrchidTest' in a['outputs'], ('the new sink is not listed', a['outputs'])
assert 'silentBecause' not in a, a
" || fail "the daemon did not see the test sink"

ID=$(curl -sf --max-time 5 -X POST "$B/functions" -H 'Content-Type: application/json' \
     -d '{"type":"audio","name":"Tono"}' \
     | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')

curl -sf --max-time 5 -X PUT "$B/functions/$ID/body" -H 'Content-Type: application/json' \
    -d "{\"source\":\"$TONE\",\"device\":\"OrchidTest\",\"volume\":1.0}" > /dev/null \
    || fail "PUT the audio body"

curl -sf --max-time 5 "$B/functions/$ID/body" | python3 -c "
import json, sys
b = json.load(sys.stdin)
assert b['device'] == 'OrchidTest', b
assert b['volume'] == 1.0, b
assert b['source'].endswith('tono.wav'), b
" || fail "the audio body did not come back as it was set"

# The decoder read the file, so the length is the file's and not a guess.
curl -sf --max-time 5 "$B/functions" | python3 -c "
import json, sys
audio = [f for f in json.load(sys.stdin) if f['type'] == 'Audio'][0]
assert audio['duration'] == 3000, ('the decoder did not read the file', audio)
" || fail "the duration did not come from the file"

# An output that does not exist is refused with the list of the ones that do.
code=$(curl -s -o "$WORK/refused" -w '%{http_code}' --max-time 5 -X PUT \
       "$B/functions/$ID/body" -H 'Content-Type: application/json' \
       -d '{"device":"Altavoz de la luna"}')
[ "$code" = "400" ] || fail "an output that does not exist was accepted"
grep -q "OrchidTest" "$WORK/refused" \
    || fail "the refusal did not name the outputs that do exist"

# ---------------------------------------------------------------------------
# And now the measurement.
# ---------------------------------------------------------------------------
listen() {
    local out=$1 seconds=$2
    parec -d orchid_test.monitor --format=s16le --rate=44100 --channels=2 \
          --file-format=wav "$out" 2>/dev/null &
    local rec=$!
    shift 2
    "$@"
    sleep "$seconds"
    kill $rec 2>/dev/null
    wait $rec 2>/dev/null || true
}

peak() {
    python3 - "$1" <<'PY'
import struct, sys, wave
with wave.open(sys.argv[1]) as w:
    data = w.readframes(w.getnframes())
vals = struct.unpack('<%dh' % (len(data) // 2), data)
print(max((abs(v) for v in vals), default=0))
PY
}

# Nothing has been started, so the sink has to be silent. Without this the
# assertions below would pass against a machine playing something else.
listen "$WORK/quiet.wav" 2 true
quiet=$(peak "$WORK/quiet.wav")
[ "$quiet" -lt 100 ] || fail "the test sink was not silent to begin with (peak $quiet)"

start() { curl -sf --max-time 5 -X POST "$B/functions/$ID/start" > /dev/null; }

listen "$WORK/full.wav" 4 start
full=$(peak "$WORK/full.wav")

# The tone was generated at 20000. Anything much under it means the samples are
# arriving damaged; anything over it means they are not the samples we sent.
[ "$full" -gt 18000 ] && [ "$full" -lt 22000 ] \
    || fail "the tone did not come out of the named output at full (peak $full, expected ~20000)"

# The volume is not decoration: it scales what leaves the machine.
curl -sf --max-time 5 -X PUT "$B/functions/$ID/body" -H 'Content-Type: application/json' \
    -d '{"volume":0.25}' > /dev/null

listen "$WORK/quarter.wav" 4 start
quarter=$(peak "$WORK/quarter.wav")

[ "$quarter" -gt 4000 ] && [ "$quarter" -lt 6000 ] \
    || fail "the volume did not scale the output (peak $quarter, expected ~5000)"

# And the output it plays through survives being written out, because a device
# chosen once and lost on the next load is worse than one that was never offered.
curl -sf --max-time 5 -X POST "$B/project/save" > /dev/null || fail "POST /project/save"
grep -q 'Device="OrchidTest"' "$WORK/$NAME" \
    || fail "the chosen output was not saved into the project"

echo "Audio playback smoke test passed (peak $full at full, $quarter at a quarter)."
