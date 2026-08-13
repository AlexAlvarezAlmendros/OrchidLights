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

- [x] **Faders funcionando.** `server/src/levelsource.cpp` se registra como `DMXSource` en el `MasterTimer`, que es la única vía sancionada para escribir en un universo fuera de una Function: `writeDMX()` corre en el hilo del timer con los universos ya reclamados. Mover un fader desde HTTP o WebSocket **no toca un universo**: aparca el valor bajo mutex y el siguiente tick (≤20 ms) lo aplica.
- [x] Verificado contra el rig real: el fader *Washes* del P62 escribe 200 en los canales DMX **158, 184, 210, 236** — el canal 6 (dimmer) de los cuatro Hero Wash 300FC en 153/179/205/231, y en ningún otro sitio.
- [x] Faders horizontales en móvil (más fáciles con una mano) y verticales en escritorio, como en una mesa. Valores sembrados desde el proyecto, y sincronizados entre clientes por WebSocket.
- [x] Los sliders de tipo *playback* y *submaster* se parsean pero salen **deshabilitados y etiquetados**: mostrarlos operativos sería una mentira que el operador descubre cuando la luz no se mueve.

**Pendiente:**

- [x] **Speed dial funcionando.** Verificado sobre el rig: mover el dial de 430 ms a 3000 y a 500 cambia la duración de los tres chases y los dos EFX de movimiento del P62. Las velocidades (`fadeIn`/`fadeOut`/`duration`) se exponen ahora en `/api/v1/functions`, para que el efecto sea **observable** y no solo confirmado por un acuse.
  Los flags del XML son índices en la tabla de multiplicadores de QLC+, donde `0 = None` significa "no toques esa velocidad" — por eso un dial que parece controlar un fade a menudo solo controla la duración.
- [ ] Sliders de playback y submaster, cue lists, XY pads.

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

- [ ] Mutaciones sobre `Doc` desde el hilo correcto. El motor corre en su propio
      hilo y añadir o borrar un fixture bajo un `MasterTimer` que está escribiendo
      DMX es el mismo problema de concurrencia que ya apareció al cargar proyectos.
- [ ] Estado `modified` propagado, y `POST /project/save` como único punto de
      persistencia. Editar no debe escribir en disco por sorpresa.
- [ ] Difusión por WebSocket de cada cambio, para que dos clientes no diverjan.
- [ ] Validación en el borde: un patch que se solapa, un modo que no existe, un
      universo fuera de rango. Rechazar con un mensaje que diga qué está mal.
- [ ] Deshacer. QLC+ v5 tiene `Tardis`; sin equivalente, editar desde el
      navegador da miedo y con razón.

### F4 — Fixtures y universos

- [ ] Fixtures: alta, baja, edición de dirección, universo, modo y nombre.
- [ ] Buscador de la librería (1.735 perfiles) por fabricante, modelo, tipo y
      número de canales.
- [ ] Mapa de 512 canales por universo con **detección de solapes**.
- [ ] Grupos de fixtures y grupos de canales.
- [ ] Universos: alta, baja, nombre, passthrough, monitor.
- [ ] Patch de entrada y salida por universo, con los plugins y perfiles
      disponibles. **Esto es lo que hace que salga luz**, y hoy solo se lee.
- [ ] Modificadores de canal.

### F5 — Funciones: los diez tipos

Crear, editar y eliminar. No un subconjunto.

- [ ] `Scene` — consola de canales por fixture, paletas, presets.
- [ ] `Chaser` — pasos, tiempos por paso, orden, modo de ejecución.
- [ ] `EFX` — patrón, ejes, fixtures participantes, previsualización.
- [ ] `RGBMatrix` — grupo, algoritmo, colores, propiedades del script.
- [ ] `Collection`, `Sequence`, `Script`, `Show`, `Audio`, `Video`.

### F6 — Virtual Console: los doce widgets

Crear, editar, eliminar y configurar. Hoy se renderizan cinco, en solo lectura.

- [ ] Control completo: `cuelist`, `xypad`, `clock`, `audiotriggers`,
      `animation` (control de RGB Matrix), `soloframe` con su semántica de solo,
      `slider` en modos playback y submaster, paginación de `frame`.
- [ ] Edición: añadir y borrar widgets, asignarles funciones y canales,
      apariencia, y las propiedades específicas de cada tipo.
- [ ] Controles externos: mapeo de entrada (MIDI/OSC) por widget.
- [ ] La disposición sigue en `<OrchidLightsLayout>`; **crear widgets sí exige
      escribir `<VirtualConsole>`**, y entonces hay que modelarlo por completo o
      se pierde lo que no se modele. Es el punto de mayor riesgo del proyecto.

### F7 — Show manager y previsualización 2D

- [ ] Timeline multipista.
- [ ] Planta del rig con color y dimmer en vivo sobre imagen de fondo.

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
