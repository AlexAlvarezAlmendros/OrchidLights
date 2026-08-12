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

### F0 — Fundación del fork 🔨

- [x] Repo propio con la historia completa de upstream preservada; `upstream` se mantiene como remote para cherry-picks puntuales.
- [x] Rebranding en `variables.cmake`: `APPNAME`, `INSTALLROOT`, `DATADIR`, `USERDATADIR` (`~/.orchidlights`), `PLUGINDIR`. **El formato `.qxw` no se toca** — hay shows reales en producción que deben abrir en ambas aplicaciones.
- [x] `NOTICE` + README declarando la relación con QLC+ (obligación de Apache-2.0 §4: conservar avisos de copyright y declarar los cambios; y §6: no usar el nombre ni el logo de QLC+ como marca del derivado).
- [x] CMake: opción `-Dserver=ON` que poda `ui/`, `qmlui/`, `fixtureeditor/` y `webaccess/` del build.
- [x] Esqueleto de `server/`: `orchidlightsd` carga un `.qxw` sin interfaz y lista fixtures, universos y funciones.
- [x] CI: build Linux con Qt 6 + smoke test headless.
- [ ] **Verificar que compila.** Falta instalar el toolchain de Qt 6 en la máquina local (requiere `sudo`). Hasta entonces el código de `server/` está escrito pero **sin compilar ni una vez**.
- [ ] AppImage.
- [ ] Icono y `.desktop` propios.

### F1 — Daemon headless + API core
- Target `orchidlightsd`: `QGuiApplication` offscreen, carga un `.qxw`, arranca `MasterTimer` y los plugins de salida sin abrir ventana.
- `QHttpServer` + `QWebSocketServer`, protocolo JSON versionado, autenticación por sesión.
- Endpoints: proyecto (load/save/list), fixtures (lectura), universos (lectura + stream DMX), funciones (listado + run/stop).
- **Fallback al directorio de usuario heredado**: si `~/.orchidlights` no existe, leer perfiles `.qxf` y perfiles de entrada de `~/.qlcplus`. Sin esto se pierden los 3 perfiles custom del rig del P62.
- Round-trip de `.qxw`: cargar y guardar un proyecto no debe alterar las secciones que el motor no gestiona (Virtual Console, Simple Desk). Test en CI con proyectos reales.
- **Criterio de éxito: disparar el show del P62 Club desde `curl`/`wscat`, con luz real en la sala, sin abrir ninguna GUI.**

### F2 — Shell web + Virtual Console en directo *(dolor #1)*
- SPA con el layout responsive y los dos temas.
- Grid de VC alimentado por `/vc.json` (ya existe upstream): botones, faders, cuelist, speed dial.
- Presupuesto de latencia: **≤ 50 ms de *tap* a DMX**.
- Editor de layout drag & drop **sobre grid, no sobre píxeles absolutos** — esto es exactamente lo que hace que un VC deje de romperse al cambiar de pantalla.

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
                 libasound2-dev libusb-1.0-0-dev libftdi1-dev libmad0-dev \
                 libsndfile1-dev libfftw3-dev

cmake -S . -B build -G Ninja -Dserver=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build
QT_QPA_PLATFORM=offscreen ./build/server/src/orchidlightsd ~/Documentos/QLC+/17Julio.qxw
```

Ese último comando, listando los 22 fixtures del P62 sin abrir ventana, cierra F0.
