#!/bin/bash
#
# El proyecto como archivo de texto, de ida y vuelta.
#
# Dos daemons: uno con un show de verdad y otro vacío. Se exporta el primero, se
# aplica sobre el segundo, y se comprueba que lo que sale es lo mismo que
# entró -- por nombre, nunca por id, porque los ids los reparte el motor y no
# tienen por qué coincidir entre dos proyectos.
#
# Si esto falla, exportar y volver a aplicar es una forma elaborada de corromper
# un show, y no hay que confiarle ninguno.
#
#   server/test/spec-smoke.sh [path-to-orchidlightsd] [path-to-project.qxw]

set -euo pipefail

DAEMON=${1:-orchidlightsd}
PROJECT=${2:-resources/samples/Sample.qxw}
SOURCE_PORT=${SOURCE_PORT:-9938}
TARGET_PORT=${TARGET_PORT:-9939}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)

export QT_QPA_PLATFORM=offscreen

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

[ -f "$ROOT/mcp/dist/index.js" ] \
    || fail "el paquete no está construido: cd mcp && pnpm install && pnpm build"

for port in "$SOURCE_PORT" "$TARGET_PORT"; do
    if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$port/" 2>/dev/null; then
        fail "algo escucha ya en el puerto $port"
    fi
done

# --no-output las dos: esto es un test y no tiene por qué poner DMX en la red.
"$DAEMON" --port "$SOURCE_PORT" --no-output "$PROJECT" > /tmp/orchid-spec-source.log 2>&1 &
SOURCE_PID=$!
"$DAEMON" --port "$TARGET_PORT" --no-output > /tmp/orchid-spec-target.log 2>&1 &
TARGET_PID=$!
trap 'kill $SOURCE_PID $TARGET_PID 2>/dev/null || true' EXIT

for port in "$SOURCE_PORT" "$TARGET_PORT"; do
    ready=""
    for _ in $(seq 1 150); do
        if curl -sf --max-time 1 "http://127.0.0.1:$port/api/v1/status" > /dev/null 2>&1; then
            ready=yes
            break
        fi
        sleep 0.2
    done
    [ -n "$ready" ] || {
        cat "/tmp/orchid-spec-source.log" "/tmp/orchid-spec-target.log" >&2
        fail "el daemon del puerto $port no llegó a escuchar"
    }
done

node "$ROOT/server/test/spec-client.mjs" \
    "http://127.0.0.1:$SOURCE_PORT" "http://127.0.0.1:$TARGET_PORT"
