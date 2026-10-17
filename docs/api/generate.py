#!/usr/bin/env python3
"""Genera docs/api/openapi.json a partir de openapi.yaml.

La fuente es el YAML, porque lleva comentarios y se edita a mano. Lo que sirve
el daemon es el JSON: en C++ no hay parser de YAML, y JSON es lo que quiere un
cliente de todas formas. Las dos versiones van en el repositorio y
`server/test/openapi-smoke.sh` comprueba en CI que no se han separado.

    python3 docs/api/generate.py
"""

import json
import pathlib
import sys

try:
    import yaml
except ImportError:
    sys.exit("hace falta PyYAML: sudo apt install python3-yaml")

HERE = pathlib.Path(__file__).parent


def render() -> str:
    spec = yaml.safe_load((HERE / "openapi.yaml").read_text())
    # ensure_ascii=False porque el contrato está escrito en español y á
    # por todas partes lo hace ilegible en una revisión.
    return json.dumps(spec, indent=1, ensure_ascii=False) + "\n"


if __name__ == "__main__":
    (HERE / "openapi.json").write_text(render())
    print(f"escrito {HERE / 'openapi.json'}")
