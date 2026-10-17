#!/usr/bin/env python3
"""Comprueba el contrato OpenAPI contra el código que dice describir.

Una spec escrita a mano se separa del código en semanas, y una que miente es
peor que no tener ninguna: el cliente que la lee se la cree. Esto comprueba las
cuatro formas en que puede separarse, sin necesidad de un daemon corriendo:

  1. El JSON generado sigue al YAML del que sale.
  2. Cada ruta documentada existe, y cada ruta que existe está documentada.
  3. La spec es utilizable: summary, tag, responses y todo $ref resuelve.
  4. Los nombres de campo de cada cuerpo son los que el handler lee de verdad.

    python3 server/test/openapi-contract.py [raiz-del-repo]
"""

import importlib.util
import json
import pathlib
import re
import sys

METHODS = ("get", "post", "put", "patch", "delete")

ROUTE = re.compile(
    r'm_server->route\(\s*"([^"]+)"\s*,\s*(?:QHttpServerRequest::Method::(\w+)\s*,)?'
)


def canon(path):
    """Un parámetro de ruta es un parámetro de ruta, se llame como se llame."""
    return re.sub(r"\{[^}]+\}|<arg>", "*", path)


def handlers(source):
    """Un trozo de fuente por handler: de una registración de ruta a la siguiente."""
    starts = list(ROUTE.finditer(source))
    out = {}
    for index, match in enumerate(starts):
        end = starts[index + 1].start() if index + 1 < len(starts) else len(source)
        # Una ruta registrada sin método contesta a todos los verbos; se
        # documenta como GET, que es lo único que hace ninguna de ellas.
        key = (canon(match.group(1)), (match.group(2) or "GET").upper())
        out[key] = source[match.end() : end]
    return out


def operations(spec):
    for path, verbs in spec["paths"].items():
        for method, operation in verbs.items():
            if method in METHODS:
                yield path, method, operation


def check_generated(root, report):
    spec = importlib.util.spec_from_file_location("gen", root / "docs/api/generate.py")
    generator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(generator)

    if generator.render() != (root / "docs/api/openapi.json").read_text():
        report("docs/api/openapi.json no sigue al YAML; corre python3 docs/api/generate.py")
        return
    print("openapi.json al día con el YAML")


def check_routes(spec, source, report):
    documented = {(canon(path), method.upper()) for path, method, _ in operations(spec)}
    implemented = {
        (canon(match.group(1)), (match.group(2) or "GET").upper())
        for match in ROUTE.finditer(source)
        if match.group(1).startswith("/api/v1")
    }

    for path, method in sorted(implemented - documented):
        report(f"SIN DOCUMENTAR: {method} {path}")
    for path, method in sorted(documented - implemented):
        report(f"DOCUMENTADA PERO NO EXISTE: {method} {path}")

    if implemented == documented:
        print(f"{len(implemented)} operaciones, todas documentadas y todas existentes")


def check_usable(spec, report):
    for path, method, operation in operations(spec):
        where = f"{method.upper()} {path}"
        if not operation.get("summary"):
            report(f"{where}: sin summary")
        if not operation.get("responses"):
            report(f"{where}: sin responses")
        if not operation.get("tags"):
            report(f"{where}: sin tag")

    declared = {tag["name"] for tag in spec.get("tags", [])}
    used = {tag for _, _, operation in operations(spec) for tag in operation.get("tags", [])}
    for tag in sorted(used - declared):
        report(f"tag sin declarar: {tag}")

    # Un $ref roto deja al cliente sin el esquema y sin enterarse.
    def refs(node):
        if isinstance(node, dict):
            for key, value in node.items():
                if key == "$ref" and isinstance(value, str):
                    yield value
                else:
                    yield from refs(value)
        elif isinstance(node, list):
            for value in node:
                yield from refs(value)

    for ref in sorted(set(refs(spec))):
        if not ref.startswith("#/"):
            report(f"$ref externo: {ref}")
            continue
        node = spec
        for step in ref[2:].split("/"):
            if not isinstance(node, dict) or step not in node:
                report(f"$ref roto: {ref}")
                break
            node = node[step]

    # Una clave con un espacio dentro es prosa que la coma de un mapping en
    # línea convirtió en clave. Nada legítimo aquí se llama así.
    def junk(node, where):
        if isinstance(node, dict):
            for key, value in node.items():
                if isinstance(key, str) and (" " in key or key.endswith(".")):
                    report(f"clave basura en {where}: {key!r}")
                junk(value, f"{where}.{key}")
        elif isinstance(node, list):
            for index, value in enumerate(node):
                junk(value, f"{where}[{index}]")

    junk(spec, "")
    print("summary, tag y responses en todas las operaciones, y todo $ref resuelve")


def check_fields(spec, root, source, report):
    """Los nombres de campo documentados contra los que el handler lee.

    Comparar rutas y verbos no basta: una spec puede acertar la ruta entera y
    mentir en el cuerpo, y ese es el fallo peor, porque el cliente manda un
    JSON bien formado que el daemon acepta e ignora. Escribiendo esta spec pasó
    tres veces -- "universe" donde iba "fixture", "backgroundColor" donde iba
    "background", un "scene" que no existía -- y ninguna dio error en ninguna
    parte.
    """
    slices = handlers(source)

    # Varios handlers no parsean su propio cuerpo: se lo pasan entero a
    # DocWriter, VcPatch o ConsoleLayout. Seguir la delegación es más honesto
    # que llevar una lista de excepciones, que es una lista que crece y que
    # nadie vuelve a mirar.
    modules = {path.stem: path.read_text() for path in (root / "server/src").glob("*.cpp")}

    def corpus(text):
        whole = [text]
        for namespace in set(re.findall(r"\b([A-Z][A-Za-z]+)::", text)):
            body = modules.get(namespace.lower())
            if body is not None:
                whole.append(body)
        return "\n".join(whole)

    checked = 0
    for path, method, operation in operations(spec):
        schema = (
            operation.get("requestBody", {})
            .get("content", {})
            .get("application/json", {})
            .get("schema", {})
        )
        properties = schema.get("properties") or {}
        text = slices.get((canon(path), method.upper()))
        if text is None or not properties:
            continue

        searchable = corpus(text)
        for name in properties:
            checked += 1
            if f'"{name}"' not in searchable:
                report(
                    f'CAMPO INVENTADO: {method.upper()} {path} documenta "{name}", '
                    "que el handler no lee"
                )

    print(f"{checked} campos de petición documentados, todos leídos por su handler")


def main():
    root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    spec = json.loads((root / "docs/api/openapi.json").read_text())
    source = (root / "server/src/apiserver.cpp").read_text()

    problems = []

    def report(message):
        problems.append(message)

    check_generated(root, report)
    check_routes(spec, source, report)
    check_usable(spec, report)
    check_fields(spec, root, source, report)

    for problem in problems:
        print(problem, file=sys.stderr)

    if problems:
        print(
            "\nEl contrato y apiserver.cpp se han separado. Edita "
            "docs/api/openapi.yaml y corre python3 docs/api/generate.py.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
