# OrchidLights — Roadmap

> Fecha: 2026-08-12. Base: `mcallegari/qlcplus` @ `18cf9da99` (master, 2026-08-10).
> Repo: https://github.com/AlexAlvarezAlmendros/OrchidLights

---

## 1. Decisiones tomadas

| Decisión | Elección |
|---|---|
| Superficie de UI | **Nueva UI web responsive** sobre el engine C++ (sustituye a `webaccess/`) |
| Relación con upstream | **Fork duro** — producto propio, sin compromiso de sincronización |
| Dolores de UX a resolver | Virtual Console en directo · Patch y fixtures · Editores de escena/chaser/EFX · Show Manager y preview |

---

## 2. Punto de partida verificado

**Lo que hereda el fork (se conserva intacto):**

| Módulo | Tamaño | Rol |
|---|---|---|
| `engine/` | 51.587 líneas, 147 archivos | `Doc`, `Fixture`, `Function`, `Universe`, `MasterTimer`. Solo depende de QtGui vía `QColor`/`QImage`/`QPainter` — **sin QtWidgets, headless viable** |
| `plugins/` | ~2,9 MB | ArtNet, E1.31/sACN, DMX USB, OSC, MIDI, HID, OS2L |
| `resources/` | 37 MB, **1.735 perfiles `.qxf`** | La librería de fixtures es el activo más valioso del proyecto |

**Lo que se congela y luego se elimina:**

- `ui/` — Qt Widgets, QLC+ v4.14.5 (7,5 MB)
- `qmlui/` — QML/Qt Quick, QLC+ v5.3.0-GIT (~60k líneas QML + ~60k C++)
- `webaccess/` — se sustituye por el nuevo módulo `server/`

**El API web que existe hoy (`webaccess/`, 8.954 líneas C++) y su límite real:**

Protocolo de texto por WebSocket, `QLC+API|comando|args`, con servidor HTTP propio (`qhttpserver` embebido, con `http_parser.c` incluido en el árbol) y HTML/JS generados como *string literals* dentro de cabeceras C++ (`commonjscss.h`).

Lo que **sí** cubre:
- Lectura: `isProjectLoaded`, `getFunctionsList/Type/Status`, `getWidgetsList/Type/Function/Status`, `getChannelsValues`, y `/vc.json` (layout de Virtual Console ya serializado en JSON)
- Escritura: `setFunctionStatus`, `sdResetChannel/Universe`, canales de Simple Desk, y comandos de widget (slider, botón, cuelist `PLAY/STOP/PREV/NEXT/STEP`, páginas de frame, RGB matrix)

Lo que **no** cubre — y que coincide punto por punto con los cuatro dolores señalados:
- ❌ CRUD de fixtures / patch (nada)
- ❌ Edición de escenas, chasers, EFX, matrices (solo arrancar/parar funciones ya creadas)
- ❌ Show Manager (nada)
- ❌ Preview 2D/3D (nada)
- ❌ Edición del layout de Virtual Console (solo control en runtime de un VC construido en el escritorio)

> **Conclusión que define el proyecto:** el `webaccess` actual es un *mando a distancia* de un show construido en la app de escritorio. Convertirlo en una aplicación completa **no es un trabajo de frontend**: exige escribir una capa de API C++ nueva y sustancial sobre `engine/`. El frontend bonito es la mitad visible del trabajo, no el trabajo.

**Toolchain (Ubuntu 24.04.4, verificado):**

| Pieza | Estado |
|---|---|
| Qt 5.15.13 runtime | instalado |
| `qt6-base-dev` 6.4.2 | disponible, **no instalado** |
| `qt6-httpserver-dev` 6.4.2 | disponible ← `QHttpServer` oficial desde 6.4 |
| `qt6-websockets-dev` 6.4.2 | disponible |
| qmake (cualquier versión) | **ausente** — hay que instalar toolchain de desarrollo |
| CMake 3.28.3 / Ninja 1.11.1 | instalados |
| Node 22.22.2 / pnpm 9.15.9 | instalados |

El build de upstream ya es CMake con soporte Qt5 **o** Qt6 (`find_package(QT NAMES Qt5 Qt6)`), así que el salto a Qt6 no parte de cero.

---

## 3. Arquitectura objetivo

```
<fork>/
  engine/          intacto — modelo y motor de tiempo real
  plugins/         intacto — salidas DMX
  resources/       intacto — librería de 1.735 fixtures
  server/          NUEVO — daemon headless + API
    main.cpp             QGuiApplication offscreen, sin ventana
    apiserver.*          QHttpServer (REST) + QWebSocketServer (realtime)
    protocol/            mensajes JSON tipados y versionados
    controllers/
      project.*          load/save/new, autosave, listado
      fixtures.*         patch CRUD, grupos, búsqueda en la librería
      functions.*        CRUD de escena/chaser/EFX/matrix/show + run/stop
      vc.*               layout de Virtual Console + runtime
      universes.*        patch de entrada/salida, stream DMX, simple desk
      preview.*          posiciones 2D y estado de color/dimmer
    auth.*               sesiones y roles (operador vs. diseñador)
  web/             NUEVO — SPA React 19 + Vite + TS
  ui/  qmlui/      congelados, eliminados en F1
```

**Por qué el API va en C++ y en proceso, no en Node:** el engine es un sistema de tiempo real — `MasterTimer` escribe DMX cada 1/50 s sobre un grafo de objetos C++ vivos. Un backend Node necesitaría igualmente un puente IPC contra ese proceso, duplicando trabajo y añadiendo latencia justo donde no se puede. El servidor va dentro del mismo proceso que el engine, que es además el patrón que `webaccess` ya usa.

**Protocolo:**
- **REST/JSON** para CRUD y todo lo que no sea tiempo real.
- **WebSocket** para estado de funciones, comandos de directo (latencia baja) y stream de valores DMX en **frames binarios**, con delta encoding, throttle configurable y suscripción por universo — no 512 canales × N universos × 50 Hz en JSON.

**Stack del frontend:** React 19 · Vite · TypeScript estricto · Biome · Vitest · pnpm. TanStack Query para REST, store ligero (Zustand) para el estado de tiempo real.

**Diseño responsive — tres modos de uso reales, no tres anchos de pantalla:**

| Ancho | Modo | Contenido |
|---|---|---|
| ≤ 640 px | **Operador** | Virtual Console a pantalla completa, botones grandes, sin edición posible |
| 641–1024 px | **Táctil** | Operador + patch + editores simples. Objetivos táctiles ≥ 44 px |
| ≥ 1025 px | **Diseño** | Todo: show manager, editores completos, preview |

Tema oscuro por defecto (se trabaja a oscuras) más un modo **blackout-safe** de rojo/ámbar a brillo mínimo, para no cegarse en cabina durante un pase.

---

## 4. Fases

### F0 — Fundación del fork ✅

- [x] Repo propio con la historia completa de upstream preservada; `upstream` se mantiene como remote para cherry-picks puntuales.
- [x] Rebranding en `variables.cmake`: `APPNAME`, `INSTALLROOT`, `DATADIR`, `USERDATADIR` (`~/.orchidlights`), `PLUGINDIR`. **El formato `.qxw` no se toca** — hay shows reales en producción que deben abrir en ambas aplicaciones.
- [x] `NOTICE` + README declarando la relación con QLC+ (obligación de Apache-2.0 §4: conservar avisos de copyright y declarar los cambios; y §6: no usar el nombre ni el logo de QLC+ como marca del derivado).
- [x] CMake: opción `-Dserver=ON` que poda `ui/`, `qmlui/`, `fixtureeditor/` y `webaccess/` del build.
- [x] Esqueleto de `server/`: `orchidlightsd` carga un `.qxw` sin interfaz y lista fixtures, universos y funciones.
- [x] CI: build Linux con Qt 6 + smoke test que instala y carga un proyecto real.
- [x] **Verificado en CI**: `orchidlightsd` compila, arranca sin interfaz, carga la librería (143 fabricantes) y abre `resources/samples/Sample.qxw` leyendo sus 13 fixtures, 114 funciones y 4 universos. Las rutas renombradas (`~/.orchidlights`, `/usr/share/orchidlights`) están activas.
- [x] Compilado en la máquina local: Qt 6.4.2 sobre Ubuntu 24.04, 659 targets, 3 min 30 s.
- [x] **Resolución de la librería de fixtures** (`server/src/fixturelibrary.*`), adelantada desde F1 porque sin ella nada de lo anterior sirve: búsqueda del directorio de sistema con `--fixtures` → `$ORCHID_FIXTURE_DIR` → ruta instalada → árbol de fuentes; lectura de perfiles de usuario **tanto de `~/.orchidlights` como de `~/.qlcplus`**; y aviso explícito con salida 2 cuando no hay librería.
- [x] **`17Julio.qxw` abre con sus 22 fixtures**, las direcciones DMX exactas del patch del P62, las 20 funciones, y **cero definiciones sin resolver**.
- [x] **Icono propio** (`resources/icons/svg/orchidlights.svg`, SVG instalado en `hicolor/scalable`), entrada `.desktop`, metadatos AppStream y **unidad systemd de usuario**. Validados con `desktop-file-validate`, `appstreamcli validate` y `systemd-analyze verify`.
- [x] **Limpieza de marca en la instalación.** El build de servidor instalaba los `.desktop` de QLC+ —que lanzan `qlcplus` y `qlcplus-fixtureeditor`, binarios que este build no produce—, más sus pixmaps, MIME, páginas de manual, 12 `metainfo` de plugins y las traducciones `.qm` de la UI de escritorio. Todo eso eran **lanzadores rotos y peso muerto**; ahora no se instala nada de ello.
- [x] **AppImage autocontenido** (46 MB) con la librería de 1.735 fixtures dentro. `create-appimage.sh` falla explícitamente si la librería no acaba en el bundle.
- [x] Dependencias centralizadas en `install-deps.sh`, que usan el README y los dos jobs de CI — no pueden desincronizarse.
- [x] CI: job de AppImage que construye, prueba el bundle con `HOME` limpio y lo publica como artefacto.

**Dependencias que el árbol de upstream no documenta** y sin las cuales no configura ni compila: `qt6-serialport-dev` (plugin dmxusb) y `libudev-dev` (hotplugmonitor).

**Lección aprendida.** El primer arranque contra `17Julio.qxw` cargó los 22 fixtures y pareció correcto: direcciones bien, canales bien. Pero la librería estaba vacía y las 22 definiciones habían fallado, así que todos eran dimmers genéricos sin nombres de canal ni capacidades. El motor sólo lo dejaba caer en `qDebug`, mezclado con cientos de líneas de ruido. De ahí que el daemon ahora **falle con código 2** ante cualquier definición sin resolver: en este dominio, un error silencioso significa mandar valores al canal equivocado de una luz real.

### F1 — Daemon headless + API core 🔨

**Motor en marcha** — hecho:

- [x] **Resolución de rutas unificada** en `server/src/installpaths.*`: fixtures, plugins de E/S, scripts RGB, plantillas de modificadores y perfiles de entrada. Todos sufrían el mismo fallo — `QLCFile::systemDirectory()` devuelve en Linux la ruta *tal cual*, relativa al directorio de trabajo del proceso. Ahora cada búsqueda termina en candidatos **anclados al ejecutable** y cada candidato se confirma con un marcador antes de aceptarse.
- [x] **`EngineHost`** (`server/src/enginehost.*`): cachés, plugins, universos y `MasterTimer`, en el orden que el motor exige, en un solo sitio legible.
- [x] **13 plugins de salida cargando** (ArtNet, DMX USB, E1.31, OSC, MIDI, HID, uDMX, Peperoni, SPI, OS2L, ENTTEC Wing, DMX4Linux, Loopback) — tanto instalado como **desde dentro del AppImage**, que es el caso que la ruta compilada no puede resolver porque apunta a la máquina que construyó el bundle.
- [x] Perfiles de entrada: se leen los del sistema, los nuestros y **los heredados de `~/.qlcplus/inputprofiles`**.
- [x] Bandera `--no-output` para arrancar el motor sin tocar la red, y `--check` para cargar, reportar y salir.

> **Bug corregido en el motor** (`engine/src/mastertimer-unix.cpp`). `MasterTimerPrivate::run()` levantaba su propia bandera `m_run` **dentro del hilo nuevo**, tras una guarda `if (m_run == true) return;`. Un `stop()` que llegase antes de que el hilo alcanzara su bucle ponía la bandera a `false`, el hilo pasaba la guarda, **se la volvía a poner a `true` él mismo** y giraba para siempre mientras `stop()` esperaba en un `wait()` que no volvía nunca. Es una ventana que se abre de par en par en cuanto algo carga un proyecto justo después de arrancar el motor — es decir, un daemon. La bandera se levanta ahora en el hilo que llama, y los arranques dobles los rechaza `isRunning()`. La variante Win32 no estaba afectada: su `start()` ya era síncrono.

**API HTTP** — hecho:

- [x] `QHttpServer` sobre Qt 6.4, JSON versionado en `/api/v1`, en el proceso del motor.
- [x] Endpoints de lectura: `status`, `fixtures`, `functions`, `universes`.
- [x] Control: `functions/{id}/start`, `functions/{id}/stop`, `blackout` (POST/DELETE).
- [x] Los comandos responden **202 Accepted sin estado**. El motor los encola y la transición cae en el siguiente tick (20 ms); devolver la función serializada daría el estado *anterior* al comando, y un `POST /start` contestando `running:false` se lee como un fallo.
- [x] Direcciones y universos **1-based** en el API, convertidos en un único sitio (`jsonview.cpp`).
- [x] `server/test/api-smoke.sh`: arranca el daemon, conduce el motor por HTTP y comprueba el binding a loopback. Corre igual en local que en CI.
- [x] Escucha **solo en loopback** por defecto. `--listen-all` es deliberado porque todavía no hay autenticación.

- [x] **Autenticación por token** (`server/src/apiauth.*`): 32 bytes del CSPRNG del sistema, generados en el primer arranque, guardados con permisos `600`, comparados en tiempo constante. `--listen-all` la activa sola; `--require-auth` la exige también en loopback. Cubierta por el smoke test, lecturas **y** comandos.

**Feed en vivo (WebSocket)** — hecho:

- [x] `/ws` en el **mismo puerto** que el API: `QAbstractHttpServer` entrega los sockets que piden upgrade, así que el navegador necesita un solo origen y un solo puerto abierto.
- [x] Estado en JSON (`hello`, `authenticated`, `functions`, `subscribed`, `error`) y **DMX en frames binarios**: 2 bytes de universo 1-based little endian + valores de canal.
- [x] Suscripción por universo, y frames **agrupados y emitidos a 25 Hz** en vez de a los 50 del motor — el ritmo de red se desacopla del show y un cliente lento no puede frenar la mesa. Medido: 75 frames en 3 s con un chaser corriendo.
- [x] Token en el **primer mensaje**, no en la URL: un navegador no puede poner cabeceras `Authorization` en un WebSocket, y un token en la query acaba en logs de proxy e historial.
- [x] `server/test/ws-smoke.sh` + `ws-client.mjs` (WebSocket nativo de Node 22, sin dependencias): feed abierto, token incorrecto y token correcto.

> **Trampa de Qt que costó encontrar.** `qabstracthttpserver.cpp:88` condiciona el upgrade a `handleRequest(...) && isSignalConnected(...)`. Sin una ruta para `/ws`, `handleRequest` devuelve `false` y Qt rechaza la conexión con *"WebSocket received but no slots connected"* — un mensaje que culpa a la señal, que estaba perfectamente conectada. Y al añadir una ruta normal, el handler **escribe su respuesta** antes de que Qt entregue el socket, así que el cliente lee el HTTP y abandona. La salida es la forma de `route()` con `QHttpServerResponder&&` y retorno `void`: ahí `responseImpl()` no llama a `sendResponse()`, y un handler que no escribe nada deja el socket limpio para el handshake.

**Proyectos** — hecho:

- [x] Endpoints `GET /project`, `GET /projects`, `POST /project/load/{nombre}`, `POST /project/save[/{nombre}]`.
- [x] Toman **nombre de archivo, nunca ruta**, y solo dentro del directorio de `--projects`. Aceptar rutas sería regalar una primitiva de escritura arbitraria a quien tenga el token.
- [x] **Guardado que preserva verbatim** Virtual Console, Simple Desk y cualquier sección futura que no modelemos, con `QSaveFile` para no dejar un archivo de show a medio escribir.
- [x] `server/test/roundtrip-smoke.sh` en CI, comparando los subárboles canonicalizados antes y después.
- [x] Decodificadores de audio cargados y reportados en `/status` como `audioFormats`.

> **Dos bugs que este test cazó y que habrían destruido shows en silencio.**
> El primero: al reemitir las secciones con `writeCurrentToken()`, Qt las reescribía ligadas explícitamente al namespace por defecto (`<ns0:VirtualConsole xmlns:ns0="...">`), inflando el archivo un 20 %. Se copian los tokens a mano con nombres locales.
> El segundo, más grave: con el procesamiento de namespaces activado, **`xmlns` no aparece en `attributes()`** — Qt lo consume en `namespaceDeclarations()`. Al leer solo los atributos se perdía la declaración, todos los hijos salían del namespace por defecto, y las secciones "preservadas" volvían distintas de como entraron **mientras el archivo seguía abriendo perfectamente**. `Sample.qxw` no lo detectaba porque no declara `xmlns`; `17Julio.qxw` sí.

**Pendiente:**
- [ ] **Audio.** No hay backend multimedia todavía y el AppImage no empaqueta ninguno a propósito. Las funciones de audio cargan pero no suenan.
- [ ] Round-trip de `.qxw`: cargar y guardar no debe alterar las secciones que el motor no gestiona (Virtual Console, Simple Desk). Test en CI con proyectos reales.
- [ ] **Entrada del menú.** El `.desktop` abre una terminal porque hoy no hay nada que mostrar; en F2 pasa a abrir el navegador.
- [ ] **Criterio de éxito: disparar el show del P62 Club desde `curl`/`wscat`, con luz real en la sala, sin abrir ninguna GUI.**

### F2 — Shell web + Virtual Console en directo *(dolor #1)* 🔨

**Hecho:**

- [x] SPA React 19 + Vite + TS estricto + Biome + Vitest, servida por el daemon desde su mismo origen y puerto.
- [x] `server/src/virtualconsole.*`: el VC se parsea del **mismo XML que ya preservamos**, en solo lectura, y se expone en `GET /api/v1/vc` con geometría, colores y referencias a función.
- [x] **Reflow responsive real.** La geometría se lee como intención, no como coordenadas. Contra la consola del P62 (31 widgets) recupera las bandas del diseñador y las presenta a 2 columnas en móvil y 8 en escritorio.
- [x] Comandos por **WebSocket, no REST** — presupuesto de 50 ms de tap a DMX; el estado vuelve por el mismo canal, sin polling.
- [x] Dos temas oscuros, incluido **blackout-safe** (rojo/ámbar a baja luminancia), recordado entre recargas.
- [x] Objetivos táctiles ≥ 44 px. Widgets sin control propio en gris punteado y etiquetados.
- [x] CI: lint, typecheck, tests y build de la web antes de CMake; y comprobación de que **el AppImage lleva la interfaz dentro** — sin eso el único artefacto que alguien se descarga arrancaba sin UI.

> **La regla que costó un test.** Las filas se agrupan por **alineación del borde superior, no por solapamiento**. El solapamiento es la opción obvia y colapsa el layout: un fader de 400 px cruza todas las bandas de botones que tiene al lado y se las traga a una sola fila. El test lo afirma explícitamente porque es el bug que alguien reintroducirá.

**Pendiente:**

- [ ] Control de faders, cue lists, XY pads y speed dial.
- [ ] Editor de layout drag & drop **sobre grid**, guardado en una sección propia del `.qxw` para no tocar el `<VirtualConsole>` de QLC+.
- [ ] Medir de verdad el presupuesto de **≤ 50 ms de tap a DMX**.
- [ ] Modo operador en móvil sin edición posible, y PWA instalable.

### F3 — Patch y gestión de fixtures *(dolor #2)*
- Buscador de la librería de 1.735 perfiles con filtros por fabricante, tipo y número de canales.
- Patch visual: mapa de 512 canales por universo, direccionamiento por arrastre, **detección de solapes**.
- Grupos, modos, offsets. Importación y exportación de patch.
- **Criterio de éxito: rehacer el patch del P62 (22 fixtures, 6 modelos, 3 perfiles custom) más rápido que en la app actual.**

### F4 — Editores de funciones *(dolor #3)*
- Escena: consola de canales por fixture, con paletas de color y presets.
- Chaser: lista de pasos con timing editable en línea, copiar/pegar entre pasos.
- EFX: editor de patrón con previsualización.
- RGB Matrix: algoritmos con preview.

### F5 — Show Manager y preview 2D *(dolor #4)*
- Timeline multipista.
- Preview 2D: planta del rig con color y dimmer en vivo, sobre imagen de fondo (el plànol d'il·luminació del P62 encaja aquí directamente).

### F6 — Extras
- 3D opcional con three.js, solo si aporta algo sobre el 2D.
- PWA instalable y offline en tablet.
- Multiusuario con roles.

---

## 5. Riesgos

| # | Riesgo | Mitigación |
|---|---|---|
| 1 | **Superficie de API enorme.** El engine expone ~50k líneas de modelo; exponerlo entero es interminable | No exponer todo. Cortar por casos de uso reales y empezar por el rig del P62 |
| 2 | **Divergencia con upstream.** Fork duro = no llegan perfiles ni fixes nuevos | Mantener `upstream` como remote y cherry-pickear solo `resources/fixtures/` y `plugins/`, que están poco acoplados a nuestro código |
| 3 | **Compatibilidad de proyectos.** Hay shows en producción | No tocar el formato `.qxw`. Test de round-trip en CI con proyectos reales |
| 4 | **Tiempo real en el navegador.** 512 canales × N universos × 50 Hz | Frames binarios, delta encoding, throttle configurable, suscripción por universo |
| 5 | **Fiabilidad en directo.** Un navegador no es una mesa de luces | El daemon sigue emitiendo aunque el navegador muera. Watchdog. Blackout de pánico por MIDI/OSC, independiente de la capa web |

---

## 6. Decidido

- **Nombre**: OrchidLights. Binario del daemon: `orchidlightsd`.
- **Repo**: standalone y público, con la historia completa de upstream importada — issues y estrellas propias, sin banner de *forked from*, y la historia de git preservada cubre de sobra la atribución que pide Apache-2.0.

## 7. Siguiente paso

Instalar el toolchain de Qt 6 y compilar por primera vez:

```bash
sudo apt install build-essential cmake ninja-build pkg-config \
                 qt6-base-dev qt6-httpserver-dev qt6-websockets-dev \
                 qt6-declarative-dev qt6-multimedia-dev qt6-tools-dev qt6-serialport-dev \
                 libasound2-dev libusb-1.0-0-dev libftdi1-dev libudev-dev libmad0-dev \
                 libsndfile1-dev libfftw3-dev

cmake -S . -B build -G Ninja -Dserver=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build
QT_QPA_PLATFORM=offscreen ./build/server/src/orchidlightsd ~/Documentos/QLC+/17Julio.qxw
```

Ese último comando, listando los 22 fixtures del P62 sin abrir ventana, cierra F0.
