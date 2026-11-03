#!/bin/bash
#
# El asistente por fuera: la clave y el proxy (F10.1), contra un proveedor
# falso que apunta todo lo que le llega.
#
#   server/test/ai-smoke.sh [path-to-orchidlightsd]
#
# Lo que se comprueba es lo que no se ve desde la interfaz: que la clave llega
# al proveedor y no vuelve nunca a un cliente, que la llave de la mesa no sale
# de ella, que el modelo lo pone la mesa, que el stream llega troceado y no al
# final, que un cliente que corta corta también al proveedor, que solo las dos
# rutas de la lista llegan a alguna parte, y quién puede qué.
#
# Con un HOME temporal: la clave y ai.json de quien corre el test no se tocan.

set -euo pipefail

DAEMON=${1:-orchidlightsd}
PORT=${PORT:-9986}
FAKE=${FAKE_PORT:-9987}
BASE="http://127.0.0.1:$PORT/api/v1"
ROOT=$(cd "$(dirname "$0")/../.." && pwd)

export QT_QPA_PLATFORM=offscreen

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

pass() {
    echo "ok   $*"
}

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
DAEMON_PID=""
trap 'kill $FAKE_PID $DAEMON_PID 2>/dev/null || true; rm -rf "$WORK"' EXIT

start_daemon() {
    "$DAEMON" --port "$PORT" --no-output > "$WORK/daemon.log" 2>&1 &
    DAEMON_PID=$!
    for _ in $(seq 1 100); do
        curl -sf --max-time 1 "$BASE/status" > /dev/null 2>&1 && return 0
        kill -0 $DAEMON_PID 2>/dev/null || { cat "$WORK/daemon.log" >&2; fail "el daemon salió antes de escuchar"; }
        sleep 0.2
    done
    fail "el daemon no contestó"
}

stop_daemon() {
    kill $DAEMON_PID 2>/dev/null || true
    wait $DAEMON_PID 2>/dev/null || true
    DAEMON_PID=""
}

start_daemon
MASTER=$(cat "$HOME/.orchidlights/api-token")
GOOD="sk-test-good-key-1234"

# Lo último que le llegó al proveedor falso, como JSON.
last_request() {
    grep '"method"' "$LOG" | tail -1
}

# --- Sin configurar ----------------------------------------------------------

SETTINGS=$(curl -sf "$BASE/ai/settings") || fail "GET /ai/settings"
python3 - "$SETTINGS" <<'PY' || exit 1
import json, sys
body = json.loads(sys.argv[1])
assert body["provider"] == "anthropic", body
assert body["providers"]["anthropic"]["configured"] is False, body
assert body["providers"]["anthropic"]["model"] == "claude-opus-5-5", body
assert body["providers"]["openai"]["configured"] is False, body
assert "key" not in json.dumps(body).replace('"keyHint"', ""), body
PY
pass "sin configurar: Anthropic con Opus 5.5 por defecto, y ninguna clave"

STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/ai/proxy/anthropic/v1/messages" \
    -H 'Content-Type: application/json' -d '{"messages":[]}')
[ "$STATUS" = 401 ] || fail "sin clave el proxy debía dar 401 (authentication_error), dio $STATUS"
pass "sin clave, el proxy lo dice como el proveedor: 401 authentication_error"

# --- Configurar: solo la maestra --------------------------------------------

CONFIG=$(cat <<EOF
{"provider": "anthropic", "dailyRequests": 2,
 "providers": {
   "anthropic": {"baseUrl": "http://127.0.0.1:$FAKE/", "key": "$GOOD", "model": "claude-opus-5-5"},
   "openai": {"baseUrl": "http://127.0.0.1:$FAKE", "key": "", "model": "llama3"}}}
EOF
)

STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/ai/settings" \
    -H 'Content-Type: application/json' -d "$CONFIG")
[ "$STATUS" = 401 ] || fail "PUT /ai/settings sin la maestra dio $STATUS"

SAVED=$(curl -sf -X PUT "$BASE/ai/settings" -H "Authorization: Bearer $MASTER" \
    -H 'Content-Type: application/json' -d "$CONFIG") || fail "PUT /ai/settings con la maestra"
echo "$SAVED" | grep -q "$GOOD" && fail "la respuesta del PUT lleva la clave"
python3 - "$SAVED" "$FAKE" <<'PY' || exit 1
import json, sys
body = json.loads(sys.argv[1])
anthropic = body["providers"]["anthropic"]
assert anthropic["configured"] is True, body
assert anthropic["keyHint"] == "…1234", body
assert anthropic["baseUrl"] == f"http://127.0.0.1:{sys.argv[2]}", "la barra final no se quitó"
assert body["dailyRequests"] == 2, body
PY
pass "la maestra configura; la respuesta dice que hay clave y enseña cuatro caracteres"

FILE="$HOME/.orchidlights/ai.json"
[ "$(stat -c %a "$FILE")" = 600 ] || fail "ai.json tiene permisos $(stat -c %a "$FILE"), no 600"
grep -q "$GOOD" "$FILE" || fail "ai.json no guarda la clave"
pass "ai.json, solo para su dueño"

for bad in '{"provider": "skynet"}' \
           '{"providers": {"anthropic": {"baseUrl": "ftp://x"}}}' \
           '{"providers": {"cohere": {}}}' \
           '{"dailyRequests": -1}'; do
    STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/ai/settings" \
        -H "Authorization: Bearer $MASTER" -H 'Content-Type: application/json' -d "$bad")
    [ "$STATUS" = 400 ] || fail "PUT $bad debía dar 400, dio $STATUS"
done
curl -sf "$BASE/ai/settings" | grep -q '"dailyRequests":2' || fail "un PUT rechazado cambió algo"
pass "lo que no vale se rechaza entero y no cambia nada"

# --- Probar la clave sin gastar un token -------------------------------------

CHECK=$(curl -sf -X POST "$BASE/ai/check" -H 'Content-Type: application/json' -d '{}') \
    || fail "POST /ai/check"
python3 - "$CHECK" <<'PY' || exit 1
import json, sys
body = json.loads(sys.argv[1])
assert body["ok"] is True and "claude-haiku-5-5" in body["models"], body
PY
grep '"path": "/v1/models' "$LOG" | tail -1 | grep -q "\"x-api-key\": \"$GOOD\"" \
    || fail "check no mandó la clave guardada"
pass "check lista los modelos con la clave guardada"

# --- El proxy: qué pasa y qué no ---------------------------------------------

ANSWER=$(curl -sf -X POST "$BASE/ai/proxy/anthropic/v1/messages" \
    -H "Authorization: Bearer $MASTER" \
    -H 'x-api-key: placeholder' \
    -H 'anthropic-version: 2023-06-01' \
    -H 'anthropic-dangerous-direct-browser-access: true' \
    -H 'Content-Type: application/json' \
    -d '{"model": "claude-haiku-5-5", "max_tokens": 10, "messages": [{"role": "user", "content": "hola"}]}') \
    || fail "el proxy no contestó"
echo "$ANSWER" | grep -q '"hola"' || fail "la respuesta del proveedor no llegó: $ANSWER"

python3 - "$(last_request)" "$GOOD" <<'PY' || exit 1
import json, sys
seen = json.loads(sys.argv[1])
headers = seen["headers"]
assert seen["path"] == "/v1/messages", seen
assert headers.get("x-api-key") == sys.argv[2], "la clave de la mesa no llegó"
assert "authorization" not in headers, "la llave de la mesa salió hacia el proveedor"
assert "anthropic-dangerous-direct-browser-access" not in headers, headers
assert headers.get("anthropic-version") == "2023-06-01", headers
assert seen["body"]["model"] == "claude-opus-5-5", "el modelo lo eligió el cliente"
PY
pass "llega la clave guardada; ni la llave de la mesa ni el modelo del cliente salen"

# El stream, troceado según llega y no de golpe al final.
python3 - "$BASE" "$MASTER" <<'PY' || exit 1
import json, sys, time, urllib.request
request = urllib.request.Request(
    sys.argv[1] + "/ai/proxy/anthropic/v1/messages",
    data=json.dumps({"stream": True, "messages": [{"role": "user", "content": "hola"}]}).encode(),
    headers={"Content-Type": "application/json", "Authorization": "Bearer " + sys.argv[2]},
    method="POST")
arrivals = []
with urllib.request.urlopen(request, timeout=20) as response:
    assert response.headers["Content-Type"] == "text/event-stream", response.headers
    for line in response:
        if line.startswith(b"data:"):
            arrivals.append(time.monotonic())
# message_start, tres deltas, message_delta y message_stop, cada 300 ms.
assert len(arrivals) == 6, f"{len(arrivals)} eventos"
spread = arrivals[-1] - arrivals[0]
assert spread > 1.2, f"los eventos llegaron en {spread:.2f} s: el proxy los acumuló"
print(f"ok   el stream llega troceado: 6 eventos repartidos en {spread:.1f} s")
PY

USAGE=$(curl -sf "$BASE/ai/settings")
python3 - "$USAGE" <<'PY' || exit 1
import json, sys
usage = json.loads(sys.argv[1])["usage"]
# 11 + 7 de la respuesta entera; 20 + 5 de caché y 9 del stream.
assert usage["requests"] == 2, usage
assert usage["inputTokens"] == 36, usage
assert usage["outputTokens"] == 16, usage
PY
pass "el gasto del día se lee del propio proveedor, caché incluida"

# Un cliente que corta: el proveedor se entera, no sigue hablando para nadie.
curl -s -m 1 -X POST "$BASE/ai/proxy/anthropic/v1/messages" -H 'Content-Type: application/json' \
    -d '{"stream": true, "messages": [{"role": "user", "content": "slow"}]}' > /dev/null || true
for _ in $(seq 1 20); do
    grep -q '"client closed"' "$LOG" && break
    sleep 0.25
done
grep -q '"client closed"' "$LOG" || fail "el cliente cortó y el proveedor siguió hablando"
pass "un cliente que corta corta también la petición al proveedor"
curl -sf "$BASE/status" > /dev/null || fail "el daemon no sobrevivió al corte"

# Solo las rutas de la lista.
for path in /ai/proxy/anthropic/v1/files /ai/proxy/anthropic/v1/messages/batches /ai/proxy/openai/files; do
    STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE$path" \
        -H 'Content-Type: application/json' -d '{}')
    [ "$STATUS" = 404 ] || fail "POST $path debía dar 404, dio $STATUS"
done
pass "una ruta fuera de la lista no llega a ninguna parte"

# El dialecto de OpenAI: sin clave no manda Authorization; con ella, la suya.
curl -sf -X POST "$BASE/ai/proxy/openai/chat/completions" -H "Authorization: Bearer $MASTER" \
    -H 'Content-Type: application/json' -d '{"model": "gpt-x", "messages": []}' > /dev/null \
    || fail "el proxy de OpenAI no contestó"
python3 - "$(last_request)" <<'PY' || exit 1
import json, sys
seen = json.loads(sys.argv[1])
assert seen["path"] == "/chat/completions", seen
assert "authorization" not in seen["headers"], "sin clave no debía ir Authorization (un modelo local)"
assert seen["body"]["model"] == "llama3", seen
PY
curl -sf -X PUT "$BASE/ai/settings" -H "Authorization: Bearer $MASTER" -H 'Content-Type: application/json' \
    -d '{"providers": {"openai": {"key": "sk-openai-test-5678"}}}' > /dev/null
curl -sf -X POST "$BASE/ai/proxy/openai/chat/completions" -H "Authorization: Bearer $MASTER" \
    -H 'Content-Type: application/json' -d '{"messages": []}' > /dev/null
last_request | grep -q '"authorization": "Bearer sk-openai-test-5678"' \
    || fail "con clave, OpenAI no recibió la suya en Authorization"
curl -sf "$BASE/ai/settings" | grep -q '"configured":true' || fail "la clave de Anthropic se perdió al tocar la de OpenAI"
pass "OpenAI: la clave en Authorization, y ninguna cuando no hay (modelos locales)"

# --- Quién puede qué, y el tope ---------------------------------------------

pair() {
    curl -sf -X POST "$BASE/devices" -H "Authorization: Bearer $MASTER" \
        -H 'Content-Type: application/json' -d "{\"name\": \"$1\", \"role\": \"$2\"}" \
        | python3 -c 'import json,sys; print(json.load(sys.stdin)["key"])'
}
OPERATOR=$(pair "Móvil de prueba" operate)

STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/ai/check" \
    -H "Authorization: Bearer $OPERATOR" -H 'Content-Type: application/json' -d '{}')
[ "$STATUS" = 403 ] || fail "un operador no configura el asistente; check dio $STATUS"
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/ai/settings" \
    -H "Authorization: Bearer $OPERATOR" -H 'Content-Type: application/json' -d '{}')
[ "$STATUS" = 401 ] || fail "un operador no cambia la clave; PUT dio $STATUS"

ask() {
    curl -s -o "$WORK/answer.json" -w '%{http_code}' -X POST "$BASE/ai/proxy/anthropic/v1/messages" \
        -H "Authorization: Bearer $1" -H 'Content-Type: application/json' \
        -d '{"messages": [{"role": "user", "content": "hola"}]}'
}
[ "$(ask "$OPERATOR")" = 200 ] || fail "un operador puede preguntar (1)"
[ "$(ask "$OPERATOR")" = 200 ] || fail "un operador puede preguntar (2)"
[ "$(ask "$OPERATOR")" = 403 ] || fail "el tercero pasaba el tope de 2"
grep -q '"permission_error"' "$WORK/answer.json" || fail "el tope no habló como el proveedor"
[ "$(ask "$MASTER")" = 200 ] || fail "la mesa misma no tiene tope"
pass "un operador pregunta pero no configura; el tope corta al dispositivo, no a la mesa"

# --- Cuando el proveedor no está ---------------------------------------------

curl -sf -X PUT "$BASE/ai/settings" -H "Authorization: Bearer $MASTER" -H 'Content-Type: application/json' \
    -d '{"providers": {"anthropic": {"baseUrl": "http://127.0.0.1:1"}}}' > /dev/null
STATUS=$(curl -s -o "$WORK/answer.json" -w '%{http_code}' -X POST "$BASE/ai/proxy/anthropic/v1/messages" \
    -H 'Content-Type: application/json' -d '{"messages": []}')
[ "$STATUS" = 502 ] || fail "sin proveedor debía dar 502, dio $STATUS"
grep -q '"api_error"' "$WORK/answer.json" || fail "el 502 no habla como el proveedor"
pass "sin proveedor, un 502 en sus propias palabras"

curl -sf -X PUT "$BASE/ai/settings" -H "Authorization: Bearer $MASTER" -H 'Content-Type: application/json' \
    -d "{\"providers\": {\"anthropic\": {\"baseUrl\": \"http://127.0.0.1:$FAKE\", \"key\": \"sk-test-bad-key-0000\"}}}" > /dev/null
CHECK=$(curl -sf -X POST "$BASE/ai/check" -H 'Content-Type: application/json' -d '{"provider": "anthropic"}')
echo "$CHECK" | grep -q '"ok":false' || fail "una clave mala pasó el check: $CHECK"
echo "$CHECK" | grep -q 'invalid x-api-key' || fail "el check no dijo lo que dijo el proveedor"
pass "una clave mala se dice con las palabras del proveedor"

# --- Lo guardado sobrevive; lo roto no tumba la mesa -------------------------

stop_daemon
start_daemon
curl -sf "$BASE/ai/settings" | grep -q '"keyHint":"…0000"' || fail "la clave no sobrevivió al reinicio"
pass "los ajustes sobreviven a un reinicio"

stop_daemon
echo "esto no es json" > "$FILE"
start_daemon
curl -sf "$BASE/ai/settings" | grep -q '"configured":false' || fail "un ai.json roto no se ignoró"
grep -q "ai.json is not a JSON object" "$WORK/daemon.log" || fail "el ai.json roto no se dijo"
pass "un ai.json roto se dice y la mesa arranca igual"

echo
echo "PASS: la clave se queda en la mesa y el proxy deja pasar solo lo que debe."
