#!/bin/bash
#
# The property the whole F6 design rests on: parsing a <VirtualConsole> into the
# node tree and writing it straight back must not change it.
#
# If this ever fails, editing widgets stops being safe -- every save would
# quietly rewrite parts of the show nobody asked it to touch.

set -euo pipefail

DAEMON=${1:-orchidlightsd}
PORT=${PORT:-9379}
export QT_QPA_PLATFORM=offscreen

fail() { echo "FAIL: $*" >&2; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# Every project available, not just the sample: the shapes that break a
# round trip are the ones a synthetic file does not have.
PROJECTS=("resources/samples/Sample.qxw" "server/test/data/vc-widgets.qxw")
for extra in "$HOME"/Documentos/QLC+/*.qxw; do
    [ -f "$extra" ] && PROJECTS+=("$extra")
done

for project in "${PROJECTS[@]}"; do
    name=$(basename "$project")
    cp "$project" "$WORK/$name"

    "$DAEMON" --port "$PORT" --no-output --projects "$WORK" "$WORK/$name" \
        > "$WORK/daemon.log" 2>&1 &
    pid=$!

    for _ in $(seq 1 100); do
        curl -sf --max-time 1 "http://127.0.0.1:$PORT/api/v1/status" > /dev/null 2>&1 && break
        kill -0 $pid 2>/dev/null || { cat "$WORK/daemon.log" >&2; fail "$name: daemon exited"; }
        sleep 0.2
    done

    curl -sf -X POST --max-time 10 "http://127.0.0.1:$PORT/api/v1/project/save" > /dev/null \
        || fail "$name: save failed"

    kill $pid 2>/dev/null || true
    wait $pid 2>/dev/null || true

    python3 - "$project" "$WORK/$name" "$name" <<'PY' || exit 1
import sys, xml.etree.ElementTree as ET

before, after, name = sys.argv[1], sys.argv[2], sys.argv[3]

def vc(path):
    for child in ET.parse(path).getroot():
        if child.tag.split('}')[-1] == 'VirtualConsole':
            return ET.canonicalize(ET.tostring(child, encoding='unicode'), strip_text=True)
    return None

a, b = vc(before), vc(after)
if a is None and b is None:
    print(f"  {name}: no Virtual Console")
    sys.exit(0)

assert a == b, (
    f"{name}: the Virtual Console changed across a save "
    f"({len(a or '')} chars before, {len(b or '')} after)")
print(f"  {name}: Virtual Console identical ({len(a)} chars)")
PY
done

echo "XML tree round-trip passed."
