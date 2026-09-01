#!/bin/sh
#
# El bit de ejecución de los dos lanzadores, asegurado.
#
# El empaquetador copia lo que dice `files` y no promete conservar permisos;
# un /usr/bin/orchidlights-mcp sin +x es un comando que existe, aparece en el
# PATH y no arranca -- el peor de los tres estados posibles.
set -e
chmod 755 /usr/bin/orchidlights-mcp /usr/bin/orchidctl 2>/dev/null || true
