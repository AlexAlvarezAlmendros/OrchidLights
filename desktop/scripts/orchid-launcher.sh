#!/bin/sh
#
# Lanza el servidor MCP o el CLI que viajan dentro del paquete de escritorio.
#
# Se instala DOS VECES, con dos nombres, y decide cuál correr por el suyo:
#
#   orchidlights-mcp   -> orchidlights-mcp.mjs   (stdio, para un agente)
#   orchidctl          -> orchidctl.mjs          (para una persona)
#
# Un solo fichero porque lo único que hacen los dos es lo mismo: encontrar un
# Node, encontrar el bundle, y ceder el proceso. La URL de la mesa no se
# resuelve aquí -- eso lo hace el propio JS, que ya lee $ORCHID_URL, el
# ~/.orchidlights/desktop-url que deja la carcasa, y el 9998 por defecto. Una
# sola implementación, y no dos que se separan.

set -eu

NAME=$(basename "$0")
case "$NAME" in
    orchidctl) BUNDLE=orchidctl.mjs ;;
    *)         BUNDLE=orchidlights-mcp.mjs ;;
esac

# --- el bundle -------------------------------------------------------------
#
# Este script puede acabar en tres sitios y tiene que funcionar en los tres:
# junto al daemon en el árbol staged, dentro del AppImage, y en /usr/bin de un
# .deb -- donde NO está junto a nada, porque los recursos se instalan aparte.
#
# Tauri resuelve los suyos en Linux como <directorio del ejecutable>/../lib/
# <nombre> (tauri-utils, platform.rs: resource_dir_from), y la configuración
# monta el sidecar dentro. Desde /usr/bin eso es /usr/lib/<nombre>/sidecar, y
# el <nombre> lo elige el empaquetador: de ahí el comodín.
#
# Cada candidato se confirma con el fichero que tiene que estar, como hace
# InstallPaths en el daemon: una ruta que existe no es lo mismo que la buena.

HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)

for candidate in \
    "${ORCHID_MCP_DIR:-}" \
    "$HERE/../share/orchidlights/mcp" \
    /usr/lib/*/sidecar/share/orchidlights/mcp \
    /usr/share/orchidlights/mcp
do
    [ -n "$candidate" ] || continue
    if [ -f "$candidate/$BUNDLE" ]; then
        FOUND="$candidate/$BUNDLE"
        break
    fi
done

if [ -z "${FOUND:-}" ]; then
    echo "$NAME: no encuentro $BUNDLE." >&2
    echo "Si estás en el repositorio: cd mcp && pnpm install && pnpm bundle," >&2
    echo "y apunta ORCHID_MCP_DIR a mcp/dist/bundle." >&2
    exit 1
fi

# --- el Node ---------------------------------------------------------------
#
# El paquete NO lo lleva: son 119 MB de runtime que doblarían su peso por una
# función que muchos no van a usar. Quien cablea un agente a su mesa ya tiene
# Node -- Claude Code y OpenCode se distribuyen así -- pero si no lo tiene, esto
# se lo dice en una frase en vez de fallar de forma críptica.

# 18 y no 20: es lo que trae Ubuntu 24.04 como `nodejs`, y el bundle corre
# bien con él. Poner el listón más alto de lo que hace falta dejaría fuera a
# quien instaló Node de la forma más normal que hay.
usable() {
    [ -n "$1" ] && [ -x "$1" ] \
        && "$1" -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' 2>/dev/null
}

NODE=""
for candidate in \
    "${ORCHID_NODE:-}" \
    "$(command -v node 2>/dev/null || true)" \
    /usr/bin/node \
    /usr/local/bin/node \
    /snap/bin/node
do
    if usable "$candidate"; then NODE="$candidate"; break; fi
done

# Los gestores de versiones no dejan nada en el PATH de un proceso que arranca
# un cliente MCP, y son justo lo que tiene instalado quien usa estas cosas. Solo
# si no apareció ninguno antes, y se queda con el último que pase la
# comprobación de versión -- que con los nombres que usan estos gestores es el
# más nuevo de los que sirven.
if [ -z "$NODE" ]; then
    for candidate in \
        "$HOME"/.nvm/versions/node/*/bin/node \
        "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node \
        "$HOME"/.volta/tools/image/node/*/bin/node
    do
        usable "$candidate" && NODE="$candidate"
    done
fi

if [ -z "$NODE" ]; then
    echo "$NAME: hace falta Node 18 o más nuevo y no lo encuentro." >&2
    echo >&2
    echo "  Debian/Ubuntu:  sudo apt install nodejs" >&2
    echo "  o cualquier gestor de versiones (nvm, fnm, volta)" >&2
    echo >&2
    echo "Si lo tienes en un sitio raro: ORCHID_NODE=/ruta/a/node $NAME" >&2
    exit 1
fi

exec "$NODE" "$FOUND" "$@"
