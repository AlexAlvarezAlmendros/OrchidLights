#!/bin/bash
#
# El asistente medido con un modelo de verdad. GASTA TOKENS de la cuenta cuya
# clave esté en Ajustes: no corre en CI ni con los tests de siempre.
#
#   server/test/ai-eval.sh [path-to-orchidlightsd] [escenario ...]
#
# Escenarios: par-truss (montar desde cero) y boda-verde (retocar la boda).
# Sin escenarios, los dos.
#
# Cada escenario corre contra una mesa de usar y tirar: HOME temporal, sin
# salida DMX, con los perfiles de fixture del usuario copiados (la boda usa
# dos propios). La clave y el modelo salen de ~/.orchidlights/ai.json, el que
# escribe Ajustes; la clave va a la mesa temporal por stdin y no se imprime.
#
# Deja en $OUT (por defecto, un directorio temporal) un JSON por escenario con
# las comprobaciones, los pasos, las palabras, el tiempo, los tokens y el coste,
# y el documento en que quedó la mesa.

set -euo pipefail

DAEMON=${1:-orchidlightsd}
shift || true
if [ $# -gt 0 ]; then ESCENARIOS=("$@"); else ESCENARIOS=(par-truss boda-verde); fi

PORT=${PORT:-9990}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
BODA=${BODA:-$HOME/Documentos/Boda-Otonal.qxw}
OUT=${OUT:-$(mktemp -d "${TMPDIR:-/tmp}/orchid-eval.XXXXXX")}
AJUSTES="$HOME/.orchidlights/ai.json"

export QT_QPA_PLATFORM=offscreen

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

[ -f "$AJUSTES" ] || fail "no hay $AJUSTES: pon la clave de Anthropic en Ajustes primero"
python3 - "$AJUSTES" <<'PY' || fail "en $AJUSTES no hay clave de Anthropic"
import json, sys
key = json.load(open(sys.argv[1])).get("providers", {}).get("anthropic", {}).get("key", "")
sys.exit(0 if key else 1)
PY
[ -x "$ROOT/web/node_modules/.bin/vitest" ] || fail "falta pnpm install en web/"
mkdir -p "$OUT"

if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/" 2>/dev/null; then
    fail "algo escucha ya en el puerto $PORT"
fi

STATUS=0
for ESCENARIO in "${ESCENARIOS[@]}"; do
    WORK=$(mktemp -d)
    TEMP_HOME="$WORK/home"
    mkdir -p "$TEMP_HOME/.qlcplus" "$TEMP_HOME/.orchidlights"
    [ -d "$HOME/.qlcplus/fixtures" ] && cp -r "$HOME/.qlcplus/fixtures" "$TEMP_HOME/.qlcplus/"
    [ -d "$HOME/.orchidlights/fixtures" ] && cp -r "$HOME/.orchidlights/fixtures" "$TEMP_HOME/.orchidlights/"

    PROYECTO=()
    if [ "$ESCENARIO" = boda-verde ]; then
        cp "$BODA" "$WORK/boda.qxw"
        PROYECTO=("$WORK/boda.qxw")
    fi

    HOME="$TEMP_HOME" "$DAEMON" --port "$PORT" --no-output "${PROYECTO[@]+"${PROYECTO[@]}"}" \
        > "$WORK/daemon.log" 2>&1 &
    DAEMON_PID=$!
    trap 'kill $DAEMON_PID 2>/dev/null || true; rm -rf "$WORK"' EXIT

    for _ in $(seq 1 100); do
        curl -sf --max-time 1 "http://127.0.0.1:$PORT/api/v1/status" > /dev/null 2>&1 && break
        kill -0 $DAEMON_PID 2>/dev/null || { cat "$WORK/daemon.log" >&2; fail "la mesa de $ESCENARIO no arrancó"; }
        sleep 0.2
    done

    # La clave, de un fichero a otro por stdin: ni en la línea de órdenes ni
    # en la salida.
    MASTER=$(cat "$TEMP_HOME/.orchidlights/api-token")
    python3 - "$AJUSTES" <<'PY' | curl -sf -X PUT "http://127.0.0.1:$PORT/api/v1/ai/settings" \
        -H "Authorization: Bearer $MASTER" -H 'Content-Type: application/json' --data-binary @- > /dev/null \
        || fail "no se pudo poner la clave en la mesa de $ESCENARIO"
import json, sys
anthropic = json.load(open(sys.argv[1]))["providers"]["anthropic"]
print(json.dumps({"provider": "anthropic", "providers": {"anthropic": {
    "key": anthropic["key"],
    "model": anthropic.get("model") or "claude-opus-5-5",
    "baseUrl": anthropic.get("baseUrl") or "https://api.anthropic.com"}}}))
PY

    echo "== $ESCENARIO"
    (cd "$ROOT/web" && ORCHID_EVAL_URL="http://127.0.0.1:$PORT" ORCHID_EVAL_SCENARIO="$ESCENARIO" \
        ORCHID_EVAL_OUT="$OUT" ./node_modules/.bin/vitest run --config eval/vitest.config.ts 2>&1 \
        | grep -E '^(## |ok  |FALLA)' ) || STATUS=1

    kill $DAEMON_PID 2>/dev/null || true
    wait $DAEMON_PID 2>/dev/null || true
    rm -rf "$WORK"
    trap - EXIT
done

echo
echo "Informes en $OUT"
exit $STATUS
