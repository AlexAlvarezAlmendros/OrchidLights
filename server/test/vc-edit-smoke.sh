#!/bin/bash
#
# Editing the Virtual Console from the browser, and proving the file survives it.
#
#   server/test/vc-edit-smoke.sh [path-to-orchidlightsd] [path-to-project.qxw]
#
# The console holds 489 persisted fields and this daemon models 124 of them, so
# every edit is a patch: find the node, change the attributes asked for, leave
# everything else -- input bindings, key sequences, button actions, fonts --
# exactly where it was. The assertions below are all variations on one question:
# did anything change that nobody asked to change?

set -euo pipefail

DAEMON=${1:-orchidlightsd}
SOURCE=${2:-server/test/data/vc-references.qxw}
PORT=${PORT:-9986}
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

api() {
    local method=$1 path=$2
    shift 2
    curl -s --max-time 5 -X "$method" "$BASE$path" "$@"
}

code() {
    local method=$1 path=$2
    shift 2
    curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X "$method" "$BASE$path" "$@"
}

# This project already has ids on everything, so asking for them is a no-op.
# Saying "0" rather than silently renumbering is the point: assigning ids is
# the one edit here that touches widgets nobody selected.
api POST /vc/widgets/ids | python3 -c "
import json, sys
assert json.load(sys.stdin)['assigned'] == 0, 'ids were handed out to widgets that had them'
" || fail "POST /vc/widgets/ids"

# ---------------------------------------------------------------------------
# The trap this test exists for: widget 3 is a Label, and the XY pad points at
# fixture 3. A patch addressed to widget 3 must reach the Label.
# ---------------------------------------------------------------------------

api PATCH /vc/widgets/3 -H 'Content-Type: application/json' \
    -d '{"caption":"Escenario Izquierda","geometry":{"x":460,"width":220}}' \
    > "$WORK/patched.json" || fail "PATCH /vc/widgets/3"

python3 - "$WORK/patched.json" <<'PY' || exit 1
import json, sys
w = json.load(open(sys.argv[1]))
assert w.get('type') == 'label', w
assert w['caption'] == 'Escenario Izquierda', w
assert w['geometry']['x'] == 460, w
assert w['geometry']['width'] == 220, w
# Untouched fields keep their values -- a patch is not a replacement.
assert w['geometry']['y'] == 10, w
assert w['geometry']['height'] == 40, w
PY

# A caption is not a number and 100001 pixels is not a geometry.
[ "$(code PATCH /vc/widgets/3 -d '{"geometry":{"x":"left"}}')" = "400" ] \
    || fail "a non-numeric geometry was accepted"
[ "$(code PATCH /vc/widgets/3 -d '{"geometry":{"width":100001}}')" = "400" ] \
    || fail "an absurd width was accepted"
[ "$(code PATCH /vc/widgets/99 -d '{"caption":"x"}')" = "404" ] \
    || fail "patching a widget that does not exist did not answer 404"
[ "$(code PATCH /vc/widgets/abc -d '{"caption":"x"}')" = "400" ] \
    || fail "a non-numeric widget id was not refused"

# ---------------------------------------------------------------------------
# Add, then delete, and the console must come back to exactly what it was.
# ---------------------------------------------------------------------------

NEW=$(api POST /vc/widgets -H 'Content-Type: application/json' \
      -d '{"type":"button","caption":"Blackout","parent":"0","geometry":{"x":700,"y":10,"width":120,"height":50}}' \
      | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])') \
    || fail "POST /vc/widgets"

# Ids 0-3 and 5 are taken, so the first free one is the gap at 4. Guessing
# higher would be harmless; guessing one in use would merge two widgets.
[ "$NEW" = "4" ] || fail "the new widget got id $NEW, expected the free gap at 4"

api GET /vc | python3 -c "
import json, sys
def walk(w):
    yield w
    for c in w.get('children', []):
        yield from walk(c)
found = [w for w in walk(json.load(sys.stdin)) if str(w.get('id')) == '$NEW']
assert found, 'the new widget is not in GET /vc'
assert found[0]['type'] == 'button', found[0]
assert found[0]['caption'] == 'Blackout', found[0]
assert found[0]['geometry'] == {'x': 700, 'y': 10, 'width': 120, 'height': 50}, found[0]
" || fail "the new widget did not come back from GET /vc"

[ "$(code POST /vc/widgets -d '{"type":"teleporter"}')" = "400" ] \
    || fail "an unknown widget type was accepted"
[ "$(code POST /vc/widgets -d '{"type":"button","parent":"3"}')" = "400" ] \
    || fail "a label was accepted as a parent frame"

# ---------------------------------------------------------------------------
# Undo and redo, which is what makes deleting a widget survivable.
# ---------------------------------------------------------------------------

# Nothing has been undone yet, but three edits are behind us.
api GET /vc/history | python3 -c "
import json, sys
h = json.load(sys.stdin)
assert h['undo'] > 0, ('nothing to undo after editing', h)
assert h['redo'] == 0, h
" || fail "GET /vc/history"

BEFORE=$(api GET /vc | python3 -c "
import json, sys
def walk(w):
    yield w
    for c in w.get('children', []):
        yield from walk(c)
print(sum(1 for _ in walk(json.load(sys.stdin))))
")

api DELETE /vc/widgets/5 > /dev/null || fail "DELETE the cue list"
api POST /vc/undo | python3 -c "
import json, sys
h = json.load(sys.stdin)
assert h['redo'] == 1, ('undoing should leave something to redo', h)
" || fail "POST /vc/undo"

api GET /vc | python3 -c "
import json, sys
def walk(w):
    yield w
    for c in w.get('children', []):
        yield from walk(c)
tree = list(walk(json.load(sys.stdin)))
assert len(tree) == $BEFORE, ('undo did not put the console back', len(tree), $BEFORE)
# And the widget itself, not merely something of the right shape.
assert any(w.get('id') == 5 and w['type'] == 'cuelist' for w in tree), 'the cue list did not come back'
" || fail "the console did not come back after undo"

api POST /vc/redo > /dev/null || fail "POST /vc/redo"
api GET /vc | python3 -c "
import json, sys
def walk(w):
    yield w
    for c in w.get('children', []):
        yield from walk(c)
assert not any(w.get('id') == 5 for w in walk(json.load(sys.stdin))), 'redo did not take it away again'
" || fail "redo did not repeat the deletion"

api POST /vc/undo > /dev/null || fail "POST /vc/undo (second)"

# An edit after undoing is a new branch: what was ahead is gone.
api PATCH /vc/widgets/3 -H 'Content-Type: application/json' -d '{"caption":"Escenario Izquierda"}' > /dev/null
api GET /vc/history | python3 -c "
import json, sys
h = json.load(sys.stdin)
assert h['redo'] == 0, ('a new edit should discard what was ahead', h)
" || fail "a new edit did not clear the redo history"

[ "$(code POST /vc/redo)" = "409" ] || fail "redoing with nothing ahead did not answer 409"

# ---------------------------------------------------------------------------
# What a widget does, not just where it sits. A control that looks right and
# does nothing is the failure mode this whole section exists to prevent.
# ---------------------------------------------------------------------------

api PATCH "/vc/widgets/$NEW" -H 'Content-Type: application/json' \
    -d '{"functionId":0,"action":"Flash"}' > "$WORK/bound.json" \
    || fail "PATCH binding a function"

python3 -c "
import json
w = json.load(open('$WORK/bound.json'))
assert w['functionId'] == 0, w
# The action too. Without it in the read model, an editor can only ever show a
# button as a toggle -- and a button captioned BLACKOUT that has quietly become
# one is a discovery nobody wants to make from the desk.
assert w['action'] == 'Flash', w
" || fail "the button did not come back bound to function 0, flashing"

# The console is only text: it will hold an id nothing answers to, and QLC+
# loads that without a word.
[ "$(code PATCH "/vc/widgets/$NEW" -d '{"functionId":9999}')" = "400" ] \
    || fail "a function that does not exist was accepted"
[ "$(code PATCH "/vc/widgets/$NEW" -d '{"action":"Teleport"}')" = "400" ] \
    || fail "an unknown button action was accepted"
[ "$(code PATCH /vc/widgets/3 -d '{"action":"Flash"}')" = "400" ] \
    || fail "a label was given a button action"
[ "$(code PATCH /vc/widgets/1 -d '{"sliderMode":"Grandmaster"}')" = "400" ] \
    || fail "an unknown slider mode was accepted, and unknown means submaster"
[ "$(code PATCH /vc/widgets/1 -d '{"levelChannels":[{"fixture":0,"channel":7}]}')" = "400" ] \
    || fail "a channel past the end of the fixture was accepted"
[ "$(code PATCH /vc/widgets/1 -d '{"levelChannels":[{"fixture":77,"channel":0}]}')" = "400" ] \
    || fail "a fixture that does not exist was accepted"

# A cue list steps through a chaser. Hand it a scene and it loads, shows the
# name, and does nothing at all when the operator presses Next.
[ "$(code PATCH /vc/widgets/5 -d '{"chaserId":0}')" = "400" ] \
    || fail "a scene was accepted as a cue list's chaser"
[ "$(code PATCH /vc/widgets/5 -d '{"chaserId":1}')" = "200" ] \
    || fail "the chaser was refused as a cue list's chaser"

api DELETE "/vc/widgets/$NEW" > /dev/null || fail "DELETE /vc/widgets/$NEW"

# A slider built from scratch, aimed at real channels. The engine re-reads the
# console after every edit, so it is driving them before the project is saved.
SLIDER=$(api POST /vc/widgets -H 'Content-Type: application/json' \
         -d '{"type":"slider","caption":"Nuevo","sliderMode":"level",
              "levelChannels":[{"fixture":0,"channel":0},{"fixture":0,"channel":1}]}' \
         | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])') \
    || fail "POST a level slider"

api GET /vc | python3 -c "
import json, sys
def walk(w):
    yield w
    for c in w.get('children', []):
        yield from walk(c)
slider = [w for w in walk(json.load(sys.stdin)) if str(w.get('id')) == '$SLIDER'][0]
assert slider['sliderMode'] == 'level', slider
assert slider['levelChannels'] == [
    {'fixture': 0, 'channel': 0}, {'fixture': 0, 'channel': 1}], slider
" || fail "the new slider's channels did not come back from GET /vc"

# Creating and editing go through the same code, so they refuse the same things.
[ "$(code POST /vc/widgets -d '{"type":"slider","levelChannels":[{"fixture":77,"channel":0}]}')" = "400" ] \
    || fail "a slider was created pointing at a fixture that does not exist"

# The button's id came free when it went, so the slider got it back.
[ "$SLIDER" = "$NEW" ] || fail "the deleted id $NEW was not reused, got $SLIDER"

api DELETE "/vc/widgets/$SLIDER" > /dev/null || fail "DELETE /vc/widgets/$SLIDER"
[ "$(code DELETE "/vc/widgets/$SLIDER")" = "404" ] \
    || fail "deleting the same widget twice did not answer 404"

# ---------------------------------------------------------------------------
# Deleting a fixture takes its references out of the console, and nothing else.
# ---------------------------------------------------------------------------

api DELETE /fixtures/1 | python3 -c "
import json, sys
body = json.load(sys.stdin)
assert body['removed'] == 1, body
assert body['consoleReferencesRemoved'] == 2, body
" || fail "DELETE /fixtures/1"

curl -sf -X POST --max-time 10 "$BASE/project/save" > /dev/null || fail "POST /project/save"
cp "$WORK/$NAME" "$WORK/patched.qxw"

# Now the other half of the trap. Widget 3 is the Label; the XY pad's
# <Fixture ID="3"> must still be there afterwards.
api DELETE /vc/widgets/3 > /dev/null || fail "DELETE /vc/widgets/3"
curl -sf -X POST --max-time 10 "$BASE/project/save/deleted.qxw" > /dev/null \
    || fail "POST /project/save/deleted.qxw"

kill $PID 2>/dev/null || true
wait $PID 2>/dev/null || true

# ---------------------------------------------------------------------------
# What the file says now, against what it said before. Twice: once for the
# patch, once for the delete.
# ---------------------------------------------------------------------------

cat > "$WORK/compare.py" <<'PY'
import sys, xml.etree.ElementTree as ET

def console(path):
    root = ET.parse(path).getroot()
    for child in root:
        if child.tag.split('}')[-1] == 'VirtualConsole':
            return child
    raise AssertionError(f'{path} has no VirtualConsole')

def index(node, path='', out=None):
    """Every element by its path, so two files can be compared node by node."""
    out = {} if out is None else out
    tag = node.tag.split('}')[-1]
    here = f'{path}/{tag}'
    if 'ID' in node.attrib:
        here += f"[{node.attrib['ID']}]"
    n = 1
    while f'{here}#{n}' in out:
        n += 1
    here = f'{here}#{n}'
    out[here] = (dict(node.attrib), (node.text or '').strip())
    for child in node:
        index(child, here, out)
    return out

def compare(before_path, after_path, expected_gone, expected_changed):
    before, after = index(console(before_path)), index(console(after_path))

    gone = set(before) - set(after)
    assert gone == expected_gone, \
        f'removals differ by: {gone ^ expected_gone}'

    added = set(after) - set(before)
    assert not added, f'the console grew nodes nobody asked for: {added}'

    for key in sorted(set(before) & set(after)):
        (attrs_a, text_a), (attrs_b, text_b) = before[key], after[key]
        assert text_a == text_b, f'{key}: text changed, {text_a!r} -> {text_b!r}'

        changed = {k for k in set(attrs_a) | set(attrs_b)
                   if attrs_a.get(k) != attrs_b.get(k)}
        assert changed == expected_changed.get(key, set()), \
            f'{key}: changed {changed}, expected {expected_changed.get(key, set())}'

    return len(before), len(gone)
PY

python3 - "$SOURCE" "$WORK/patched.qxw" "$WORK/deleted.qxw" "$WORK/compare.py" <<'PY' || exit 1
import sys
source, patched, deleted, helper = sys.argv[1:5]
exec(open(helper).read())

FRAME = '/VirtualConsole#1/Frame[0]#1'

# The add and the delete cancelled out, so the only removals left are the two
# level channels that pointed at the deleted fixture. Everything else -- the
# XY pad's <Fixture ID="3">, the slider's limits, the frame -- stands still.
nodes, removed = compare(source, patched, {
    f'{FRAME}/Slider[1]#1/Level#1/Channel#1',
    f'{FRAME}/Slider[1]#1/Level#1/Channel#2',
}, {
    f'{FRAME}/Label[3]#1': {'Caption'},
    f'{FRAME}/Label[3]#1/WindowState#1': {'X', 'Width'},
})
print(f'console: {nodes} nodes, {removed} removed, 3 attributes changed')

# And deleting widget 3 takes the Label, not the fixture the XY pad shares an
# id with.
_, removed = compare(patched, deleted, {
    f'{FRAME}/Label[3]#1',
    f'{FRAME}/Label[3]#1/WindowState#1',
}, {})
print(f'delete: {removed} nodes removed, XY pad fixture 3 untouched')
PY

# And they still load.
for file in "$WORK/patched.qxw" "$WORK/deleted.qxw"; do
    "$DAEMON" --check --no-output "$file" > "$WORK/check.log" 2>&1 \
        || { cat "$WORK/check.log" >&2; fail "$(basename "$file") no longer loads"; }
done

grep -E '^(Fixtures|Universes):' "$WORK/check.log" | tr '\n' ' '
echo
echo "Virtual Console edit smoke test passed."
