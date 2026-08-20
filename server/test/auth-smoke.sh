#!/bin/bash
#
# A guarded daemon, met by curl and by the interface.
#
#   server/test/auth-smoke.sh [path-to-orchidlightsd] [path-to-project.qxw]
#
# --require-auth demands the bearer token even on loopback. The HTTP half was
# always enforceable; what this test exists for is the interface half: before
# it, the web had nowhere to put a token, so a guarded daemon was a daemon
# with no usable UI at all.
#
# Needs Node 22+ and Chrome (CHROME= to point elsewhere). Skips the browser
# half cleanly only if SKIP_CHROME=1 is set on purpose.

set -euo pipefail

DAEMON=${1:-orchidlightsd}
PROJECT=${2:-resources/samples/Sample.qxw}
PORT=${PORT:-9964}
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
cp "$PROJECT" "$WORK/"
NAME=$(basename "$PROJECT")

read -r -a EXTRA <<< "${ORCHID_TEST_ARGS:-}"

"$DAEMON" --port "$PORT" --no-output --require-auth "${EXTRA[@]+"${EXTRA[@]}"}" \
    "$WORK/$NAME" > "$WORK/daemon.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true; rm -rf "$WORK"' EXIT

for _ in $(seq 1 100); do
    # 401 is "up": the daemon answers, it just wants the token.
    # curl already prints 000 when it cannot connect; the || true only keeps
    # set -e from ending the wait.
    CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 "http://127.0.0.1:$PORT/api/v1/status" 2>/dev/null || true)
    [ "$CODE" != "000" ] && break
    kill -0 $PID 2>/dev/null || { cat "$WORK/daemon.log" >&2; fail "the daemon exited early"; }
    sleep 0.2
done

TOKEN=$(cat "$HOME/.orchidlights/api-token")
BASE="http://127.0.0.1:$PORT"

# The HTTP half: everything closed without the token, open with it.
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/functions")
[ "$CODE" = "401" ] || fail "functions without a token answered $CODE, wanted 401"

CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/functions")
[ "$CODE" = "200" ] || fail "functions with the token answered $CODE, wanted 200"

# The page itself stays open: index.html carries no data, and a phone must be
# able to LOAD the app in order to be asked for the token at all.
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")
[ "$CODE" = "200" ] || fail "the app shell answered $CODE, wanted 200 (the gate lives in the app)"

if [ "${SKIP_CHROME:-0}" = "1" ]; then
    echo "Auth smoke test passed (browser half skipped on request)."
    exit 0
fi

node "$HERE/auth-client.mjs" "$BASE" "$TOKEN" \
    || fail "the interface did not handle the guarded daemon"

echo "Auth smoke test passed."
