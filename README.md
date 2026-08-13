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

## El API

```bash
orchidlightsd ~/shows/tonight.qxw          # escucha en 127.0.0.1:9998
orchidlightsd --check tonight.qxw          # carga, informa y sale
orchidlightsd --no-output tonight.qxw      # motor en marcha, nada sale a la red
```

| | |
|---|---|
| `GET /api/v1/status` | versión, librería, plugins cargados, recuentos, funciones en marcha |
| `GET /api/v1/fixtures` | patch completo; `resolved:false` marca los que cayeron a dimmer genérico |
| `GET /api/v1/functions` | escenas, chasers, EFX… con su estado `running` |
| `GET /api/v1/universes` | universos y su patch de salida; `patched:false` no llega a ningún sitio |
| `POST /api/v1/functions/{id}/start` | encola el arranque |
| `POST /api/v1/functions/{id}/stop` | encola la parada |
| `POST /api/v1/blackout` | para todo y activa blackout |
| `DELETE /api/v1/blackout` | lo desactiva |
| `GET /api/v1/project` | proyecto cargado y si tiene cambios sin guardar |
| `GET /api/v1/projects` | proyectos disponibles en el directorio permitido |
| `POST /api/v1/project/load/{nombre}` | carga otro proyecto |
| `POST /api/v1/project/save` | guarda sobre el archivo actual |
| `POST /api/v1/project/save/{nombre}` | guarda con otro nombre |

Los endpoints de proyecto toman un **nombre de archivo, nunca una ruta**, y solo
dentro del directorio de `--projects` (por defecto, el del proyecto que abriste).
Aceptar rutas sería entregarle a quien tenga el token una primitiva de escritura
arbitraria de archivos, y eso no es un intercambio que deba hacer una mesa de
luces.

**Guardar preserva lo que el motor no modela.** Virtual Console y Simple Desk
viven fuera de `Doc` en QLC+ y este daemon todavía no tiene modelo para ellos:
se conservan **verbatim**, incluidas las declaraciones de namespace del archivo.
Si un guardado los perdiera, el archivo seguiría abriendo y los fixtures
seguirían ahí — y el operador se enteraría de que su Virtual Console ha
desaparecido la noche que importa. Hay un test dedicado a esto.

Los comandos de función responden **202 Accepted**, no 200, y no devuelven
estado. El motor los encola y la transición ocurre en el siguiente tick, 20 ms
después: serializar la función en ese momento devolvería el estado *anterior* al
comando — un `POST /start` contestando `running: false`, que se lee como un
fallo. El resultado se observa con `GET /api/v1/functions`.

Las direcciones DMX y los universos van **1-based** en el API, como están
impresos en los focos y como se teclean en una mesa. El motor cuenta desde 0
internamente; la conversión ocurre en un solo sitio, `server/src/jsonview.cpp`.

### El feed en vivo (WebSocket)

Mismo puerto, en `/ws`. Estado en JSON, DMX en binario.

```js
const s = new WebSocket('ws://mesa.local:9998/ws')
s.binaryType = 'arraybuffer'

s.onmessage = (e) => {
  if (e.data instanceof ArrayBuffer) {
    const f = new Uint8Array(e.data)
    const universo = f[0] | (f[1] << 8)   // 1-based, little endian
    const canales = f.subarray(2)          // valores DMX
    return
  }
  const msg = JSON.parse(e.data)   // hello · authenticated · functions · subscribed · error
}

// Si hello.authRequired, esto va primero y nada más se acepta antes:
s.send(JSON.stringify({ type: 'auth', token }))

s.send(JSON.stringify({ type: 'subscribe', universes: [1] }))
s.send(JSON.stringify({ type: 'function', id: 3, action: 'start' }))
```

**Por qué binario:** 512 canales por universo como array JSON de números pesa
unas diez veces lo mismo para la misma información.

**Por qué el token va en el primer mensaje** y no en la URL: un navegador no
puede poner cabeceras `Authorization` en un WebSocket, y un token en la query
acaba en los logs del proxy y en el historial del navegador.

Los frames se **agrupan por universo y se envían a 25 Hz**, no a los 50 del
motor: el ritmo de la red se desacopla del ritmo del show, y un cliente lento no
puede frenar la mesa. El motor además solo emite cuando los valores cambian, así
que una escena estática no gasta ancho de banda.

### Autenticación

El daemon escucha **solo en loopback** por defecto y ahí no pide nada: el
sistema operativo ya es la frontera.

`--listen-all` lo abre a toda la red y **activa el token** automáticamente. Una
mesa alcanzable desde la red de una sala es una mesa que cualquiera en esa red
puede dejar a oscuras en mitad del pase.

```bash
orchidlightsd --listen-all tonight.qxw
# Authentication: required
#   token file: ~/.orchidlights/api-token

curl -H "Authorization: Bearer $(cat ~/.orchidlights/api-token)" \
     http://mesa.local:9998/api/v1/status
```

El token son 32 bytes del CSPRNG del sistema, se genera en el primer arranque y
se guarda con permisos `600`. Rotarlo es borrar el archivo. La comparación es en
tiempo constante, para que nadie lo deduzca byte a byte midiendo cuánto tarda el
rechazo. `--require-auth` lo exige también en loopback, para máquinas con
usuarios locales en los que no se confía.

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
