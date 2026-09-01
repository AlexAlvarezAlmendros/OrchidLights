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
  -d '{"width": 12000, "height": 6000, "depth": 8000, "units": "meters"}'

curl -s -X PUT "$BASE/plan/fixtures/4" -H 'Content-Type: application/json' \
  -d '{"x": 2000, "y": 500, "z": 4000, "rotation": 180, "invertTilt": true}'
```

Milímetros contra la rejilla, grados en las rotaciones. Un foco colgado boca
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
docs/api/   el contrato OpenAPI
```

```bash
./install-deps.sh
cmake -S . -B build -G Ninja -Dserver=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build

cd web && pnpm install && pnpm verify    # biome + vitest + tsc + build
server/test/api-smoke.sh build/server/src/orchidlightsd
server/test/openapi-smoke.sh build/server/src/orchidlightsd
```

Lo que hay que saber antes de tocar el daemon:

- **El formato `.qxw` no se toca.** Un show creado en QLC+ abre aquí y al revés.
  Hay shows en producción de por medio. `server/test/roundtrip-smoke.sh` lo
  comprueba.
- **Toda ruta nueva se documenta en `docs/api/openapi.yaml`** y se regenera con
  `python3 docs/api/generate.py`. Si no, `openapi-smoke.sh` rompe el build — a
  propósito: una spec que miente es peor que ninguna.
- **Cada handler repite su comprobación de autorización**, no hay middleware en
  el QHttpServer de Qt 6.4. Un `grep` los encuentra todos; una ruta que se
  olvida es un fallo que solo aparece cuando hay alguien más en la red.
- **Toda ruta que muta lleva un `UndoGuard`** y un `UNDO_COMMIT()` en cada
  camino de éxito.
- Los comentarios del código van **en inglés**; la documentación, el ROADMAP y
  los mensajes de commit, **en español**.
- Nunca añadas atribución a la IA en commits ni en pull requests.
