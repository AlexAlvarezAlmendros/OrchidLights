# OrchidLights para agentes

OrchidLights es una mesa de luces DMX: un daemon en C++ con el motor de QLC+
dentro, que habla HTTP y WebSocket en el mismo proceso que el reloj de tiempo
real. Un agente puede **montar un proyecto entero** —patch de fixtures, salida
DMX, entrada MIDI, el escenario en 3D, escenas, chasers y la consola— y también
**manejarlo en directo**.

Este documento es para las dos cosas que puede querer un agente aquí:

- **Manejar una mesa** — construir y controlar shows contra un daemon que está
  corriendo. Es casi todo lo que sigue.
- **Trabajar en el código de OrchidLights** — al final del todo.

---

## Tres formas de entrar, y cuál usar

**MCP**, si tu cliente lo habla. Diecinueve herramientas con forma de tarea, no
ciento treinta y nueve envoltorios de endpoint: con ciento treinta y nueve
herramientas delante el contexto se gasta en elegir.

```bash
cd mcp && pnpm install && pnpm build

# Claude Code, en este checkout: .mcp.json ya lo declara.
# En cualquier otro sitio:
claude mcp add orchidlights -- node /ruta/a/OrchidLights/mcp/dist/mcp.js

# OpenCode, en opencode.json:
#   { "mcp": { "orchidlights": { "type": "local",
#     "command": ["node", "/ruta/a/OrchidLights/mcp/dist/mcp.js"] } } }
```

Trae tres recursos que conviene leer antes de construir nada: `orchid://guide`
(esto mismo), `orchid://routes` (las 139 operaciones en una línea cada una) y
`orchid://project` (el proyecto cargado, como documento).

**El CLI**, si vives en una shell — que es donde vive un agente de Claude Code o
de OpenCode:

```bash
node mcp/dist/cli.js status
node mcp/dist/cli.js export -o show.yaml
node mcp/dist/cli.js diff show.yaml        # qué haría, sin hacerlo
node mcp/dist/cli.js apply show.yaml --save
node mcp/dist/cli.js dmx 1                 # ¿ha llegado la luz?
```

**REST a pelo**, con `curl`, para lo que no cubran los dos anteriores. El
contrato completo está en `GET /api/v1/openapi.json`.

---

## El proyecto como un archivo de texto

Montar un show llamada a llamada son doscientas peticiones en orden, cada una
con su fallo posible, y un fallo a mitad deja el proyecto en un estado que no es
ni el viejo ni el nuevo. Por eso hay un documento declarativo:

```yaml
orchidlights: 1

stage: {width: 12, height: 6, depth: 8, units: meters}   # unidades, no mm

universes:
  - name: Universe 1
    output: {plugin: ArtNet, line: eth0}
    input:  {plugin: MIDI, line: BCF2000, profile: Behringer BCF2000}
    feedback: {plugin: MIDI, line: BCF2000}

fixtures:
  - name: Cabeza L
    manufacturer: Martin
    model: MAC Aura
    mode: Standard
    universe: 1
    address: 1
    stage: {x: 2000, y: 500, z: 4000, rotation: 180, invertTilt: true}

functions:
  - name: Azul frontal
    type: Scene
    values:
      - {fixture: Cabeza L, channel: Dimmer, value: 255}
      - {fixture: Cabeza L, channel: Blue, value: 255}

  - name: Persecución
    type: Chaser
    steps:
      - {function: Azul frontal, fadeIn: 500, hold: 2000, fadeOut: 500}
```

Cuatro cosas que hay que saber de él, y de las cuatro cuelga todo lo demás:

**Se direcciona por nombre, nunca por id.** Los ids los reparte el motor, así
que un documento que hablase de ellos solo se podría aplicar sobre el proyecto
del que salió. Los canales, igual: `channel: Dimmer` sobrevive a un cambio de
modo y se lee; `channel: 6` no sobrevive a nada. (Si el perfil tiene dos canales
con el mismo nombre, el exportador escribe el número, porque ahí el nombre
mentiría.)

**Se valida entero antes de tocar nada.** Un documento que nombra una fixture
que no existe, una función repetida o un plugin que esta máquina no tiene se
rechaza completo, diciendo los problemas todos de golpe. Aplicar la mitad de un
show deja un proyecto del que nadie sabe qué mitad está mirando.

**Aplicarlo dos veces no hace nada la segunda.** Cada sección se compara con lo
que hay y solo se escribe la diferencia.

**Lo que no menciona no se borra.** Un documento parcial es lo normal —describes
las escenas y no el patch—, e interpretar el silencio como «borra el resto» es
perder un show por omisión. `--prune` pide explícitamente lo contrario.

Ensaya siempre primero:

```bash
node mcp/dist/cli.js diff show.yaml
```

Hay un ejemplo completo y comprobado en
[`docs/api/ejemplo-show.yaml`](docs/api/ejemplo-show.yaml): cuatro pares de LED
colocados en el escenario, un dímer genérico, dos escenas y un chaser que las
encadena, todo desde cero sobre una mesa vacía.

> **Lo que el documento no lleva**, dicho aquí y no escondido: el cuerpo de un
> Show. Una timeline son posiciones absolutas que no se reconcilian por nombre
> sin inventarle una identidad a cada barra. Un Show se exporta como función,
> con sus tiempos, y sus pistas se quedan donde están — se editan por REST.

---

## Levantar la mesa

```bash
# Instalada
orchidlightsd tonight.qxw

# Desde el árbol de fuentes, sin ventana
QT_QPA_PLATFORM=offscreen ./build/server/src/orchidlightsd tonight.qxw

# Sin sacar DMX a la red: para probar cosas sin encender una sala
orchidlightsd --no-output --port 9998 tonight.qxw
```

Escucha en `http://127.0.0.1:9998`, y todo lo que sigue da por hecho:

```bash
BASE=http://127.0.0.1:9998/api/v1
```

**Usa `--no-output` mientras experimentes.**
Un daemon con salida ArtNet abierta enciende lo que haya enchufado en cuanto le
escribes un canal, y no siempre hay alguien mirando la sala.

**El token.** En loopback no hace falta ninguno: el sistema operativo ya es la
frontera. `--listen-all` abre el daemon a la red y activa el token
automáticamente:

```bash
TOKEN=$(cat ~/.orchidlights/api-token)
curl -H "Authorization: Bearer $TOKEN" http://mesa.local:9998/api/v1/status
```

Incluso en loopback, las rutas que llegan al disco o apagan el proceso
(`/project/open`, `/project/save-as`, `/shutdown`, `PUT /access`) lo exigen
siempre.

---

## Empieza por aquí

```bash
curl -s http://127.0.0.1:9998/api/v1
```

Contesta qué es esto, si hace falta token, qué áreas están abiertas y dónde
está el contrato completo. **Contesta sin token a propósito**: un cliente que
tiene que autenticarse para enterarse de que tiene que autenticarse es un
cliente que adivina.

El contrato entero —137 operaciones, con la forma de cada petición y cada
respuesta— está en `GET /api/v1/openapi.json`, servido por el propio daemon, y
en `docs/api/openapi.yaml` en el repositorio. **Léelo antes de inventarte una
ruta.** `server/test/openapi-smoke.sh` lo compara con la tabla de rutas real en
CI, en los dos sentidos, así que lo que dice es lo que hay.

---

## Las siete reglas que no se ven

Esto es lo que un cliente nuevo hace mal. Ninguna de las siete da un error
evidente; todas dan un show que parece bien y no lo está.

**1. Los identificadores no se eligen, se descubren.** `Doc` reparte el hueco
libre más bajo. Creas la función y la respuesta te dice qué id le tocó. No
supongas que el id 5 seguirá siendo el id 5 después de borrar el 3.

**2. Nada se guarda solo.** Toda edición vive en memoria hasta
`POST /api/v1/project/save`. Un agente que construye un show entero y no llama a
eso no ha construido nada que sobreviva al daemon.

**3. Los universos y las direcciones DMX empiezan en 1; los canales dentro de
una fixture, en 0.** No es un descuido: 1 es lo que va impreso en el foco y lo
que teclea un operador, y 0 es el desplazamiento desde la dirección base. La
conversión ocurre en un único sitio del daemon. Un fallo aquí desplaza el rig
entero un canal y el color sale mal en todo.

**4. Los nombres de plugin y de línea salen de `GET /api/v1/io`, literales.**
Patchear a `"Art-Net"` cuando el plugin se llama `"ArtNet"` no da error: da un
universo sin salida, y eso no se ve hasta que no se enciende nada.

**5. Un canal es un número distinto en cada modo.** «Dimmer» es el 6 en un modo
y el 8 en otro. `GET /api/v1/fixtures/{id}` los nombra; la lista no. Léelo antes
de escribir valores en una escena.

**6. Los proyectos de QLC+ 4 no tienen identificadores de widget**, y toda
edición de consola direcciona por id. Esos proyectos no son *parcialmente*
editables: no lo son en absoluto. `POST /api/v1/vc/widgets/ids` se los asigna
sin tocar nada más.

**7. Arrancar una función no es una edición.** El anillo de undo cubre el
documento, no el estado de ejecución ni la mesa en vivo. `POST /api/v1/undo` no
va a parar un chaser.

**Y una que se aprende cara:** un cuerpo JSON con un campo mal nombrado **no da
error**. El daemon lo parsea, no encuentra la clave que buscaba y sigue. Manda
`background`, no `backgroundColor`; `functionId`, no `function`; `fixture`, no
`universe`. Consulta el contrato antes de inventarte un nombre — la spec del
repositorio se comprueba campo a campo contra los handlers en CI, así que lo que
dice es lo que el código lee.

---

## El camino dorado: un show de cero

### 1. Elige los focos antes de patchear

```bash
curl -s "$BASE/library?q=martin" | jq
curl -s "$BASE/library/Martin/MAC%20Aura" | jq '.modes'
```

El nombre del modelo y el del modo van **exactos**, tal y como los lista la
librería: es `MAC500`, no `MAC 500`. Y **el número de canales del modo es lo que
decide el patch**: patchear con el modo equivocado da un rig que se enciende y
no obedece.

### 2. Mira dónde cabe

```bash
curl -s "$BASE/universes/1/map" | jq '{used, free, fixtures}'
```

Dos fixtures en la misma dirección es un fallo que no se ve hasta que se
enciende la sala.

### 3. Patchea

```bash
curl -s -X POST "$BASE/fixtures" -H 'Content-Type: application/json' -d '{
  "manufacturer": "Martin", "model": "MAC Aura", "mode": "Standard",
  "universe": 1, "address": 1, "quantity": 6, "gap": 0
}'
```

`quantity` con `gap` patchea la tira entera de una vez, que es como se patchea
un rig de verdad.

### 4. Saca el DMX y mete el control

```bash
curl -s "$BASE/io" | jq            # los nombres exactos, literales

curl -s -X PATCH "$BASE/universes/1" -H 'Content-Type: application/json' -d '{
  "output": {"plugin": "ArtNet", "line": "eth0"},
  "input":  {"plugin": "MIDI", "line": "BCF2000", "profile": "Behringer BCF2000"},
  "feedback": {"plugin": "MIDI", "line": "BCF2000"}
}'
```

El `profile` es lo que le da sentido a las notas y los CC de un ala MIDI; sin él
llegan números sin nombre. El `feedback` es lo que mueve los faders motorizados
de vuelta.

### 5. Coloca el rig en el escenario

```bash
curl -s -X PUT "$BASE/plan/grid" -H 'Content-Type: application/json' \
  -d '{"width": 12, "height": 6, "depth": 8, "units": "meters"}'

curl -s -X PUT "$BASE/plan/fixtures/4" -H 'Content-Type: application/json' \
  -d '{"x": 2000, "y": 500, "z": 4000, "rotation": 180, "invertTilt": true}'
```

**La rejilla va en unidades y las posiciones en milímetros contra ella**: un
escenario mide 12 de ancho, no 12000, y un lado mide entre 1 y 1000. Grados en
las rotaciones. Un foco colgado boca
abajo se apunta invirtiendo un eje; ignorarlo lo manda al techo. Se guarda en el
`<Monitor>` de QLC+, así que el plano abre igual en el escritorio.

### 6. Escenas

Dos formas, y la segunda es mejor de lo que parece:

```bash
# Canal a canal
curl -s -X POST "$BASE/functions" -H 'Content-Type: application/json' \
  -d '{"type": "Scene", "name": "Azul frontal"}'
curl -s -X POST "$BASE/functions/12/values" -H 'Content-Type: application/json' \
  -d '{"fixture": 4, "channel": 6, "value": 255}'

# O monta el look en el rig y vuélcalo
curl -s -X PUT "$BASE/live" -H 'Content-Type: application/json' \
  -d '{"values": [{"fixture": 4, "channel": 6, "value": 255}]}'
curl -s -X POST "$BASE/dump" -H 'Content-Type: application/json' \
  -d '{"name": "Azul frontal"}'
```

`/live` **no es una edición**: no toca el documento y no sobrevive a una
recarga. Es para montar el look; `/dump` es lo que lo convierte en escena.

### 7. Chasers y consola

```bash
curl -s -X POST "$BASE/functions/13/steps" -H 'Content-Type: application/json' \
  -d '{"function": 12, "fadeIn": 500, "hold": 2000, "fadeOut": 500}'

curl -s -X POST "$BASE/vc/widgets" -H 'Content-Type: application/json' \
  -d '{"type": "Button", "parent": 1}'
curl -s -X PATCH "$BASE/vc/widgets/1042" -H 'Content-Type: application/json' \
  -d '{"caption": "Azul", "functionId": 12, "action": "toggle", "background": "#1e3a8a"}'
```

Los colores no son decoración: una botonera donde todo es gris es una botonera
que nadie puede usar a oscuras.

### 8. Guarda

```bash
curl -s -X POST "$BASE/project/save"
```

---

## Comprueba tu propio trabajo

Esto es lo que separa configurar de adivinar:

```bash
curl -s -X POST "$BASE/functions/12/start"
curl -s "$BASE/universes/1/dmx" | jq '.active'
```

```json
[{"channel": 6, "value": 255, "fixture": 4, "fixtureName": "Cabeza L", "channelName": "Dimmer"}]
```

Son los valores **después del grand master**, que es lo que reciben las
lámparas. Si `active` sale vacío con una función corriendo, algo de la cadena
está mal — y ahora sabes que lo está antes de que lo descubra el operador.

Comprueba también lo que no debería haber pasado:

- `GET /api/v1/status` → `runningFunctions`, `blackout`
- `GET /api/v1/functions/{id}/usage` → quién depende de una función, **antes**
  de borrarla. Borrar una que usa un chaser contesta 409 y te dice con qué
  choca; `?force=true` la borra igualmente.

Si te has equivocado: `POST /api/v1/undo`. El anillo guarda ~200 ediciones.

---

## Trabajar en el código de OrchidLights

```
engine/     motor de tiempo real heredado de QLC+ — no se toca
plugins/    salidas DMX heredadas de QLC+ — no se toca
resources/  1.735 perfiles de fixture heredados — no se toca
server/     el daemon: API REST, WebSocket, escritura del documento
web/        SPA React 19 + Vite + TypeScript (three.js para la 3D)
desktop/    carcasa Tauri
mcp/        el servidor MCP, el CLI y el motor del documento declarativo
docs/api/   el contrato OpenAPI
```

```bash
./install-deps.sh
cmake -S . -B build -G Ninja -Dserver=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build

cd web && pnpm install && pnpm verify    # biome + vitest + tsc + build
cd mcp && pnpm install && pnpm verify

server/test/api-smoke.sh build/server/src/orchidlightsd
server/test/openapi-smoke.sh build/server/src/orchidlightsd
server/test/spec-smoke.sh build/server/src/orchidlightsd
```

Lo que hay que saber antes de tocar el daemon:

- **El formato `.qxw` no se toca.** Un show creado en QLC+ abre aquí y al revés.
  Hay shows en producción de por medio. `server/test/roundtrip-smoke.sh` lo
  comprueba.
- **Toda ruta nueva se documenta en `docs/api/openapi.yaml`** y se regenera con
  `python3 docs/api/generate.py`. Si no, `openapi-smoke.sh` rompe el build — a
  propósito: una spec que miente es peor que ninguna. Y no basta con acertar la
  ruta: el test compara **campo a campo** los cuerpos documentados con los que
  el handler lee, y **tipo a tipo** las respuestas de un daemon de verdad contra
  lo que la spec promete, valores de enum incluidos.
- **Lo que lee una ruta tiene que ser lo que escribe la contraria.** Si `GET`
  devuelve la geometría anidada, el `PUT` la acepta anidada; si `GET` emite
  `default`, el `PATCH` lo admite o el `GET` no lo emite. Sin esa simetría un
  cliente no puede hacer ida y vuelta con un proyecto, que es de lo que cuelga
  todo `mcp/`.
- **Cada handler repite su comprobación de autorización**, no hay middleware en
  el QHttpServer de Qt 6.4. Un `grep` los encuentra todos; una ruta que se
  olvida es un fallo que solo aparece cuando hay alguien más en la red.
- **Toda ruta que muta lleva un `UndoGuard`** y un `UNDO_COMMIT()` en cada
  camino de éxito.
- Los comentarios del código van **en inglés**; la documentación, el ROADMAP y
  los mensajes de commit, **en español**.
- Nunca añadas atribución a la IA en commits ni en pull requests.
