#!/bin/bash
#
# El dial de tempo, tocado desde fuera.
#
#   server/test/tempo-smoke.sh [path-to-orchidlightsd] [path-to-project.qxw]
#
# Un dial lleva CUATRO mandos externos en un solo widget -- tap, multiplicar,
# dividir y volver al tempo de partida --, cada uno con su <Input ID>. Leerlos
# en el hueco de una sola asignación deja tres fuera en silencio: el show sigue
# abriendo, el pad de tap sigue encendido, y no pasa nada al pulsarlo.
#
# El plugin Loopback cierra el circuito: la salida del universo 2 alimenta su
# propia entrada, así que escribir un canal por la mesa simple es pulsar el
# mando. Lo que se comprueba es el número que acaba teniendo el chaser.
#
# Necesita el plugin Loopback, así que NO se arranca con --no-output.

set -euo pipefail

DAEMON=${1:-orchidlightsd}
SOURCE=${2:-server/test/data/vc-tempo.qxw}
PORT=${PORT:-9945}
BASE="http://127.0.0.1:$PORT/api/v1"

export QT_QPA_PLATFORM=offscreen

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/" 2>/dev/null; then
    fail "something is already listening on port $PORT; set PORT= to another one"
fi

WORK=$(mktemp -d)
cp "$SOURCE" "$WORK/tempo.qxw"
read -r -a EXTRA <<< "${ORCHID_TEST_ARGS:-}"

"$DAEMON" --port "$PORT" "${EXTRA[@]+"${EXTRA[@]}"}" "$WORK/tempo.qxw" > "$WORK/daemon.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true; rm -rf "$WORK"' EXIT

for _ in $(seq 1 100); do
    curl -sf --max-time 1 "$BASE/status" > /dev/null 2>&1 && break
    kill -0 $PID 2>/dev/null || { cat "$WORK/daemon.log" >&2; fail "the daemon exited early"; }
    sleep 0.2
done

# El dial dice sus cuatro mandos: sin esto, tres se perdieron al leer el fichero.
curl -sf --max-time 5 "$BASE/vc" | python3 -c '
import json, sys
def walk(w):
    yield w
    for c in w.get("children", []):
        yield from walk(c)
dial = next(w for w in walk(json.load(sys.stdin)) if w.get("type") == "speeddial")
controls = {c["control"]: c["channel"] for c in dial.get("speedInputs", [])}
assert controls == {"tap": 10, "multiply": 11, "divide": 12, "reset": 13}, controls
' || fail "el dial no reporta sus cuatro mandos"

# Y el ID de un mando es cosa del dial: QLC+ 5 escribe ID="0" en la única
# asignación de un botón, y leerla como mando de tempo le quitaba el MIDI a
# cada botón de un show guardado allí.
curl -sf --max-time 5 "$BASE/vc" | python3 -c '
import json, sys
def walk(w):
    yield w
    for c in w.get("children", []):
        yield from walk(c)
button = next(w for w in walk(json.load(sys.stdin)) if w.get("type") == "button")
assert button.get("input") == {"universe": 1, "channel": 15, "lower": 2, "upper": 4}, button.get("input")
assert "speedInputs" not in button, button
' || fail "un botón con <Input ID=\"0\"> perdió su asignación"

# El universo 2 en bucle: salida, entrada y realimentación por la misma línea.
LOOP=$(curl -sf --max-time 5 "$BASE/io" | python3 -c '
import json, sys
io = json.load(sys.stdin)
line = next(p["lines"][0] for p in io["outputPlugins"] if p["name"] == "Loopback")
print(line)
') || fail "el plugin Loopback no está cargado"

curl -sf --max-time 5 -X PATCH "$BASE/universes/2" -H 'Content-Type: application/json' \
    -d "{\"output\":{\"plugin\":\"Loopback\",\"line\":\"$LOOP\"},\"input\":{\"plugin\":\"Loopback\",\"line\":\"$LOOP\"}}" \
    > /dev/null || fail "no se pudo cerrar el bucle en el universo 2"

# Un mando es un flanco de subida y su suelta.
pulsa() {
    curl -sf --max-time 5 -X PUT "$BASE/simpledesk/2/channels" -H 'Content-Type: application/json' \
        -d "{\"values\":{\"$1\":255}}" > /dev/null
    sleep 0.15
    curl -sf --max-time 5 -X PUT "$BASE/simpledesk/2/channels" -H 'Content-Type: application/json' \
        -d "{\"values\":{\"$1\":0}}" > /dev/null
    sleep 0.15
}

duracion() {
    curl -sf --max-time 5 "$BASE/functions" \
        | python3 -c 'import json,sys; print(next(f["duration"] for f in json.load(sys.stdin) if f["name"] == "Al ritmo"))'
}

espera() {   # espera a que la duración sea la pedida, o se rinde
    for _ in $(seq 1 20); do
        [ "$(duracion)" = "$1" ] && return 0
        sleep 0.1
    done
    return 1
}

[ "$(duracion)" = "1000" ] || fail "el chaser no arranca en 1000 ms: $(duracion)"

# El botón de ID="0" responde a su mando, no solo lo reporta.
azul() {
    curl -sf --max-time 5 "$BASE/functions" \
        | python3 -c 'import json,sys; print(next(str(f["running"]).lower() for f in json.load(sys.stdin) if f["name"] == "Azul"))'
}
pulsa 16
for _ in $(seq 1 20); do [ "$(azul)" = "true" ] && break; sleep 0.1; done
[ "$(azul)" = "true" ] || fail "el mando del botón con <Input ID=\"0\"> no arrancó su escena"
pulsa 16
for _ in $(seq 1 20); do [ "$(azul)" = "false" ] && break; sleep 0.1; done
[ "$(azul)" = "false" ] || fail "el segundo golpe al botón no paró su escena"

# Los canales de la mesa simple van desde 1; los del widget, desde 0.
pulsa 13 && espera 500 || fail "dividir no bajó la duración a 500: $(duracion)"
pulsa 12 && espera 1000 || fail "multiplicar no la devolvió a 1000: $(duracion)"
pulsa 12 && espera 2000 || fail "multiplicar otra vez no llegó a 2000: $(duracion)"
pulsa 14 && espera 1000 || fail "volver al tempo de partida no dejó 1000: $(duracion)"

# Y el tap: dos golpes marcan el intervalo. Se comprueba con holgura porque lo
# que se mide es tiempo de reloj a través de HTTP, no una constante.
pulsa 11
sleep 0.6
pulsa 11
TAPPED=$(duracion)
[ "$TAPPED" -gt 550 ] && [ "$TAPPED" -lt 1200 ] \
    || fail "el tap no puso la duración cerca del intervalo de 0,9 s: $TAPPED"

# Un tap suelto, mucho después, no promedia la pausa: empieza a contar de nuevo.
sleep 3.2
pulsa 11
[ "$(duracion)" = "$TAPPED" ] || fail "un tap aislado tras una pausa larga movió el tempo: $(duracion)"

# ---------------------------------------------------------------------------
# Y un botón de mantener pulsado sobre el chaser.
#
# Solo una escena tiene la capa de flash del motor: sobre un chaser,
# Function::flash no enciende nada y se limita a levantar una bandera, así que
# el botón se reportaba encendido sobre un rig que no había cambiado. Sujetar
# es sujetar: corre mientras el dedo esté abajo. De eso vive un pad de estrobo
# que va al tempo, que es un chaser y no una escena.
# ---------------------------------------------------------------------------

BOTON=$(curl -sf --max-time 5 -X POST "$BASE/vc/widgets" -H 'Content-Type: application/json' \
    -d '{"type":"button","parent":0}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])') \
    || fail "no se pudo crear el botón"
curl -sf --max-time 5 -X PATCH "$BASE/vc/widgets/$BOTON" -H 'Content-Type: application/json' \
    -d '{"caption":"Sujeta","functionId":2,"action":"Flash"}' > /dev/null \
    || fail "no se pudo poner el botón en flash sobre el chaser"

corriendo() {
    curl -sf --max-time 5 "$BASE/functions" \
        | python3 -c 'import json,sys; print(next(str(f["running"]).lower() for f in json.load(sys.stdin) if f["name"] == "Al ritmo"))'
}

[ "$(corriendo)" = "false" ] || fail "el chaser ya estaba corriendo antes de pulsar"

curl -sf --max-time 5 -X POST "$BASE/vc/widgets/$BOTON/press" -H 'Content-Type: application/json' \
    -d '{"on":true}' > /dev/null
sleep 0.4
[ "$(corriendo)" = "true" ] || fail "sujetar el botón no arrancó el chaser"

curl -sf --max-time 5 -X POST "$BASE/vc/widgets/$BOTON/press" -H 'Content-Type: application/json' \
    -d '{"on":false}' > /dev/null
sleep 0.4
[ "$(corriendo)" = "false" ] || fail "soltar el botón no paró el chaser"

echo "Tempo smoke test passed (tap, x2, /2, vuelta al tempo de partida y sujetar un chaser)."
