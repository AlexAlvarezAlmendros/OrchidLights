#!/bin/bash
#
# El asistente de punta a punta: la pantalla en Chrome, el SDK de Anthropic de
# verdad, el proxy del daemon en streaming, las herramientas escribiendo en la
# mesa -- y un proveedor falso que hace de modelo con un guion, para no gastar
# un token ni depender de la red.
#
#   server/test/ai-ui-smoke.sh [path-to-orchidlightsd]
#
# Las piezas tienen sus pruebas por separado (vitest para el bucle, los
# dialectos y las herramientas; ai-smoke.sh para el proxy). Esta prueba lo que
# solo se ve juntas: que el SDK lee bien el stream troceado del proxy, que el
# documento que «el modelo» manda acaba en la mesa, y que lo que sale hacia el
# proveedor es lo que tiene que salir.

set -euo pipefail

DAEMON=${1:-orchidlightsd}
PORT=${PORT:-9988}
FAKE=${FAKE_PORT:-9989}
BASE="http://127.0.0.1:$PORT/api/v1"
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CHROME=${CHROME:-google-chrome}

export QT_QPA_PLATFORM=offscreen

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

pass() {
    echo "ok   $*"
}

if ! command -v "$CHROME" > /dev/null 2>&1; then
    echo "No $CHROME on this machine; skipping the assistant UI smoke test."
    exit 0
fi

for port in "$PORT" "$FAKE"; do
    if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$port/" 2>/dev/null; then
        fail "algo escucha ya en el puerto $port"
    fi
done

WORK=$(mktemp -d)
LOG="$WORK/provider.log"
touch "$LOG"
export HOME="$WORK/home"
mkdir -p "$HOME"

python3 "$ROOT/server/test/ai-fake-provider.py" "$FAKE" "$LOG" &
FAKE_PID=$!
"$DAEMON" --port "$PORT" --no-output > "$WORK/daemon.log" 2>&1 &
DAEMON_PID=$!
trap 'kill $FAKE_PID $DAEMON_PID 2>/dev/null || true; [ -n "${KEEP:-}" ] && cp -r "$WORK" "$KEEP"; rm -rf "$WORK"' EXIT

for _ in $(seq 1 100); do
    curl -sf --max-time 1 "$BASE/status" > /dev/null 2>&1 && break
    kill -0 $DAEMON_PID 2>/dev/null || { cat "$WORK/daemon.log" >&2; fail "el daemon salió antes de escuchar"; }
    sleep 0.2
done

curl -sf --max-time 5 "http://127.0.0.1:$PORT/" | grep -q '<div id="root"' \
    || fail "el daemon no sirve la interfaz; corre pnpm build en web/"

MASTER=$(cat "$HOME/.orchidlights/api-token")
KEY="sk-ant-ui-smoke-clave-1234"
curl -sf -X PUT "$BASE/ai/settings" -H "Authorization: Bearer $MASTER" -H 'Content-Type: application/json' \
    -d "{\"provider\": \"anthropic\", \"providers\": {\"anthropic\": {\"baseUrl\": \"http://127.0.0.1:$FAKE\", \"key\": \"$KEY\", \"model\": \"claude-opus-5-5\"}}}" \
    > /dev/null || fail "no se pudo configurar el asistente"

SEEN=$(node "$ROOT/server/test/ai-ui-client.mjs" "http://127.0.0.1:$PORT" "$WORK/asistente.png") || {
    echo "$SEEN" >&2
    fail "el turno no terminó como debía"
}
echo "$SEEN"

python3 - "$SEEN" <<'PY' || exit 1
import json, sys
seen = json.loads(sys.argv[1])
lines = [t["linea"] for t in seen["tools"]]
# A desk with no console answers GET /vc with 404 -- documented, and what the
# console screen gets too. The outline asks for it; that one is not an error.
errors = [e for e in seen["errors"] if not e.endswith("404 (Not Found) (/api/v1/vc)")]
assert errors == [], f"errores en la consola: {errors}"
assert any(l.startswith("Mirar el proyecto") for l in lines), lines
assert "Aplicar Ha aplicado +1 fixture, +1 función" in lines, lines
assert all(t["estado"] == "hecho" for t in seen["tools"]), seen["tools"]
PY
pass "la pantalla pinta cada paso y el final del turno, sin errores en la consola"

# Lo que «el modelo» aplicó está en la mesa.
curl -sf "$BASE/fixtures" | grep -q '"Sala IA"' || fail "la fixture del documento no llegó a la mesa"
curl -sf "$BASE/functions" | grep -q '"Prueba del asistente"' || fail "la escena del documento no llegó a la mesa"
pass "el documento que mandó el modelo está en la mesa: fixture y escena"

# Lo que salió hacia el proveedor, tras el proxy.
python3 - "$LOG" "$KEY" <<'PY' || exit 1
import json, sys
requests = [json.loads(line) for line in open(sys.argv[1]) if '"tools"' in line]
assert len(requests) == 3, f"{len(requests)} peticiones del asistente; el guion son tres"
for seen in requests:
    headers, body = seen["headers"], seen["body"]
    assert headers.get("x-api-key") == sys.argv[2], "la clave guardada no llegó"
    assert "authorization" not in headers, "la llave de la mesa salió hacia el proveedor"
    assert headers.get("anthropic-beta") == "server-side-fallback-2026-07-01", headers.get("anthropic-beta")
    assert body["model"] == "claude-opus-5-5", body["model"]
    assert body.get("fallbacks") == "default", body.get("fallbacks")
    assert body["system"][0]["cache_control"] == {"type": "ephemeral"}, body["system"]
    assert body.get("cache_control") == {"type": "ephemeral"}, "sin caché de la conversación"
    assert all(t.get("eager_input_streaming") is True for t in body["tools"]), "sin streaming de entradas"
    assert body["thinking"] == {"type": "adaptive", "display": "summarized"}, body["thinking"]
    assert body["output_config"] == {"effort": "high"}, body["output_config"]
# The third request carries the whole turn, appended and in order.
roles = [m["role"] for m in requests[2]["body"]["messages"]]
assert roles == ["user", "assistant", "user", "assistant", "user"], roles
PY
pass "al proveedor llegan la clave guardada, el modelo fijado, la caché, los fallbacks y un historial que solo crece"

echo
echo "PASS: el asistente monta en la mesa lo que dice, y por donde debe."
