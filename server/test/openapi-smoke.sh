#!/bin/bash
#
# El contrato OpenAPI contra la realidad.
#
# Dos mitades: las comprobaciones estáticas viven en openapi-contract.py, que
# compara la spec con apiserver.cpp y no necesita nada corriendo; y la de aquí,
# que arranca un daemon de verdad y comprueba que sirve el mismo contrato que
# hay en el repositorio.
#
#   server/test/openapi-smoke.sh [path-to-orchidlightsd]

set -euo pipefail

DAEMON=${1:-orchidlightsd}
PORT=${PORT:-9998}
BASE="http://127.0.0.1:$PORT/api/v1"
ROOT=$(cd "$(dirname "$0")/../.." && pwd)

export QT_QPA_PLATFORM=offscreen

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

python3 -c 'import yaml' 2>/dev/null || fail "hace falta PyYAML: sudo apt install python3-yaml"

python3 "$ROOT/server/test/openapi-contract.py" "$ROOT" || exit 1

# ---------------------------------------------------------------------------
# Y un daemon de verdad lo sirve, y sirve el mismo
# ---------------------------------------------------------------------------

if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/" 2>/dev/null; then
    fail "algo escucha ya en el puerto $PORT; pon PORT= a otro"
fi

"$DAEMON" --port "$PORT" --no-output > /tmp/orchid-openapi-smoke.log 2>&1 &
DAEMON_PID=$!
trap 'kill $DAEMON_PID 2>/dev/null || true' EXIT

for _ in $(seq 1 100); do
    if curl -sf --max-time 1 "$BASE/status" > /dev/null 2>&1; then
        break
    fi
    if ! kill -0 $DAEMON_PID 2>/dev/null; then
        cat /tmp/orchid-openapi-smoke.log >&2
        fail "el daemon salió antes de escuchar"
    fi
    sleep 0.2
done

DISCOVERY=$(curl -sf --max-time 5 "$BASE") || fail "GET /api/v1 no contestó"
echo "$DISCOVERY"

python3 - "$DISCOVERY" <<'PY' || exit 1
import json
import sys

body = json.loads(sys.argv[1])
assert body["apiVersion"] == 1, body
assert body["openapi"] == "/api/v1/openapi.json", body
assert body["websocket"] == "/ws", body
assert isinstance(body["authRequired"], bool), body
# En loopback y sin token no hace falta ninguno, así que el proyecto sale.
assert "project" in body, body
assert set(body["access"]) == {
    "fixtures",
    "functions",
    "vcControl",
    "vcEditing",
    "simpleDesk",
    "show",
    "io",
}, body
print("descubrimiento OK")
PY

curl -sf --max-time 5 "$BASE/openapi.json" -o /tmp/orchid-served-contract.json \
    || fail "GET /api/v1/openapi.json no contestó -- ¿está instalado docs/api/openapi.json?"

python3 - "$ROOT" /tmp/orchid-served-contract.json <<'PY' || exit 1
import json
import pathlib
import sys

served = json.loads(pathlib.Path(sys.argv[2]).read_text())
checked_in = json.loads((pathlib.Path(sys.argv[1]) / "docs/api/openapi.json").read_text())

if served != checked_in:
    print("el contrato que sirve el daemon no es el del repositorio", file=sys.stderr)
    sys.exit(1)

print(f"el daemon sirve el mismo contrato: {len(served['paths'])} rutas")
PY

# ---------------------------------------------------------------------------
# Y el bucle de verificación funciona: se escribe, y se lee de vuelta
# ---------------------------------------------------------------------------
#
# Es lo que separa configurar de adivinar. Un agente que no puede mirar el
# universo de vuelta no sabe si lo que hizo llegó a alguna lámpara.

kill $DAEMON_PID 2>/dev/null || true
wait $DAEMON_PID 2>/dev/null || true

"$DAEMON" --port "$PORT" --no-output "$ROOT/resources/samples/Sample.qxw" \
    > /tmp/orchid-openapi-smoke.log 2>&1 &
DAEMON_PID=$!

for _ in $(seq 1 100); do
    if curl -sf --max-time 1 "$BASE/status" > /dev/null 2>&1; then
        break
    fi
    if ! kill -0 $DAEMON_PID 2>/dev/null; then
        cat /tmp/orchid-openapi-smoke.log >&2
        fail "el daemon salió antes de escuchar"
    fi
    sleep 0.2
done

DARK=$(curl -sf --max-time 5 "$BASE/universes/1/dmx") || fail "GET /universes/1/dmx no contestó"
python3 - "$DARK" <<'PY' || exit 1
import json
import sys

body = json.loads(sys.argv[1])
assert body["universe"] == 1, body
assert len(body["values"]) == 512, len(body["values"])
assert body["active"] == [], body["active"]
assert body["blackout"] is False, body
print("un universo a oscuras son 512 ceros y ningún canal activo")
PY

# Escrito con la forma que documenta el contrato: fixture e índice de canal
# dentro de ella, que es la trampa que este test existe para no repetir.
curl -sf -X PUT "$BASE/live" -H 'Content-Type: application/json' \
     -d '{"values": [{"fixture": 0, "channel": 0, "value": 200}]}' > /dev/null \
    || fail "PUT /live no aceptó el cuerpo que documenta el contrato"

sleep 0.5

LIT=$(curl -sf --max-time 5 "$BASE/universes/1/dmx") || fail "GET /universes/1/dmx no contestó"
python3 - "$LIT" <<'PY' || exit 1
import json
import sys

body = json.loads(sys.argv[1])
active = body["active"]

assert active, "se clavó un canal en vivo y el universo sigue a oscuras"

first = active[0]
assert first["value"] == 200, first
assert first["fixture"] == 0, first
# Con nombre, que es lo que hace la respuesta verificable en vez de numérica.
assert first["fixtureName"], first
assert first["channelName"], first
print(f"leído de vuelta: {first['fixtureName']} · {first['channelName']} · {first['value']}")
PY

curl -sf -X DELETE "$BASE/live" > /dev/null || fail "DELETE /live falló"
sleep 0.5

python3 - "$(curl -sf "$BASE/universes/1/dmx")" <<'PY' || exit 1
import json
import sys

body = json.loads(sys.argv[1])
# Soltar baja los canales a cero en vez de dejarlos enganchados.
assert body["active"] == [], body["active"]
print("y soltar la mesa en vivo devuelve el universo a cero")
PY

echo
echo "PASS: el contrato y el código dicen lo mismo, y lo que se escribe se lee."
