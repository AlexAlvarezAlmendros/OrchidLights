#!/bin/bash
#
# The interface, in a real browser, against a real engine.
#
#   server/test/ui-smoke.sh [path-to-orchidlightsd] [path-to-project.qxw]
#
# Adds a widget by clicking, renames it, points it at a function, deletes it --
# and then checks the project file came back to exactly where it started. The
# API tests prove the daemon does the right thing when asked; this one proves
# the thing the operator actually touches asks it.
#
# Needs Chrome. Skips rather than fails when there is none, because a machine
# without a browser can still run everything else.

set -euo pipefail

DAEMON=${1:-orchidlightsd}
SOURCE=${2:-server/test/data/vc-references.qxw}
PORT=${PORT:-9985}
CHROME=${CHROME:-google-chrome}

export QT_QPA_PLATFORM=offscreen

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

if ! command -v "$CHROME" > /dev/null 2>&1; then
    echo "No $CHROME on this machine; skipping the UI smoke test."
    exit 0
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

NAME=$(basename "$SOURCE")
cp "$SOURCE" "$WORK/$NAME"

"$DAEMON" --port "$PORT" --no-output "$WORK/$NAME" > "$WORK/daemon.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true; rm -rf "$WORK"' EXIT

for _ in $(seq 1 100); do
    curl -sf --max-time 1 "http://127.0.0.1:$PORT/api/v1/status" > /dev/null 2>&1 && break
    kill -0 $PID 2>/dev/null || { cat "$WORK/daemon.log" >&2; fail "the daemon exited early"; }
    sleep 0.2
done

# Without the built interface there is nothing to drive, and a pass here would
# mean nothing at all.
curl -sf --max-time 5 "http://127.0.0.1:$PORT/" | grep -q '<div id="root"' \
    || fail "the daemon is not serving the web interface; run pnpm build in web/"

CHROME="$CHROME" node server/test/ui-client.mjs "http://127.0.0.1:$PORT/" "$WORK/shots" \
    || fail "the interface did not do what it claims"

curl -sf -X POST --max-time 10 "http://127.0.0.1:$PORT/api/v1/project/save" > /dev/null \
    || fail "POST /project/save"

kill $PID 2>/dev/null || true
wait $PID 2>/dev/null || true

# Added and then deleted: the console has to be what it was, node for node.
#
# The one change allowed is an ID where there was none, because assigning them
# is a thing the operator may have just asked for above -- and it is the only
# edit in this whole layer that touches widgets nobody selected.
python3 - "$SOURCE" "$WORK/$NAME" <<'PY' || exit 1
import sys, xml.etree.ElementTree as ET

def console(path):
    for child in ET.parse(path).getroot():
        if child.tag.split('}')[-1] == 'VirtualConsole':
            return child
    raise AssertionError(f'{path} has no VirtualConsole')

def index(node, path='', out=None):
    out = {} if out is None else out
    tag = node.tag.split('}')[-1]
    here = f'{path}/{tag}'
    n = 1
    while f'{here}#{n}' in out:
        n += 1
    here = f'{here}#{n}'
    out[here] = (dict(node.attrib), (node.text or '').strip())
    for child in node:
        index(child, here, out)
    return out

before, after = index(console(sys.argv[1])), index(console(sys.argv[2]))

assert set(before) == set(after), (
    'the console gained or lost nodes: '
    f'{sorted(set(before) ^ set(after))[:5]}')

assigned = 0
for key in sorted(before):
    (attrs_a, text_a), (attrs_b, text_b) = before[key], after[key]
    assert text_a == text_b, f'{key}: text changed, {text_a!r} -> {text_b!r}'

    changed = {k for k in set(attrs_a) | set(attrs_b) if attrs_a.get(k) != attrs_b.get(k)}
    if changed == {'ID'} and 'ID' not in attrs_a:
        assigned += 1
        continue

    assert not changed, f'{key}: changed {changed}'

print(f'console unchanged across the round trip '
      f'({len(before)} nodes, {assigned} given an id)')
PY

echo "UI smoke test passed."
