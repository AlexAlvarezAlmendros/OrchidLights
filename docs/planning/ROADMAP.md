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
- [x] Round-trip de `.qxw`: cargar y guardar no altera las secciones que el motor no gestiona (Virtual Console, Simple Desk). `roundtrip-smoke.sh` y `xmltree-roundtrip.sh` en CI, contra los seis proyectos de la máquina.
- [x] **Entrada del menú.** El `.desktop` ya no abre una terminal: `orchidlightsd --open` levanta el motor y abre la interfaz en el navegador. Encolado tras el bucle de eventos, porque abrirlo antes de que `listen()` acepte enseña un error de conexión en un daemon que arrancó perfectamente.
- [x] **Criterio de éxito cumplido: el show del P62 se dispara desde `curl`/`wscat` con luz real, sin GUI.** Verificado por Art-Net: 512 bytes, 76 canales activos con el espaciado de 8 canales de los Theatre Spots.

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

- [x] **Faders funcionando.** `server/src/levelsource.cpp` se registra como `DMXSource` en el `MasterTimer`, que es la única vía sancionada para escribir en un universo fuera de una Function: `writeDMX()` corre en el hilo del timer con los universos ya reclamados. Mover un fader desde HTTP o WebSocket **no toca un universo**: aparca el valor bajo mutex y el siguiente tick (≤20 ms) lo aplica.
- [x] Verificado contra el rig real: el fader *Washes* del P62 escribe 200 en los canales DMX **158, 184, 210, 236** — el canal 6 (dimmer) de los cuatro Hero Wash 300FC en 153/179/205/231, y en ningún otro sitio.
- [x] Faders horizontales en móvil (más fáciles con una mano) y verticales en escritorio, como en una mesa. Valores sembrados desde el proyecto, y sincronizados entre clientes por WebSocket.
- [x] Un slider sale operable solo cuando hay algo detrás: canales para uno de nivel, una función para uno de playback, algo que escalar para un submaster. Mostrarlo operativo si no lo hay sería una mentira que el operador descubre cuando la luz no se mueve.

**Pendiente:**

- [x] **Speed dial funcionando.** Verificado sobre el rig: mover el dial de 430 ms a 3000 y a 500 cambia la duración de los tres chases y los dos EFX de movimiento del P62. Las velocidades (`fadeIn`/`fadeOut`/`duration`) se exponen ahora en `/api/v1/functions`, para que el efecto sea **observable** y no solo confirmado por un acuse.
  Los flags del XML son índices en la tabla de multiplicadores de QLC+, donde `0 = None` significa "no toques esa velocidad" — por eso un dial que parece controlar un fade a menudo solo controla la duración.
- [x] Cue lists y XY pads (ver F6).
- [x] Sliders de playback (ver F6).
- [x] Sliders de submaster (ver F6).

> **Con esto, la consola del P62 no tiene ningún widget muerto**: 20 botones, 5 faders, el speed dial y las etiquetas, todos operativos desde el navegador.
- [x] **Editor de orden sobre rejilla**, guardado en `<OrchidLightsLayout>`, una sección propia del `.qxw`. Verificado contra **QLC+ 5.2.1**: avisa `Unknown Workspace tag` y carga el proyecto con normalidad. Asimetría documentada: QLC+ no conserva secciones desconocidas, así que guardar desde QLC+ pierde el orden (y solo el orden).
- [x] `web/src/arrange.ts` con 11 tests: un layout **nunca pierde un widget** ni oculta uno que no menciona — un botón añadido en QLC+ después de guardar el orden sigue apareciendo, porque esconderlo sería el peor fallo posible.
- [x] En modo ordenar **ningún widget dispara su función**: mover un botón no debe además pulsarlo. Interacción por `pointerup`, no arrastre HTML5, que no existe en táctil.
- [x] **Presupuesto de latencia medido**, no declarado. `server/test/latency.mjs`, 40 muestras sobre el rig del P62: mediana **40 ms** con el flush por defecto de 25 Hz, **20 ms** a 50 Hz, y **20 ms** también a 100 Hz. El suelo de 20 ms es el tick del motor y no baja de ahí.
  La medición corrigió el marco: lo que se cronometraba no era *tap a DMX* sino *tap a que el navegador se entera*. **La luz se mueve en ~20 ms**; los 20 ms extra del ajuste por defecto solo retrasan el eco visual, que la interfaz ya adelanta de forma optimista. Subir `--stream-rate` gasta ancho de banda sin acelerar ningún foco.
- [ ] Modo operador en móvil sin edición posible, y PWA instalable.

### Reencuadre (2026-08-13)

Hasta aquí el plan se ordenaba por los dolores de un rig concreto. **Eso era un
sesgo**: un proyecto real sirve como banco de pruebas, no como especificación.
Priorizar por "esto aquel proyecto no lo usa" deja fuera justo lo que otro
proyecto necesitará.

El objetivo es **paridad funcional con QLC+ desde el navegador**: controlar,
crear, editar y eliminar cualquier cosa, en cualquier proyecto. La medida de
avance es la cobertura de la superficie de QLC+, no la de un show.

**La superficie real, sacada del código:**

| Superficie | Elementos | Estado hoy |
|---|---|---|
| Widgets de Virtual Console | 12: `button` `slider` `label` `frame` `soloframe` `cuelist` `speeddial` `xypad` `clock` `audiotriggers` `animation` `page` | 5 en solo lectura |
| Tipos de función | 10: `Scene` `Chaser` `EFX` `Collection` `Script` `RGBMatrix` `Show` `Sequence` `Audio` `Video` | listar, arrancar/parar, velocidades |
| Fixtures | alta, baja, sustitución, grupos, grupos de canales, modos, direcciones, modificadores de canal | solo lectura |
| Universos y E/S | alta, baja, nombre, passthrough, monitor, patch de entrada y salida, perfiles | solo lectura |

**Lo que falta no es una lista de features, es una capa**: hoy no existe
escritura sobre el documento. Todo lo anterior lee `Doc` y ejecuta funciones;
nada lo modifica. Esa capa es el trabajo de fondo y la comparten las cuatro
superficies.

---

### F3 — La capa de escritura

Sin esto no hay CRUD de nada, así que va primero y va completa.

- [x] Mutaciones sobre `Doc` desde el hilo correcto (`EngineHost::withFixturesLocked`, y
      `stopAndWait` antes de tocar la lista de fixtures de un EFX).
- [x] Estado `modified` propagado, y `POST /project/save` como único punto de
      persistencia. Ninguna edición escribe en disco por sorpresa.
- [x] Validación en el borde, con el motivo dentro: un patch que se solapa, un modo que
      no existe, un canal más allá del último del fixture, una escena donde una cue list
      necesita un chaser.
- [x] **Difusión por WebSocket de cada cambio.** `Doc::modified` se dispara en toda mutación sin excepción, así que es la garantía: pase lo que pase, al cliente se le dice que vuelva a mirar. Las señales concretas de `Doc` y `EngineHost::consoleChanged` solo lo afinan, para que un navegador con la consola abierta no relea la librería de fixtures porque alguien renombró un universo. Coalescido en el mismo flush que el DMX: una edición que toca diez cosas es una cosa que contar.
- [x] **Deshacer y rehacer, acotado a la consola** — y el nombre lo dice. La consola es XML preservado: deshacer una edición es devolver una cadena a su sitio, lo que no cuesta nada ni molesta a nadie. Deshacer un cambio sobre `Doc` sería reconstruir el documento — parar el timer, tirar toda función en marcha y todo nivel retenido — y un control capaz de dejar el rig a oscuras no es un botón de deshacer, se llame como se llame. Así que un widget borrado vuelve, y un fixture borrado se vuelve a parchear a mano. La asimetría es deliberada y conviene saberla. Pila de 50, ramas nuevas descartan lo que había delante, y `409` con el motivo cuando no queda nada.

### F4 — Fixtures y universos ✅

- [x] Fixtures: alta, baja, edición de dirección, universo y nombre — API y **pantalla de patch en el navegador**.
- [x] Buscador de la librería por fabricante → modelo → modo, que son los tres pasos que da un operador.
- [x] **Mapa de 512 canales** por universo, con cada fixture de un color: un solape se ve antes de convertirse en una luz que no responde. La alta ya lo rechaza (`Channel 1 of universe 1 is already used by "Par 1"`).
- [x] Universos: alta, baja, nombre, passthrough, y **patch de salida** con los plugins y líneas que el daemon tiene cargados. Un universo sin salida sale marcado, porque no llega a nada y el proyecto se ve igual de sano.
- [x] `GET /api/v1/universes` informa ahora también del patch de entrada y del passthrough: un universo en passthrough ignora la mesa, y el operador no tenía otra forma de enterarse.
- [x] **Grupos de fixtures en la interfaz**, con su orden: para una matriz de barras de píxel ese orden no es decoración, es lo que decide por dónde corre el efecto, así que añadir un fixture concatena en vez de recolocar el grupo entero.
- [x] **Grupos de canales**, con su fader donde se construyen. No es un grupo de fixtures: junta canales sueltos (el dímer de una, el estrobo de otra, el ventilador de la máquina de humo) bajo un único fader, y vive en el documento, no en la consola — así que ningún submáster lo escala y su id no tiene nada que ver con el de un widget. El motor acepta cualquier número de canal y lo escribe en la dirección del fixture más el desplazamiento, así que un canal más allá del último aterriza sobre el fixture de al lado: se rechaza en el borde. Y lo que un grupo suelta —un canal quitado, el grupo entero borrado— se baja a cero, porque un canal que no es de intensidad se queda exactamente donde estaba y el único mando que podía bajarlo es el que acaba de desaparecer.
- [x] **Modificadores de canal**, con la curva dibujada. Es la tabla de 256 valores por la que pasa un canal al salir: «Invert» da la vuelta a un fader, «Always Full» clava un canal abierto, «Exponential Deep» dobla un dímer para una lámpara que no funde en línea recta. Se dibuja además de nombrarse, porque «Exponential Medium» y «Exponential Deep» son igual de plausibles y solo la forma dice cuál es la que necesita la lámpara. No se aplica con `Doc::updateFixtureChannelCapabilities` —que es lo que llama el escritorio— porque de camino reaplica el valor por defecto de **todos** los canales: poner una curva en uno tiraría el resto de la fixture a sus defaults, que en un rig sosteniendo un look es una lámpara que se apaga sin motivo visible.

### F5 — Funciones: los diez tipos 🔨

- [x] **Capa genérica**: crear los **diez tipos**, renombrar, velocidades, orden de ejecución y dirección, y borrar. Verificado creando uno de cada, guardando y recargando.
- [x] **Orden de construcción corregido** por el mapeo: se registra primero y se nombra después (como la UI v4). Nombrar antes emite `nameChanged` con un id todavía inválido, a un `Doc` que aún no está conectado, y sin marcar el documento como modificado.
- [x] **Borrar comprueba referencias** con `Doc::getUsage()` y nombra a quién la usa — `Doc::deleteFunction` no lo hace y dejaría pasos de chaser apuntando a nada. `force=true` para saltárselo.
- [x] **Borrar para la función y espera** (`stopAndWait`): liberar una función en marcha es liberar un objeto que el `MasterTimer` sigue recorriendo.
- [x] Cuerpos: **Scene** (valores por fixture y canal, con validación de canal que el motor no hace), **Chaser** (pasos con tiempos, sin auto-referencia), **Collection** (miembros, sin auto-referencia).

- [x] Cuerpos de **RGBMatrix** (grupo, algoritmo de entre 43, hasta 5 colores), **Script** (programa, validado por el parser del motor), **Audio** (archivo verificado contra los decodificadores cargados, volumen) y **Video** (archivo local o URL).

- [x] Cuerpos de **EFX** (algoritmo de entre 7, geometría con rangos validados, fixtures participantes) y **Sequence** (escena vinculada).

- [x] **Gestor de funciones en el navegador.** Lista agrupada por tipo, crear los diez, renombrar, tiempos, arrancar/parar y borrar. El borrado enseña a quién le hace falta la función antes de forzarlo, en vez de dejar pasos de chaser apuntando a nada.
- [x] Edición de cuerpo para las tres formas que son listas de cosas: valores de una **escena** (por fixture y canal, con nombre), pasos de un **chaser**, miembros de una **colección**. Los demás tipos lo dicen en vez de enseñar un editor vacío que se leería como "esta función no tiene nada".

- [x] **Lectura y edición de los cinco cuerpos que faltaban** — EFX (patrón, geometría y cabezas con nombre), RGBMatrix (algoritmo, grupo y tantos colores como acepte el algoritmo), Script, Audio y Vídeo. Las claves de lectura son las mismas que acepta el `PUT`, para que un cliente lea un cuerpo, cambie un campo y lo mande de vuelta sin traducir.

**Pendiente:** cuerpo de `Show` — el timeline multipista, que es F7, y el único que sigue diciendo honestamente que no es legible.

> **Peligro que el mapeo destapó y que ahora se respeta**: `EFX::m_fixtures` es una `QList` sin mutex que `EFX::write()` recorre **en el hilo del `MasterTimer` cada 20 ms**. Reconstruirla en caliente libera objetos que ese hilo está usando. Cambiar los fixtures de un EFX **lo para y espera** antes de tocar la lista, igual que hacen los dos editores de escritorio. Lo mismo para rebindear la escena de un Sequence, cuyos pasos solo significan algo contra ella.

> **Trampa del motor**, encontrada al probar: `RGBAlgorithm::algorithm()` **no puede** informar de un nombre inválido. Para cualquier cosa que no sea uno de sus cuatro algoritmos internos cae en `RGBScriptsCache::script()`, que devuelve un `RGBScript` **vacío pero no nulo** (`rgbscriptscache.cpp:42-55`). Una errata se aceptaba, la matriz corría y no emitía nada, sin error en ninguna parte. Ahora el nombre se valida contra la lista **antes** de pedir la instancia.

> **Nota de compatibilidad**: nuestro motor viene de `master`, más nuevo que QLC+ 5.2.1. Un proyecto guardado aquí puede llevar campos que esa versión no conoce (p. ej. `DimmerControl` en un EFX); los avisa y los ignora, igual que ignora nuestra sección de layout.

### F6 — Virtual Console: los doce widgets 🔨

**Decisión de diseño, tomada tras mapear los 11 widgets campo a campo.**

El modelo actual cubre **124 de 489 campos persistidos (25 %)**. Regenerar `<VirtualConsole>` desde él no sería una pérdida marginal: **borraría la mayor parte de la sección** — cada `<Input>` y `<Key>` (todo el mapeo MIDI/OSC/teclado del show), el `<Action>` de cada botón (un botón "BLACKOUT" pasaría a ser un toggle), las fuentes, el `<Properties>` con el Grand Master y su binding, las páginas de los frames multipágina…

Así que **se parchea el árbol preservado en sitio, nunca se regenera**: el fragmento capturado sigue siendo la fuente de verdad; se parsea a un árbol mutable que guarda nombres, atributos *en orden*, texto e hijos verbatim; las mutaciones son parches dirigidos; y se reserializa. Lo no modelado sobrevive porque **nunca se destruye** — son nodos copiados, no valores rederivados. Es la misma disciplina de `<OrchidLightsLayout>`, aplicada hacia dentro.

**Hecho:**

- [x] **Control de cue lists** (play/stop/next/previous/ir a paso) — una cue list es un chaser más transporte, así que se controla sin escribir XML. El transporte sobre una parada la arranca primero, como hace una mesa real.
- [x] **Cinco fallos del lector corregidos**, todos con efecto hoy:
  - `Matrix` faltaba en la lista de etiquetas —que además contenía `Animation` y `ButtonMatrix`, **que no existen en ningún árbol**—, así que un widget Matrix era invisible.
  - El fader de *playback* nombra su función como texto dentro de `<Playback>`, no como atributo: nunca reportaba ninguna.
  - El reloj guarda `@Type` y `@Hours/@Minutes/@Seconds` **en el propio elemento** y jamás escribe `<Time>`; leer de ahí daba siempre cero.
  - `@Page` se ignoraba, así que un frame multipágina se dibujaba con **todas las páginas superpuestas**.
  - El `ID` ausente se tomaba como 0, que es un id real de otro widget.
- [x] `server/test/data/vc-widgets.qxw`, un proyecto que contiene justo las formas que los shows reales aquí no tienen, para que estos cinco no vuelvan.
- [x] **`server/src/xmltree.*`**: el árbol verbatim, y `WorkspaceLoader` guardando **a través de él** para que cada guardado lo ejercite. Los seis proyectos de la máquina devuelven su Virtual Console carácter a carácter.
- [x] **`server/src/vcpatch.*`**: alta, baja y edición de widgets como parches dirigidos. Caption, geometría y página; y lo que el widget *hace*: función de un botón con su acción, modo y canales de un fader, chaser de una cue list, tipo y cuenta atrás de un reloj.
- [x] `POST` / `PATCH` / `DELETE /api/v1/vc/widgets`. Crear y editar recorren **el mismo camino**, así que no se puede crear un widget en un estado que una edición habría rechazado.
- [x] Verificado sobre el show real (203 nodos, 33 widgets, con su mapeo MIDI y sus fuentes): pedir dos cambios cambia **exactamente esos dos atributos**, y un alta seguida de una baja deja el fichero idéntico.

> **La trampa que costó el diseño de la búsqueda.** Dentro del Virtual Console, `ID` no es un atributo privado del widget: un XY pad escribe `<Fixture ID="3" Head="0">` y un botón `<Function ID="1">`. Buscar "el elemento que lleva ID=3" encuentra el equivocado, y **borrar quitaría un fixture de un XY pad en vez del widget pedido**. La búsqueda desciende solo por etiquetas de widget. `server/test/data/vc-references.qxw` hace colisionar a propósito el widget 3 con el fixture 3 para que no vuelva.

> **Referencias colgantes cerradas.** Borrar un fixture ahora lo borra también del console (`<Channel Fixture>` de los faders, `<Fixture ID>` de los XY pads). QLC+ tolera la referencia muerta, pero `Doc` reparte el id libre más bajo: el siguiente fixture heredaba el id **y los faders que apuntaban al anterior**.

> Y validación que el motor no hace: una función que no existe, un canal más allá del último del fixture, una escena donde una cue list necesita un chaser. Todo eso carga en QLC+ sin una palabra y produce un control que se ve bien y no hace nada.

- [x] **Editor en el navegador**: modo *Editar* con paleta para añadir, panel por widget y borrado. El panel ofrece **solo lo que ese widget tiene** — una etiqueta tiene nombre y nada más; un botón, función y acción; un fader, modo y canales — porque ofrecer todo para todo deja al operador ajustar cosas que no hacen nada.
- [x] **Canales por nombre, no por número.** "Dimmer" es el canal 6 en un modo y el 8 en otro, y nadie debería recordarlo a oscuras. `GET /api/v1/fixtures/{id}` los nombra; la lista sigue sin hacerlo, porque un rig de 30 cabezas son mil nombres que nadie pidió.
- [x] **Identificadores para proyectos de QLC+ 4.** Aquella versión no escribía `ID` en ningún widget —la consola que QLC+ distribuye hoy no tiene ni uno— y toda edición direcciona por id: esos proyectos no son *parcialmente* editables, no lo son en absoluto. La interfaz lo dice y ofrece asignarlos; sobre el `Sample.qxw` son 140 widgets y **el único cambio en 1.581 nodos son esos 140 atributos**.
- [x] **`server/test/ui-smoke.sh`**: la interfaz construida, en un Chrome de verdad, contra un motor de verdad. Añade un widget pulsando, lo renombra, lo apunta a una función y lo borra; después comprueba que el fichero volvió exactamente a donde estaba. Un error del daemon tiene que **llegar al operador**, y eso también se comprueba.

> **Trampa de React que el test destapó**: `onBlur` escucha `focusout`, no `blur`. Y el efecto que rellenaba el campo del nombre estaba indexado por el objeto widget, que se reconstruye tras **cada** edición — así que borraba lo que estabas escribiendo, incluso por una edición del propio panel. Indexado por id.

- [x] **Cue lists en el navegador.** Los pasos, el que está en marcha resaltado, transporte de play/stop/anterior/siguiente, y salto directo a un cue — que es lo que hace un operador cuando el show se salta un número. El cue actual viene por el feed en vivo, así que dos móviles corriendo el mismo show ven el mismo cue.
- [x] **`GET /api/v1/functions/{id}/body`**: pasos de un chaser, valores de una escena, miembros de una collection, con nombres. La escritura ya existía; sin la lectura un cliente cambia un cuerpo que no puede ver, y eso no es editar, es adivinar.
- [x] **XY pads funcionando.** `LevelSource` aprende a apuntar cabezas: la posición es una fracción del tramo de recorrido que el proyecto le permite a cada cabeza, escalada al espacio de 16 bits que comparten el canal grueso y el fino. Límites, ejes invertidos y canales finos, todo del proyecto — un foco colgado boca abajo se apunta invirtiendo un eje, e ignorarlo lo manda al techo.
- [x] `server/test/xypad-smoke.sh` **lee el universo de vuelta**. Todo lo demás de un pad puede funcionar sin que se mueva una luz: la posición se aparca bajo mutex, se replica a los otros clientes y se reporta bien, llegue o no a un canal. Con tres MAC500 (dos gruesos, uno con finos) comprueba el origen, la esquina, el eje invertido, el tilt limitado a la mitad superior, y que un tercio del recorrido da 85 grueso **y 85 fino** — en 8 bits el fino saldría cero y la cabeza daría 512 pasos en vez de 65.536.
- [x] `GET /vc` cuenta las cabezas **que de verdad se pueden apuntar**, consultando a `Doc`: un pad puede nombrar un fixture sin pan ni tilt, y entonces es un control que se ve bien y no mueve nada.
- [x] **Marcos anidados, paginados y solo.** Un marco se dibujaba como una caja gris vacía, que en una consola construida a base de marcos significa que casi todo el show es invisible: el `Sample.qxw` de QLC+ tiene 125 widgets y **cuatro** salían en pantalla. Ahora se dibujan con lo que llevan dentro, refluido por la misma regla que la página.
- [x] **Paginación por marco**, que es como lo guarda QLC+ — por marco, no por consola, y cada hijo nombra su página en `@Page`. Ignorarlo dibuja todas las páginas superpuestas, que parece una página con el doble de botones.
- [x] **Semántica de solo**, en el daemon y no en la interfaz: un marco solo que solo lo fuera en un navegador es peor que uno que no lo sea. Arrancar rojo tira azul; una función fuera del marco no es hermana de nadie y sobrevive.
- [x] **Sliders de playback.** No escriben canales: a cero paran su función, por encima la arrancan y le mantienen la intensidad en la fracción del fader. Corre en el hilo del timer como el resto, porque arrancar una función y sobrescribirle un atributo son dos cosas que el motor espera en su propio reloj. El override se devuelve al parar — mantenerlo es como un fader acaba ajustando el atributo de una función que ya no corre.
- [x] **Sliders de submaster, enteros.** Escalan los faders de nivel, los playbacks, los botones y las cue lists de su marco y de todo lo que cuelga de él; anidados, multiplican. No son fuente DMX: escalan a través de `GenericFader::adjustIntensity`, que el motor aplica **solo a canales del grupo Intensity** — así que una rueda de color o un pan/tilt no se tocan, igual que en QLC+. Multiplicar el valor en el target habría atenuado una rueda de color hasta convertirla en otro color.
- [x] Una función arrancada **con el submaster ya bajo** sube escalada, no a tope. Los botones y las cue lists no se disparan desde aquí, así que no hay mensaje donde colgar una bandera: se comprueban cada tick, que con un puñado de ellos sale más barato que rastrearlo.
- [x] **Divergencia consciente con QLC+**, documentada en el código: con dos submasters en el mismo marco, QLC+ depende del orden y **oscurece el rig un poco más en cada reemisión**. Aquí es un producto sobre la cadena, idempotente y sin orden. Un submaster nunca se escala a sí mismo ni a sus hermanos.
- [x] Honestidad: un submaster que no encierra nada escalable sale **no operable** y dice cuántos widgets escala. Uno solo en un marco de etiquetas y XY pads sería justo el control que no hace nada.
- [x] **Widget de RGB Matrix.** Es un fader sobre la matriz —a cero la para, por encima le monta la intensidad, igual que un playback— más su banco de presets: un preset de color deja un color guardado en uno de los cinco huecos del algoritmo, uno de animación cambia el algoritmo **llevándose las propiedades de script con las que se guardó** (aplicado sin ellas es otra animación).
- [x] Los knobs, las imágenes y los textos se enseñan pero **no se ofrecen**: son continuos o necesitan un fichero. La primera versión del predicado los daba por aplicables porque `"Color1Knob"` también empieza por `"Color"` — lo cazó el test de interfaz contando cuántos salían habilitados.
- [x] **Audio triggers.** El motor abre el micro, hace la FFT y reparte las bandas; cada barra sujeta unos canales DMX a su nivel, arranca una función al pasar un umbral y la para al bajar de otro, o mueve otro widget. **Verificado de punta a punta**: con un micrófono con señal, el ruido de la sala movió los canales 1 y 2 (picos de 175 y 70) mientras el 3, que no tiene barra, no se tocó.
- [x] **Dos umbrales, no uno.** Un único punto de cruce hace que la función parpadee alrededor de él, que en una lámpara es un estrobo que nadie pidió.
- [x] **El micrófono no se abre hasta que alguien lo enciende**, y se suelta cuando se apaga el último. Es un dispositivo que el operador puede estar usando para otra cosa.
- [x] **Elección de entrada**, `GET`/`PUT /api/v1/audio`. Es la diferencia entre un widget que no funciona y uno que escucha el conector equivocado: en esta máquina la entrada por defecto de Qt es un jack de auriculares sin nada enchufado, y desde la consola las dos cosas se ven idénticas. La captura ya leía la clave de `QSettings`; solo faltaba poder escribirla.
- [x] Una barra que sujeta canales se registra en `LevelSource` como cualquier otro fader, así que sale en el hilo del timer, tiene su propio fader y la escalan los submasters que la envuelven, sin que esta clase sepa que existen.
- [ ] Apariencia (colores, fuentes) y controles externos: mapeo de entrada
      (MIDI/OSC) por widget.

> **Dos bugs que el mapeo del submaster destapó, arreglados antes de tocarlo.** Un `Universe` guarda su propia referencia a cada fader que reparte, así que soltar la nuestra **no lo desregistra**: cada edición de la consola dejaba uno huérfano asegurando su último valor, y como los faders mezclan HTP, el slider ya no podía bajar el canal nunca más. Editar un caption a mitad de show dejaba un foco arriba hasta recargar el proyecto. Y `forgetSliders` borraba los valores, así que arreglar lo primero habría hecho que cada edición apagara el rig. Ahora los faders se devuelven en el hilo del timer y los valores sobreviven, reafirmándose en el siguiente tick.

### F7 — Show manager y previsualización 2D ✅

- [x] **Timeline multipista**, con las barras arrastrables y el cabezal de reproducción en vivo. El cuerpo de un Show era lo único que este daemon no sabía leer en absoluto: contestaba una nota diciéndolo. Ahora se leen las pistas, lo que hay colocado en cada una y cuándo, y se edita desde el navegador — añadir y quitar pistas, colocar funciones, moverlas, estirarlas, bloquearlas.
  - **Solapes rechazados en la misma pista**, nombrando con qué choca: dos cosas a la vez en una pista suenan las dos y lo que hace el rig es lo que escribiera la última, que no es algo que se pueda leer de una timeline que las dibuja apiladas. En pistas distintas sí, que es para lo que están las pistas.
  - **Un script o una colección no pueden ir en una timeline**: no tienen duración, así que no hay barra que dibujar ni final en el que pararlos. Ni un show dentro de sí mismo, que es un bucle por el que el runner se mete.
  - **`Show::write` no incrementaba `elapsed`** — el único tipo de función del motor que no lo hacía, siendo que el runner recibe `elapsed()` al construirse. Sin eso nada fuera del runner podía decir por dónde iba un pase, y el cabezal habría tenido que ser un cronómetro local: uno que deriva y que sigue corriendo cuando el show ya ha terminado. Arreglado en el motor.
  - La posición viaja en su propio mensaje de WebSocket, no como campo de la lista de funciones: `elapsed` cambia cada tick y ensuciar la lista por él empujaría todas las funciones del proyecto por todos los sockets al ritmo del flush.
- [x] **Planta del rig con color y dimmer en vivo**, sobre la imagen de fondo del proyecto. Se arrastra para colocar las fixtures, y se guarda en el `<Monitor>` de QLC+ para que la planta abra igual en el escritorio.
  - **El color se calcula en el navegador**, no lo manda el daemon. La interfaz ya recibe todos los frames DMX; en cuanto sabe que el rojo de la fixture 4 es el canal 0 y su dímer el 6, pinta la planta entera en cada frame sin preguntar nada. Un viaje de ida y vuelta por frame convierte la planta en un pase de diapositivas, y una planta que va con retraso es peor que ninguna, porque se la cree uno.
  - **Una fixture sin colocar no se dibuja en el origen**: se queda en una bandeja esperando sitio. Una planta que apila calladamente todas las lámparas sin colocar en una esquina parece una planta y no lo es.
  - **Apagada se dibuja como contorno, no como negro**: una lámpara a cero y una lámpara cuyo universo no está llegando se ven idénticas si las dos se pintan negras, y solo una de las dos es un problema.
  - **La altura se rechaza** en vez de aceptarse y perderse: este build del motor solo escribe X e Y al fichero (la tercera coordenada está tras `QMLUI` en `monitorproperties.cpp:959`), y una lámpara que se mueve al reabrir el proyecto es peor que una que nunca se pudo subir.
  - Los frames solo se piden mientras la planta está abierta, y se tiran al salir: llegan al ritmo del flush y meterlos por el estado de React re-renderiza todo lo que haya montado.

### F8 — Extras

- [ ] 3D opcional, PWA instalable, multiusuario con roles.

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
