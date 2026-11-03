#!/bin/bash
#
# Llaves por dispositivo: cada móvil con la suya y con un rol.
#
#   server/test/devices-smoke.sh [path-to-orchidlightsd] [path-to-project.qxw]
#
# Antes, todo el que entraba en una mesa abierta a la red llevaba la única
# llave que había, y esa llave se saltaba la máscara de kiosko: la jaula la
# guardaba solo la interfaz. Aquí se comprueba que ya no:
#
#   - solo la llave maestra empareja, cambia y revoca dispositivos;
#   - el fichero guarda hashes, no llaves, y solo lo lee su dueño;
#   - un dispositivo de operador maneja la consola y la mesa y no construye
#     nada, con la máscara o sin ella;
#   - uno de diseño construye, se salta la máscara, y no toca el disco, el
#     apagado ni la máscara;
#   - cambiar el rol se nota en la siguiente petición;
#   - revocar corta también el WebSocket que ya estaba abierto;
#   - y todo sobrevive a reiniciar el daemon.
#
# Corre con un HOME temporal: las llaves de prueba no acaban en las tuyas.
# Necesita Node 22+ (WebSocket global).

set -euo pipefail

DAEMON=${1:-orchidlightsd}
PROJECT=${2:-server/test/data/vc-frames.qxw}
PORT=${PORT:-9966}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
BASE="http://127.0.0.1:$PORT/api/v1"

export QT_QPA_PLATFORM=offscreen

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/" 2>/dev/null; then
    fail "something is already listening on port $PORT; set PORT= to another one"
fi

# Absolute before HOME moves: a relative path would resolve against nothing.
DAEMON=$(command -v "$DAEMON" || echo "$DAEMON")
WORK=$(mktemp -d)
cp "$PROJECT" "$WORK/show.qxw"
export HOME="$WORK/home"
mkdir -p "$HOME"
read -r -a EXTRA <<< "${ORCHID_TEST_ARGS:-}"

PID=""
arranca() {
    "$DAEMON" --port "$PORT" --no-output --require-auth "${EXTRA[@]+"${EXTRA[@]}"}" \
        "$WORK/show.qxw" >> "$WORK/daemon.log" 2>&1 &
    PID=$!
    for _ in $(seq 1 100); do
        CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 "$BASE/status" 2>/dev/null || true)
        [ "$CODE" = "401" ] && return 0
        kill -0 $PID 2>/dev/null || { cat "$WORK/daemon.log" >&2; fail "the daemon exited early"; }
        sleep 0.2
    done
    fail "the daemon never answered"
}
trap 'kill $PID 2>/dev/null || true; rm -rf "$WORK"' EXIT
arranca

MASTER=$(cat "$HOME/.orchidlights/api-token")

# code KEY METHOD PATH [JSON]: the HTTP status, nothing else.
code() {
    local key=$1 method=$2 path=$3 body=${4:-}
    local args=(-s -o /dev/null -w '%{http_code}' -X "$method" "$BASE$path")
    [ -n "$key" ] && args+=(-H "Authorization: Bearer $key")
    [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
    curl "${args[@]}"
}
expect() {   # expect WANT DESCRIPTION KEY METHOD PATH [JSON]
    local want=$1 what=$2
    shift 2
    local got
    got=$(code "$@")
    [ "$got" = "$want" ] || fail "$what: $got, wanted $want"
    echo "ok   $what: $got"
}
field() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }

# --- Solo la maestra empareja -------------------------------------------------

expect 401 "listing devices without a key" "" GET /devices
[ "$(curl -sf -H "Authorization: Bearer $MASTER" "$BASE/devices" | field "['devices']")" = "[]" ] \
    || fail "a fresh desk has paired devices"

PAIRED=$(curl -sf -X POST -H "Authorization: Bearer $MASTER" -H 'Content-Type: application/json' \
    -d '{"name":"Truss","role":"operate"}' "$BASE/devices")
OP=$(echo "$PAIRED" | field "['key']")
OP_ID=$(echo "$PAIRED" | field "['id']")
echo "$PAIRED" | python3 -c '
import json, sys
d = json.load(sys.stdin)
assert d["name"] == "Truss" and d["role"] == "operate", d
assert len(d["key"]) == 64, d["key"]
assert d["localUrl"].endswith("#token=" + d["key"]), d["localUrl"]
' || fail "pairing did not answer what it says"
echo "ok   a device is paired, its key shown once"

DS=$(curl -sf -X POST -H "Authorization: Bearer $MASTER" -H 'Content-Type: application/json' \
    -d '{"name":"Diseño","role":"design"}' "$BASE/devices" | field "['key']")

expect 400 "a device with no name" "$MASTER" POST /devices '{"name":"  ","role":"operate"}'
expect 400 "a role that is not one" "$MASTER" POST /devices '{"name":"X","role":"master"}'
expect 401 "a device pairing another" "$DS" POST /devices '{"name":"Amigo","role":"design"}'
expect 401 "a device listing the others" "$OP" GET /devices

# --- El fichero guarda hashes -------------------------------------------------

FILE="$HOME/.orchidlights/devices.json"
[ -f "$FILE" ] || fail "no devices file"
[ "$(stat -c %a "$FILE")" = "600" ] || fail "devices file is $(stat -c %a "$FILE"), wanted 600"
grep -q "$OP" "$FILE" && fail "the operate key is in the file in clear"
grep -q "$DS" "$FILE" && fail "the design key is in the file in clear"
echo "ok   the file holds hashes, readable by its owner only"

# --- Operador: maneja, no construye -------------------------------------------

expect 401 "a key nobody paired" "$(printf 'f%.0s' $(seq 1 64))" GET /functions
expect 200 "operate reads" "$OP" GET /functions
expect 403 "operate creates a function" "$OP" POST /functions '{"type":"Scene","name":"Intrusa"}'
expect 403 "operate edits a widget" "$OP" PATCH /vc/widgets/2 '{"caption":"Mio"}'
expect 200 "operate presses a widget" "$OP" POST /vc/widgets/2/press '{}'
expect 403 "operate saves the project" "$OP" POST /project/save
expect 403 "operate undoes" "$OP" POST /undo
expect 401 "operate widens the mask" "$OP" PUT /access '{"preset":"all"}'
expect 200 "operate works the simple desk" "$OP" PUT /simpledesk/1/channels '{"values":{"1":10}}'
expect 200 "operate blacks out" "$OP" POST /blackout
expect 200 "and back" "$OP" DELETE /blackout
curl -sf -H "Authorization: Bearer $OP" "$BASE/access" | python3 -c '
import json, sys
a = json.load(sys.stdin)
assert a["role"] == "operate", a
assert a["vcControl"] and a["simpleDesk"], a
assert not (a["fixtures"] or a["functions"] or a["vcEditing"] or a["show"] or a["io"]), a
' || fail "operate does not read its own cage"
echo "ok   operate reads the cage it is in"

# --- Diseño: construye, y no toca disco, apagado ni máscara -------------------

expect 201 "design creates a function" "$DS" POST /functions '{"type":"Scene","name":"Del diseño"}'
expect 200 "design edits a widget" "$DS" PATCH /vc/widgets/2 '{"caption":"Rojo"}'
expect 401 "design changes the mask" "$DS" PUT /access '{"preset":"all"}'
expect 401 "design saves to a path" "$DS" POST /project/save-as "{\"path\":\"$WORK/x.qxw\"}"
expect 401 "design shuts the desk down" "$DS" POST /shutdown

# --- Con la mesa en kiosko ----------------------------------------------------

expect 200 "the master closes the desk to a kiosk" "$MASTER" PUT /access '{"preset":"kiosk"}'
expect 201 "design is not caged by it" "$DS" POST /functions '{"type":"Scene","name":"En kiosko"}'
expect 403 "operate loses the desk with it" "$OP" PUT /simpledesk/1/channels '{"values":{"1":10}}'
expect 200 "and keeps the console" "$OP" POST /vc/widgets/2/press '{}'
expect 200 "the master opens it again" "$MASTER" PUT /access '{"preset":"all"}'

# --- Cambiar el rol se nota ya ------------------------------------------------

expect 200 "the master makes operate a designer" "$MASTER" PATCH "/devices/$OP_ID" '{"role":"design"}'
expect 201 "and the next request builds" "$OP" POST /functions '{"type":"Scene","name":"Ascendida"}'
expect 200 "and back to operate" "$MASTER" PATCH "/devices/$OP_ID" '{"role":"operate"}'
expect 403 "and the next request does not" "$OP" POST /functions '{"type":"Scene","name":"Otra"}'

# --- Revocar corta el socket abierto ------------------------------------------

node --input-type=module - "$PORT" "$OP" "$MASTER" "$OP_ID" <<'JS' || fail "the WebSocket half"
const [port, op, master, opId] = process.argv.slice(2)
const base = `http://127.0.0.1:${port}/api/v1`
const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
const messages = []
let closed = null
socket.addEventListener('message', (e) => {
  if (typeof e.data === 'string') messages.push(JSON.parse(e.data))
})
socket.addEventListener('close', (e) => { closed = e })
await new Promise((resolve) => socket.addEventListener('open', resolve))
socket.send(JSON.stringify({ type: 'auth', token: op }))
const wait = async (ok, ms = 3000) => {
  for (let t = 0; t < ms && !ok(); t += 50) await new Promise((r) => setTimeout(r, 50))
  return ok()
}
if (!(await wait(() => messages.some((m) => m.type === 'authenticated' && m.role === 'operate')))) {
  console.error('FAIL the operate key did not open the socket as operate', messages)
  process.exit(1)
}
console.log('ok   the socket opens as operate')

const auth = { Authorization: `Bearer ${master}` }
const remote = await (await fetch(`${base}/remote`, { headers: auth })).json()
const row = remote.clients.find((c) => c.device === 'Truss')
if (!row || row.role !== 'operate') {
  console.error('FAIL the connection list does not name the device', remote.clients)
  process.exit(1)
}
console.log('ok   the connection list names the device and its role')

const revoked = await (await fetch(`${base}/devices/${opId}`, { method: 'DELETE', headers: auth })).json()
if (revoked.closed !== 1) {
  console.error('FAIL revoking did not close its socket', revoked)
  process.exit(1)
}
if (!(await wait(() => closed !== null))) {
  console.error('FAIL the socket stayed open after the revoke')
  process.exit(1)
}
console.log(`ok   revoking closes the open socket (${closed.code})`)
process.exit(0)
JS

expect 401 "a revoked key over HTTP" "$OP" GET /functions
expect 404 "revoking it twice" "$MASTER" DELETE "/devices/$OP_ID"

# --- Y sobrevive a un reinicio ------------------------------------------------

kill $PID
wait $PID 2>/dev/null || true
arranca
expect 200 "the design key after a restart" "$DS" GET /functions
expect 401 "the revoked key after a restart" "$OP" GET /functions
curl -sf -H "Authorization: Bearer $MASTER" "$BASE/devices" | python3 -c '
import json, sys
names = [d["name"] for d in json.load(sys.stdin)["devices"]]
assert names == ["Diseño"], names
' || fail "the device list did not survive the restart"
echo "ok   the device list survives a restart"

# --- Y desde la shell -----------------------------------------------------------

CLI="$ROOT/mcp/dist/cli.js"
if [ -f "$CLI" ]; then
    ctl() { node "$CLI" --url "http://127.0.0.1:$PORT" --token "$MASTER" "$@"; }
    URL=$(ctl pair "Truss derecho" --role operate 2>/dev/null)
    case "$URL" in
        *"#token="*) ;;
        *) fail "orchidctl pair did not print a URL with the key: $URL" ;;
    esac
    KEY=${URL##*#token=}
    expect 403 "the key orchidctl printed is an operator's" "$KEY" POST /functions '{"type":"Scene","name":"No"}'
    ctl devices | grep -q "operate"$'\t'"Truss derecho" || fail "orchidctl devices does not list it"
    ctl revoke "Truss derecho" > /dev/null || fail "orchidctl revoke failed"
    expect 401 "and revoked from the shell" "$KEY" GET /functions
    echo "ok   orchidctl pairs, lists and revokes"
else
    echo "skip orchidctl: mcp/dist is not built (cd mcp && pnpm build)"
fi

echo "Devices smoke test passed."
