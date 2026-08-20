#!/bin/bash
#
# The project cycle: new, open by path, save as, recents, autosave.
#
#   server/test/project-smoke.sh [path-to-orchidlightsd]
#
# The disk-path routes demand the token even on loopback -- they are the
# desktop shell's surface, and a phone on the venue network must never gain an
# arbitrary-file read/write primitive from a desk that trusts loopback.
#
# The autosave interval bends for this test (ORCHID_AUTOSAVE_MS); what is
# asserted is the LIFECYCLE: armed by an edit, written with the preserved
# sections intact, reported while newer than the project, deleted by a save.

set -euo pipefail

DAEMON=${1:-orchidlightsd}
PROJECT=${2:-resources/samples/Sample.qxw}
PORT=${PORT:-9961}
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
cp "$PROJECT" "$WORK/show.qxw"

read -r -a EXTRA <<< "${ORCHID_TEST_ARGS:-}"

ORCHID_AUTOSAVE_MS=1200 "$DAEMON" --port "$PORT" --no-output \
    "${EXTRA[@]+"${EXTRA[@]}"}" "$WORK/show.qxw" > "$WORK/daemon.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true; rm -rf "$WORK"' EXIT

for _ in $(seq 1 100); do
    curl -sf --max-time 1 "http://127.0.0.1:$PORT/api/v1/status" > /dev/null 2>&1 && break
    kill -0 $PID 2>/dev/null || { cat "$WORK/daemon.log" >&2; fail "the daemon exited early"; }
    sleep 0.2
done

TOKEN=$(cat "$HOME/.orchidlights/api-token")
BASE="http://127.0.0.1:$PORT/api/v1"
AUTH=(-H "Authorization: Bearer $TOKEN")
JSON=(-H "Content-Type: application/json")

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

# --- Strict token on every disk route, even on loopback ---------------------
[ "$(code -X POST "$BASE/project/new")" = "401" ] || fail "new without token was allowed"
[ "$(code -X POST "${JSON[@]}" -d '{"path":"/tmp/x.qxw"}' "$BASE/project/open")" = "401" ] \
    || fail "open without token was allowed"
[ "$(code -X POST "${JSON[@]}" -d '{"path":"/tmp/x.qxw"}' "$BASE/project/save-as")" = "401" ] \
    || fail "save-as without token was allowed"
[ "$(code "$BASE/project/recents")" = "401" ] || fail "recents without token was allowed"

# --- Save as: an arbitrary path, byte-identical content ---------------------
COPY="$WORK/copia.qxw"
curl -sf -X POST "${AUTH[@]}" "${JSON[@]}" -d "{\"path\":\"$COPY\"}" "$BASE/project/save-as" > /dev/null \
    || fail "save-as refused"
[ -f "$COPY" ] || fail "save-as wrote nothing"

# The same round-trip promise the plain save keeps: nothing reworded, the
# preserved sections intact. Loading the copy back must describe the same show.
FIXTURES_A=$(curl -s "$BASE/status" | python3 -c "import json,sys; print(json.load(sys.stdin)['fixtures'])")
curl -sf -X POST "${AUTH[@]}" "${JSON[@]}" -d "{\"path\":\"$COPY\"}" "$BASE/project/open" > /dev/null \
    || fail "the copy would not open"
FIXTURES_B=$(curl -s "$BASE/status" | python3 -c "import json,sys; print(json.load(sys.stdin)['fixtures'])")
[ "$FIXTURES_A" = "$FIXTURES_B" ] || fail "the copy describes a different show ($FIXTURES_A vs $FIXTURES_B)"

# --- Recents: newest first, existence reported ------------------------------
curl -s "${AUTH[@]}" "$BASE/project/recents" > "$WORK/recents.json"
python3 - "$WORK/recents.json" "$COPY" <<'CHECK' || fail "recents"
import json, sys
body = json.load(open(sys.argv[1]))
paths = [r["path"] for r in body["recents"]]
assert sys.argv[2] in paths, (sys.argv[2], paths)
assert all(isinstance(r["exists"], bool) for r in body["recents"])
CHECK

# --- Autosave lifecycle -----------------------------------------------------
curl -sf -X PATCH "${JSON[@]}" -d '{"name":"Sonda de autosave"}' "$BASE/functions/1" > /dev/null \
    || fail "could not modify the project"

SHADOW="$COPY.autosave.qxw"
for _ in $(seq 1 40); do
    [ -f "$SHADOW" ] && break
    sleep 0.25
done
[ -f "$SHADOW" ] || fail "no autosave appeared after an edit"

# Reported to clients while it is newer than the project...
sleep 1.1
curl -s "$BASE/project" | python3 -c "
import json, sys
body = json.load(sys.stdin)
assert body['modified'] is True, body
" || fail "the project does not admit being modified"

# The recovery copy is a real project: the preserved sections survived.
python3 - "$SHADOW" <<'CHECK' || fail "the autosave lost the Virtual Console"
import sys
text = open(sys.argv[1]).read()
assert '<VirtualConsole>' in text, 'no VirtualConsole section in the autosave'
CHECK

# ...and a real save disarms and removes it.
curl -sf -X POST "$BASE/project/save" > /dev/null || fail "save refused"
sleep 0.5
[ ! -f "$SHADOW" ] || fail "the autosave survived a real save"

# --- New: empty document, no path, nothing to silently overwrite ------------
curl -sf -X POST "${AUTH[@]}" "$BASE/project/new" > /dev/null || fail "new refused"
curl -s "$BASE/project" | python3 -c "
import json, sys
body = json.load(sys.stdin)
assert body['path'] == '', body
assert body['modified'] is False, body
" || fail "new kept a path it should have forgotten"
CODE=$(code -X POST "$BASE/project/save")
[ "$CODE" = "409" ] || fail "saving a pathless project answered $CODE, wanted 409"

# The old show is untouched by all of the above except our deliberate save.
python3 - "$COPY" <<'CHECK' || fail "the copy lost its console"
import sys
text = open(sys.argv[1]).read()
assert '<VirtualConsole>' in text
assert 'Sonda de autosave' in text, 'the saved rename is not in the file'
CHECK

# --- Recovery: the crash story, told end to end -----------------------------
# Open the copy again, edit, let the autosave land, then die WITHOUT saving --
# kill -9 is the power strip. A fresh daemon on the same project must report
# the shadow, recover its content into memory under the project's own path,
# and a save must land it in the real file and remove the shadow.
curl -sf -X POST "${AUTH[@]}" "${JSON[@]}" -d "{\"path\":\"$COPY\"}" "$BASE/project/open" > /dev/null
curl -sf -X PATCH "${JSON[@]}" -d '{"name":"Solo en el autosave"}' "$BASE/functions/1" > /dev/null
for _ in $(seq 1 40); do
    [ -f "$SHADOW" ] && break
    sleep 0.25
done
[ -f "$SHADOW" ] || fail "no autosave before the crash"
sleep 1.1
kill -9 $PID
wait $PID 2>/dev/null || true

ORCHID_AUTOSAVE_MS=1200 "$DAEMON" --port "$PORT" --no-output \
    "${EXTRA[@]+"${EXTRA[@]}"}" "$COPY" > "$WORK/daemon2.log" 2>&1 &
PID=$!
for _ in $(seq 1 100); do
    curl -sf --max-time 1 "http://127.0.0.1:$PORT/api/v1/status" > /dev/null 2>&1 && break
    kill -0 $PID 2>/dev/null || { cat "$WORK/daemon2.log" >&2; fail "the second daemon exited early"; }
    sleep 0.2
done

curl -s "$BASE/project" | python3 -c "
import json, sys
body = json.load(sys.stdin)
assert 'autosave' in body, ('the shadow went unreported', body)
" || fail "recovery not offered"

curl -sf -X POST "$BASE/project/recover" > /dev/null || fail "recover refused"
curl -s "$BASE/functions" | grep -q "Solo en el autosave" || fail "the recovered edit is not in memory"
curl -s "$BASE/project" > "$WORK/afterrecover.json"
python3 - "$WORK/afterrecover.json" "$COPY" <<'CHECK' || fail "recovery changed the project's identity"
import json, sys
body = json.load(open(sys.argv[1]))
assert body["path"] == sys.argv[2], body
assert body["modified"] is True, body
CHECK

curl -sf -X POST "$BASE/project/save" > /dev/null || fail "the recovered show would not save"
sleep 0.5
[ ! -f "$SHADOW" ] || fail "the shadow survived the recovery save"
grep -q "Solo en el autosave" "$COPY" || fail "the recovered edit never reached the real file"

echo "Project smoke test passed."
