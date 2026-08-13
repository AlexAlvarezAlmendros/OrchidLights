<h1 align="center">OrchidLights</h1>

<p align="center">
  <strong>Control de iluminación DMX desde el navegador.</strong><br/>
  Motor C++ headless, interfaz web responsive. Fork de QLC+.
</p>

---

## Qué es

OrchidLights toma el motor de iluminación de [QLC+](https://github.com/mcallegari/qlcplus)
— maduro, probado en producción, con soporte para Art-Net, sACN/E1.31, DMX USB,
OSC, MIDI y HID, y una librería de más de 1.700 perfiles de fixtures — y le pone
delante una interfaz completamente nueva: una aplicación web que funciona igual
de bien en el portátil de la cabina, en la tablet del escenario y en el móvil
que llevas en el bolsillo durante el pase.

No es un mando a distancia de una aplicación de escritorio. **Es la aplicación.**

## Estado

**En desarrollo temprano.** Hoy existe el daemon: carga proyectos de QLC+ sin
interfaz y reporta su contenido. Todavía no controla luces ni sirve nada por
HTTP — eso llega en F1. Consulta el [roadmap](docs/planning/ROADMAP.md) para el
plan por fases.

| Fase | Contenido | Estado |
|---|---|---|
| F0 | Fundación del fork: rebranding, poda del build, empaquetado, CI | ✅ |
| F1 | Daemon headless + API REST/WebSocket | ⬜ |
| F2 | Interfaz web + Virtual Console en directo | ⬜ |
| F3 | Patch y gestión de fixtures | ⬜ |
| F4 | Editores de escenas, chasers, EFX y matrices | ⬜ |
| F5 | Show Manager y previsualización 2D | ⬜ |
| F6 | 3D, PWA, multiusuario | ⬜ |

## Arquitectura

```
engine/     motor de tiempo real heredado de QLC+ (intacto)
plugins/    salidas DMX heredadas de QLC+ (intacto)
resources/  librería de fixtures heredada de QLC+ (intacto)
server/     NUEVO — daemon headless: QHttpServer (REST) + QWebSocketServer
web/        NUEVO — SPA React 19 + Vite + TypeScript
ui/ qmlui/  interfaces de escritorio heredadas, congeladas y a eliminar
```

El API vive **en el mismo proceso que el motor**. El `MasterTimer` de QLC+
escribe DMX cada 1/50 s sobre un grafo de objetos C++ vivos; un backend en otro
proceso necesitaría un puente IPC contra él, añadiendo latencia justo donde no
se puede permitir.

La comunicación se reparte: **REST/JSON** para todo lo que es CRUD y no urge, y
**WebSocket** para el estado en vivo, los comandos de directo y el stream de
valores DMX, este último en frames binarios con delta encoding y suscripción por
universo — no 512 canales por N universos a 50 Hz en JSON.

## Compilar

Requiere **Qt 6.4 o superior** (`QHttpServer` es módulo oficial desde 6.4).

```bash
# Dependencias (Ubuntu / Debian)
./install-deps.sh

# Configurar y compilar solo el motor + los plugins + el daemon
cmake -S . -B build -G Ninja -Dserver=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build

# Arrancar sin instalar nada
cmake --build build --target run
```

Para generar un AppImage autocontenido (unos 46 MB, con la librería de fixtures
dentro):

```bash
./install-deps.sh --appimage
./create-appimage.sh
```

La opción `-Dserver=ON` excluye del build las dos interfaces de escritorio
heredadas y el `webaccess` antiguo. Sin ella, el árbol sigue compilando QLC+ tal
cual venía de upstream, lo que resulta útil para comparar comportamientos.

## La librería de fixtures

El daemon busca la librería del sistema en este orden: la opción `--fixtures`,
la variable `ORCHID_FIXTURE_DIR`, la ruta instalada, y por último el árbol de
fuentes relativo al binario — de modo que ejecutar desde `build/` funciona sin
instalar nada.

Los perfiles de usuario se leen **tanto de `~/.orchidlights/fixtures` como de
`~/.qlcplus/fixtures`**. Se leen los dos, no uno como respaldo del otro: la
propia QLC+ crea su directorio en el primer arranque, así que un respaldo
condicionado a que falte no llegaría a dispararse nunca. Los perfiles `.qxf`
propios suelen ser la única definición del hardware que hay realmente en el rig,
y perderlos convierte cada fixture parcheado en un dimmer genérico.

Si no aparece ninguna librería, el daemon **avisa y sale con código 2** en lugar
de cargar el proyecto en silencio con las definiciones vacías.

## Ejecutar como servicio

Una mesa de luces tiene que sobrevivir a que el operador cierre el portátil, así
que el daemon se instala con su unidad de systemd de usuario:

```bash
systemctl --user enable --now orchidlights

# Para que siga vivo sin sesión iniciada:
sudo loginctl enable-linger $USER
```

La entrada del menú de aplicaciones existe pero abre una terminal: hoy el daemon
no tiene interfaz que mostrar. Pasará a abrir el navegador cuando llegue F2.

## Compatibilidad de proyectos

**El formato de archivo `.qxw` no se toca.** Un show creado en QLC+ abre en
OrchidLights y viceversa. Esto no es negociable: hay shows en producción de por
medio.

## Licencia y origen

Apache License 2.0, heredada de QLC+. Consulta [`NOTICE`](NOTICE) para la
atribución completa y la declaración de cambios.

OrchidLights **no está afiliado ni respaldado por el proyecto QLC+**. Si
encuentras un fallo aquí, repórtalo aquí — no en el repositorio de upstream.

Todo el mérito del motor, los plugins y la librería de fixtures es de Massimo
Callegari, Heikki Junnila y los colaboradores de QLC+.
