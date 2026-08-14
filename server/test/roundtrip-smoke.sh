#!/bin/bash
#
# Load a project, save it back through the API, and prove that the sections the
# engine does not model came through untouched.
#
#   server/test/roundtrip-smoke.sh [path-to-orchidlightsd] [path-to-project.qxw]
#
# This is the test that matters most in the whole suite. Virtual Console and
# Simple Desk live outside Doc; if a save drops them, the file still opens, the
# fixtures are all there, and the operator only finds out that the layout their
# show runs on is gone when they open it before a gig.

set -euo pipefail

DAEMON=${1:-orchidlightsd}
SOURCE=${2:-resources/samples/Sample.qxw}
PORT=${PORT:-9988}
BASE="http://127.0.0.1:$PORT/api/v1"

export QT_QPA_PLATFORM=offscreen

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

# A daemon already on this port would answer every request below, and the test
# would pass or fail against a project nobody chose. Cheap to check, and it has
# already cost one confusing failure.
if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/" 2>/dev/null; then
    fail "something is already listening on port $PORT; set PORT= to another one"
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

NAME=$(basename "$SOURCE")
cp "$SOURCE" "$WORK/$NAME"

"$DAEMON" --port "$PORT" --no-output "$WORK/$NAME" > "$WORK/daemon.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true; rm -rf "$WORK"' EXIT

for _ in $(seq 1 100); do
    curl -sf --max-time 1 "$BASE/status" > /dev/null 2>&1 && break
    kill -0 $PID 2>/dev/null || { cat "$WORK/daemon.log" >&2; fail "the daemon exited early"; }
    sleep 0.2
done

# The project directory must be the one the show lives in, and nothing else.
curl -sf --max-time 5 "$BASE/projects" | python3 -c "
import json, sys
body = json.load(sys.stdin)
assert '$NAME' in body['projects'], body
assert body['directory'] == '$WORK', body
" || fail "GET /projects"

# A name, never a path: the API must refuse to walk out of its directory.
for evil in '../etc/passwd.qxw' '/etc/passwd.qxw' 'notaproject.txt'; do
    CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST --max-time 5 \
           "$BASE/project/save/$(printf %s "$evil" | sed 's|/|%2F|g')")
    [ "$CODE" = "400" ] || [ "$CODE" = "404" ] \
        || fail "saving to '$evil' answered $CODE, expected it to be refused"
done

curl -sf -X POST --max-time 10 "$BASE/project/save" > /dev/null || fail "POST /project/save"

kill $PID 2>/dev/null || true
wait $PID 2>/dev/null || true

python3 - "$SOURCE" "$WORK/$NAME" <<'PY' || exit 1
import sys, xml.etree.ElementTree as ET

before, after = sys.argv[1], sys.argv[2]

def sections(path):
    root = ET.parse(path).getroot()
    out = {}
    for child in root:
        tag = child.tag.split('}')[-1]
        out[tag] = ET.canonicalize(ET.tostring(child, encoding='unicode'), strip_text=True)
    return out

a, b = sections(before), sections(after)

# Everything the engine does not own has to survive byte for byte.
for tag in a:
    if tag in ('Creator', 'Engine'):
        continue
    assert tag in b, f'{tag} was dropped by the save'
    assert a[tag] == b[tag], (
        f'{tag} changed across the round trip '
        f'({len(a[tag])} chars before, {len(b[tag])} after)')

assert 'Engine' in b, 'the engine section is missing'
print('preserved:', ', '.join(t for t in a if t not in ('Creator', 'Engine')))
PY

# And the saved file must still load, with the same contents.
BEFORE=$("$DAEMON" --check --no-output "$SOURCE" 2>/dev/null | grep -E '^(Fixtures|Functions|Universes):')
AFTER=$("$DAEMON" --check --no-output "$WORK/$NAME" 2>/dev/null | grep -E '^(Fixtures|Functions|Universes):')

[ "$BEFORE" = "$AFTER" ] || fail "the saved project loads differently:
before: $BEFORE
after:  $AFTER"

echo "$AFTER" | tr '\n' ' '
echo
echo "Round-trip smoke test passed."
