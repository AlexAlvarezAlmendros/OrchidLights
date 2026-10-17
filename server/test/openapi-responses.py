#!/usr/bin/env python3
"""Las respuestas de un daemon de verdad contra los tipos que promete el contrato.

Comprobar rutas coge una ruta inventada. Comprobar nombres de campo coge un
cuerpo mal escrito. Ninguna de las dos coge que `GET /history` documente
`undo` como un entero cuando lo que devuelve es un booleano -- y ese fallo es
caro, porque un cliente escribe `history.undo - antes` y le sale un número que
parece razonable y no significa nada. Pasó escribiendo este contrato.

Así que aquí se llama al daemon y se compara lo que contesta con lo que la
spec dice que contesta. No es un validador de JSON Schema entero: comprueba
tipos, y solo de las claves que de verdad vienen, porque casi todas son
condicionales y exigir presencia daría ruido en vez de fallos.

    ORCHID_TOKEN=$(cat ~/.orchidlights/api-token) \\
        python3 server/test/openapi-responses.py http://127.0.0.1:9998 [raiz-del-repo]
"""

import json
import os
import pathlib
import sys
import urllib.error
import urllib.request

# Rutas con parámetros que sí merece la pena probar, con valores que existen en
# el proyecto de muestra. El resto de las que llevan {} se dejan: inventarles un
# id daría un 404 y un 404 no valida nada.
PARAMETERISED = {
    "/api/v1/universes/{index}/map": "/api/v1/universes/1/map",
    "/api/v1/universes/{index}/dmx": "/api/v1/universes/1/dmx",
    "/api/v1/fixtures/{id}": "/api/v1/fixtures/0",
    "/api/v1/functions/{id}/body": "/api/v1/functions/0/body",
    "/api/v1/functions/{id}/usage": "/api/v1/functions/0/usage",
    "/api/v1/simpledesk/{universe}": "/api/v1/simpledesk/1",
    "/api/v1/library/{manufacturer}": "/api/v1/library/Generic",
    "/api/v1/library/{manufacturer}/{model}": "/api/v1/library/Martin/MAC%20Aura",
}

# El contrato entero mide 170 KB y validarlo contra su propio esquema no dice
# nada de nadie.
SKIP = {"/api/v1/openapi.json"}


def resolve(spec, node):
    while isinstance(node, dict) and "$ref" in node:
        target = spec
        for step in node["$ref"][2:].split("/"):
            target = target[step]
        node = target
    return node


def matches(value, kind):
    if kind == "object":
        return isinstance(value, dict)
    if kind == "array":
        return isinstance(value, list)
    if kind == "string":
        return isinstance(value, str)
    if kind == "boolean":
        return isinstance(value, bool)
    if kind == "integer":
        # En JSON un booleano es un int para Python, y no lo es para nadie más.
        return isinstance(value, int) and not isinstance(value, bool)
    if kind == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if kind == "null":
        return value is None
    return True


def check(spec, schema, value, where, problems, depth=0):
    schema = resolve(spec, schema)
    if not isinstance(schema, dict) or depth > 6:
        return

    kinds = schema.get("type")
    if kinds is not None:
        kinds = kinds if isinstance(kinds, list) else [kinds]
        if not any(matches(value, kind) for kind in kinds):
            got = "null" if value is None else type(value).__name__
            problems.append(f"{where}: el contrato dice {'/'.join(kinds)} y llegó {got}")
            return

    # Un enum mal escrito no se ve en el tipo: los once tipos de widget salen en
    # minúscula del daemon y el contrato los documentaba capitalizados, con dos
    # nombres además que no existen. Todo eso es texto y todo pasa como texto.
    allowed = schema.get("enum")
    if allowed is not None and value not in allowed:
        problems.append(f"{where}: {value!r} no está en el enum del contrato ({allowed})")
        return

    if isinstance(value, dict):
        for name, subschema in (schema.get("properties") or {}).items():
            if name in value and value[name] is not None:
                check(spec, subschema, value[name], f"{where}.{name}", problems, depth + 1)

    elif isinstance(value, list):
        items = schema.get("items")
        if items is not None:
            # Con los tres primeros basta: si el cuarto tiene otra forma, es que
            # la lista no es homogénea y eso saldría en los tres primeros de
            # cualquier otro proyecto.
            for index, entry in enumerate(value[:3]):
                check(spec, items, entry, f"{where}[{index}]", problems, depth + 1)


def probe(base, path, token):
    request = urllib.request.Request(f"{base}{path}", method="GET")
    # Las rutas que llegan al disco exigen el token aunque la mesa escuche solo
    # en loopback, así que sin él quedarían fuera de la comprobación -- y son
    # justo las que más caro sale documentar mal.
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            body = response.read()
            kind = response.headers.get("Content-Type", "")
            return response.status, kind, body
    except urllib.error.HTTPError as error:
        return error.code, error.headers.get("Content-Type", ""), error.read()


def main():
    base = sys.argv[1].rstrip("/")
    root = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else ".").resolve()
    spec = json.loads((root / "docs/api/openapi.json").read_text())
    token = os.environ.get("ORCHID_TOKEN", "")

    problems = []
    checked = 0

    for path, operations in spec["paths"].items():
        operation = operations.get("get")
        if operation is None or path in SKIP:
            continue

        target = PARAMETERISED.get(path) if "{" in path else path
        if target is None:
            continue

        schema = (
            operation.get("responses", {})
            .get("200", {})
            .get("content", {})
            .get("application/json", {})
            .get("schema")
        )
        if schema is None:
            continue  # binario: una imagen de fondo, un mesh, un audio

        status, kind, body = probe(base, target, token)
        if status == 404:
            continue  # el proyecto de muestra no tiene esa cosa, y eso no es un fallo
        if status != 200:
            problems.append(f"GET {target}: contestó {status}")
            continue
        if "application/json" not in kind:
            problems.append(f"GET {target}: el contrato promete JSON y llegó {kind!r}")
            continue

        try:
            value = json.loads(body)
        except json.JSONDecodeError as error:
            problems.append(f"GET {target}: no es JSON ({error})")
            continue

        checked += 1
        check(spec, schema, value, f"GET {target}", problems)

    for problem in problems:
        print(f"RESPUESTA: {problem}", file=sys.stderr)

    if problems:
        print(
            "\nEl contrato promete una forma y el daemon devuelve otra. "
            "Edita docs/api/openapi.yaml y corre python3 docs/api/generate.py.",
            file=sys.stderr,
        )
        return 1

    print(f"{checked} respuestas comprobadas contra su esquema, todas con la forma prometida")
    return 0


if __name__ == "__main__":
    sys.exit(main())
