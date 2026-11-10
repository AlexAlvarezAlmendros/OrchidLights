# F11 — Rediseño: una mesa que se entiende a oscuras

> Fecha: 2026-11-09. Estado: **ejecutado en código (R1–R7)**; queda la prueba
> con personas de R0 y R7. Rama de partida: `asistente-montaje` @ `644572e4b`.
> Lo hecho, lo que cambió por el camino y lo pendiente, en §14.
> Alcance: `web/` entero. **No se tocan** el formato `.qxw`, la API ni la
> semántica del modo operador y del kiosko.

---

## 0. En una frase

Llevar la interfaz a lo que Apple llama *jerarquía, armonía y coherencia* sin
perder lo que la hace una mesa de luces: que se maneja de reojo, a oscuras y
con prisa. Se hace en ocho fases pequeñas, y cada una se puede publicar sola.

Lo «estilo Apple» que se busca **no es el cristal ni las esquinas
redondeadas**. Es esto:

1. **Una cosa importante por sitio, y siempre en el mismo sitio.**
2. **Lo raro, detrás.** Lo frecuente, a un toque.
3. **Un sistema, no decisiones sueltas.** Una escala de tipo, una rejilla de
   espaciado, tres radios y unos colores con significado fijo.
4. **Respuesta inmediata y que se puede interrumpir.**
5. **Deshacer antes que preguntar.**

---

## 1. Lo que hay hoy, medido

Medido sobre `17Julio.qxw` (22 fixtures, 20 funciones) con el daemon en
`--no-output`, en Chrome a 1440 px y a 390 px, con el tema de escena y con el
de pase.

| # | Hallazgo | Medida | Por qué importa |
|---|---|---|---|
| 1 | **La barra inferior del móvil tiene 10 elementos**: las 8 vistas, más «Oscuro» y «Ajustes» | Cada uno mide **34 px de ancho**. Las etiquetas van a **10,56 px** y se pisan («FuncionesPatch», «PlantaEscenario») | La HIG pide cinco pestañas o menos, nada de acciones en la barra de pestañas y un mínimo de 44 pt |
| 2 | **La barra del show junta cinco cosas sin agrupar**: identidad, estado, modos, documento, tempo y emergencia | 14 controles en una fila. En el móvil ocupa **224 px de 740 (30 %)** antes de que aparezca un solo botón del show | La HIG de barras de herramientas recomienda tres grupos como máximo |
| 3 | **No hay escala tipográfica** | **20 tamaños de letra** distintos, casi todos entre 11,2 y 13,6 px. **18 radios** y **71 paddings** distintos | Sin escala no hay jerarquía: todo pesa lo mismo y nada se lee primero |
| 4 | ~~La mitad de la pantalla de escritorio, vacía~~ **Corregido al ejecutar:** la captura era de una ventana de 2560 px CSS, no de 1440. A 1440 la consola usa bien el ancho. Lo que sí estaba mal es Funciones: el editor se abría **debajo de la última fila**, a un scroll de la fila tocada | — | El plan mantuvo la vista dividida de Funciones por esa razón, no por el espacio |
| 5 | **El estado «en marcha» se ve poco** | Un punto de **8 px** con brillo, más un tinte verde del **9 %** | Desde la distancia de un brazo, en cabina, no se distingue lo que suena de lo que no |
| 6 | **El color del show es una raya de 8 px** | El ROJO y el AZUL de la consola son una tira lateral oscura | El operador eligió esos colores para encontrar el botón a oscuras, y casi no se ven |
| 7 | **Las acciones destructivas están a la vista y a un toque** | «Eliminar» en rojo en cada tarjeta de universo. `window.confirm()` y `window.prompt()` en **6 sitios** | El sistema dibuja esos diálogos fuera del tema. En un escritorio con tema claro son un rectángulo blanco en mitad de un pase |
| 8 | **El mismo tema tiene dos nombres** | En el raíl, «Oscuro» activa el modo seguro. En Ajustes, «Oscuro» es el modo seguro y «Pase» es el normal | Es justo al revés que en el raíl. Nombrar mal un modo es la receta de un error de modo |
| 9 | **Iconos que son letras** | Volcar es `⭳` y se ve como **«!»**. Deshacer y rehacer son `↶` y `↷` | `nav.tsx` ya explica por qué un carácter es un dibujo distinto en cada sistema. Esto le lleva la contraria |
| 10 | **Los diálogos no se cierran con Escape** | Ajustes y el menú del proyecto son `<dialog open>`, no modales: ni Escape, ni foco atrapado | La HIG pide cancelar siempre con teclado |
| 11 | **Contraste por debajo del mínimo** | Texto secundario del pase: **2,66:1**. Acento violeta sobre superficie: **4,09:1** (es el color de la etiqueta de la vista activa). Bordes de las tarjetas: **1,32:1** | El mínimo es 4,5:1 para texto y 3:1 para el borde de un control |
| 12 | **Las preferencias del sistema se ignoran** | Cero reglas para `prefers-reduced-motion`, `prefers-contrast` o `forced-colors`. **84 `<select>` nativos** | En la carcasa de Linux, el menú de un `<select>` lo dibuja GTK, fuera del tema de pase |
| 13 | **Los errores se borran solos** | El aviso desaparece a los 6 s (`App.tsx:291`) | Un error que se va solo durante un cue es un error que nadie ha leído |
| 14 | **Crear compite con usar** | En Funciones, el formulario de creación va abierto encima de la lista | Casi siempre se viene a buscar y lanzar, no a crear |

**Lo que funciona y se queda**, porque el rediseño no empieza de cero:

- Las cifras tabulares (`.num`), que no bailan cuando cambia el valor.
- El suelo de 44 px en los widgets, y el tema de pase como idea.
- El raíl que se convierte en barra inferior según el ancho, con el mismo
  marcado.
- Los iconos de trazo único sobre una rejilla de 24 (`nav.tsx`).
- El modo operador sin navegación.
- El respeto a los colores que eligió el diseñador del show.
- Que un widget en modo ordenar no dispare su función.
- Los flashes que se sueltan aunque el dedo resbale.

---

## 2. Lo que dicen las guías y los estudios

| Fuente | Qué dice | Qué hacemos con ello |
|---|---|---|
| **Apple HIG, Dark Mode** | Hay dos juegos de fondo: *base*, que se retira, y *elevated*, para lo que flota encima. Contraste de 4,5:1 como mínimo y de 7:1 para texto pequeño. Una app solo oscura es un caso «raro», propio de los medios inmersivos | La profundidad se hace con fondos más claros, no con sombras. Una mesa de luces encaja en ese caso «raro»: nada de tema claro en la sala |
| **Apple HIG, Color** | Un color, un significado. Nunca solo color. En un entorno oscuro los colores se ven más brillantes y saturados | Verde es «suena», rojo es «peligro» y el violeta es selección o foco. Cada estado lleva además una forma o un icono. La paleta, desaturada |
| **Apple HIG, Typography** | Cuerpo de 17 pt y mínimo de 11 en iOS. Cuerpo de 13 y mínimo de 10 en macOS. Once estilos, de Large Title (34/41) a Caption 2 (11/13). Pesos de Regular a Bold, nunca Light | Una escala de once pasos sustituye a los 20 tamaños. Nada de lo que se opera baja de 12 px |
| **Apple HIG, Layout** | Lo importante, arriba y al principio. Agrupar con espacio, no con cajas. La disposición la decide la clase de tamaño (compacta o regular), no el aparato. La misma funcionalidad en todos los tamaños | Dos clases de tamaño y no tres anchos. Nada desaparece en el móvil: se mueve |
| **Apple HIG, Tab bars y Sidebars** | Una barra de pestañas para cinco secciones o menos, sin pestaña «Más» y sin acciones. Una barra lateral cuando hay sitio, con dos niveles como mucho y la opción de ocultarla | Barra lateral con dos grupos en pantalla ancha. Cinco pestañas en el móvil |
| **Apple HIG, Toolbars** | Tres grupos como máximo. Una sola acción destacada. Iconos en vez de texto, salvo verbos como «Editar» | La barra del show pasa a tres grupos fijos |
| **Apple HIG, Sheets y Alerts** | Una hoja para una tarea acotada. No se avisa de lo que se puede deshacer. Una alerta solo para lo irreversible y poco frecuente. Cancelar nunca es el botón por defecto | Crear, emparejar e importar van en hojas. Borrar se deshace con un aviso |
| **Apple HIG, Materials** | El cristal, solo en la capa de controles y navegación, nunca en el contenido. Con moderación | Cristal en la barra, en las pestañas y en los controles que flotan sobre la planta. En ningún otro sitio |
| **Apple HIG, Accessibility** | Controles de 44×44 pt y 28×28 como mínimo. Unos 12 pt de aire alrededor de un control con borde. Texto a 200 % sin romperse | Esas cifras son los mínimos del sistema de diseño |
| **Apple HIG, Sliders** | El mínimo abajo y el máximo arriba. Respuesta en vivo. Etiquetas en los extremos | Los faders ya lo cumplen. Se añaden marcas al 0, 50 y 100 % |
| **Apple, *Designing Fluid Interfaces* (WWDC 2018)** | Una interfaz responde al instante, se puede interrumpir y redirigir, y usa muelles en lugar de curvas fijas | Animaciones de muelle que se pueden interrumpir, y nunca en el camino del DMX |
| **NN/g, *Flat UI Elements Attract Less Attention* (2017)** | Con señales de interactividad débiles se mira la página un **22 % más** y se fijan un **25 % más** los ojos | «Estilo Apple» no quiere decir plano. Un botón tiene que parecer un botón, y más a oscuras |
| **Nielsen, *Response Times: The 3 Important Limits*** | Por debajo de **0,1 s** la mano siente que manipula. Por debajo de **1 s** no se pierde el hilo | El botón se ilumina al tocarlo, sin esperar al daemon. Las transiciones de pantalla, por debajo de 250 ms |
| **Parhi, Karlson y Bederson (MobileHCI 2006)** | Con el pulgar y una sola mano, **9,2 mm** bastan para un objetivo suelto y **9,6 mm** para una serie | En un móvil 9,6 mm son unos 60 px CSS. Los botones del modo operador en el teléfono miden **≥ 60 px**, no 44 |
| **NN/g, *Dark Mode vs. Light Mode*** (Dobres, Piepenbrock) | Con luz normal, el texto oscuro sobre fondo claro se lee mejor, y la ventaja crece cuanto más pequeña es la letra | En la sala manda el oscuro. Si el oscuro cuesta más leer, la respuesta es **letra más grande**, no más brillo |
| **Rempel, Mantiuk y Heidrich, *Display Considerations for Improved Night Vision Performance* (UBC)** | La luz roja la ven los conos y casi no los bastones, y es la que menos deslumbra. Una pantalla para la oscuridad debe dar poca luz a los bastones y la suficiente a los conos, porque con los bastones no se lee texto fino. El texto claro sobre fondo oscuro rinde más que al revés. El primario rojo de sRGB está entre 620 y 640 nm | El pase usa **solo el primario rojo**. La jerarquía se hace con tamaño y peso, no con rojos tenues, y la letra sube un paso |
| **Kurosu y Kashimura (CHI 1995)** | La facilidad de uso que se percibe va unida a la estética (r = 0,589, 26 diseños de cajero) | La estética importa, pero es correlación y no causa. Por eso hay que medir antes y después |
| **Raskin, *The Humane Interface*; A. Raskin, *Never Use a Warning When You Mean Undo*** | El hábito convierte un diálogo de confirmación en un clic automático. Los modos provocan errores, y un cuasimodo (algo que dura mientras se mantiene pulsado) es más seguro | Deshacer en vez de confirmar. El modo de la consola, siempre a la vista, con un solo control |
| **NN/g y Nielsen, *Progressive Disclosure*** | Lo que se ve primero es lo que se entiende como importante. Se separa por frecuencia de uso, no por nivel de quien usa | Lanzar a un toque. Crear, en una hoja. Los ajustes del motor, detrás de «Avanzado» |
| **Endsley, *Designing for Situation Awareness*** | Organizar la información por objetivos. Que se entienda de un vistazo lo que pasa | Arriba a la derecha, siempre lo mismo: qué suena, el GM y el blackout. Lo normal, discreto. Lo anómalo, grande |
| **Merchel, Altinsoy y Stamm (AES 2010)** | La respuesta física de faders y botones es la razón principal de que las pantallas táctiles casi no se usen para mezclar. Un fader táctil no se maneja sin mirar | En pantalla, el fader se arrastra en relativo y no salta al punto que se toca (ver §8) |

**Una nota de licencia.** SF Pro y SF Symbols solo se pueden usar en las
plataformas de Apple, así que no se empaquetan. En Apple, la pila `system-ui`
ya los muestra. En Linux y Windows se usa **Inter** (OFL), que se sirve desde
el propio daemon porque en una sala no hay internet. Los iconos siguen siendo
los propios, de un solo trazo.

---

## 3. Principios

Son los que deciden cada discusión de las fases que siguen.

1. **El color es estado o es del show. Nunca adorno.** La interfaz es gris.
   Lo que tiene color es lo que suena, lo que está en peligro, lo que está
   elegido y los colores que eligió el diseñador.
2. **Se lee de reojo a un metro.** Un estado importante ocupa superficie (una
   tarjeta entera que se ilumina), no un punto.
3. **La emergencia no se mueve nunca.** GM, Parar todo y Blackout, arriba a la
   derecha, en todas las pantallas y en todos los tamaños. Ahí están hoy, así
   que la memoria espacial de quien ya usa la mesa no se rompe.
4. **Lo raro, detrás. Lo frecuente, a un toque.** Por frecuencia de uso, no
   por perfil.
5. **Deshacer antes que preguntar.** Una alerta solo para lo que de verdad no
   se puede deshacer, como cerrar sin guardar.
6. **Nada blanco en la sala.** Ningún diálogo, menú, barra de scroll ni anillo
   de foco del sistema se cuela en el tema de pase.
7. **Responde en menos de 0,1 s y se deja interrumpir.** Nada se anima entre
   el dedo y el DMX.

---

## 4. Sistema de diseño

Todo vive en `theme.css` como variables, con un archivo nuevo de tokens al
principio. Ningún componente escribe un color, un tamaño o un radio a mano.

### 4.1 Color: roles en vez de valores

Los nombres siguen los roles de Apple, para que cada valor diga para qué sirve:

| Rol | Escena | Para qué |
|---|---|---|
| `--bg-base` | `#0b0c0f` | Fondo de la pantalla |
| `--bg-elevated-1` | `#15171c` | Tarjetas y listas |
| `--bg-elevated-2` | `#1e2128` | Hojas, menús y lo que flota encima |
| `--fill-1…4` | blanco al 18/14/10/6 % | Fondo de los controles, de más a menos peso |
| `--label-1…4` | blanco al 92/62/40/24 % | Texto principal, secundario, terciario y desactivado |
| `--separator` | blanco al 12 % | Líneas. **Nunca texto** |
| `--tint` | violeta orquídea, ajustado a ≥ 4,5:1 | Selección y foco. Solo eso |
| `--live` | verde | Suena |
| `--armed` | ámbar | Pulsado y a la espera del daemon, aprendiendo MIDI o grabando |
| `--danger` | rojo | Blackout, borrar y errores |

- **Contraste**: 4,5:1 como mínimo y 7:1 en texto de menos de 13 px. Lo
  comprueba un test (`tokens.test.ts`) que calcula el contraste de cada pareja
  de tokens en los dos temas. Así, ningún cambio de color lo rompe sin que se
  entere la CI. Es la misma cultura que `openapi-smoke.sh`: lo que se promete,
  se comprueba.
- **`prefers-contrast: more`**: cada rol tiene una variante de más contraste.
  Los bordes de las tarjetas pasan de 1,32:1 a ≥ 3:1.
- **Profundidad**: con `--bg-elevated-*`, no con sombras, que a oscuras no se
  ven.

### 4.2 Tipografía

| Estilo | Tamaño/interlínea (px) | Uso |
|---|---|---|
| Large Title | 34/41 · 700 | Título de pantalla en compacto |
| Title 1 | 28/34 · 700 | Nombre del show |
| Title 2 | 22/28 · 650 | Título de hoja |
| Title 3 | 20/25 · 600 | Marco de la consola (sustituye a «— MAESTRO —») |
| Headline | 17/22 · 600 | Texto de los botones del show |
| Body | 17/22 · 400 | Texto en táctil |
| Callout | 15/20 · 400 | Texto en escritorio (la densidad de macOS) |
| Subhead | 15/20 · 500 | Etiquetas de campo |
| Footnote | 13/18 · 400 | Subtítulos y metadatos |
| Caption 1 | 12/16 · 500 | Etiquetas de pestaña. **El mínimo de lo que se opera** |
| Caption 2 | 11/13 · 500 | Solo lo prescindible, como versiones o ids |

- Todo en `rem`, para que **Ajustes > Escala** (que ya cambia el `font-size`
  de la raíz) y el zoom del navegador escalen la interfaz entera.
- **Sin mayúsculas forzadas ni tracking abierto** en los títulos. Las
  mayúsculas se quedan donde el show las escribió.
- Las cifras usan `font-variant-numeric: tabular-nums` **con la misma familia**
  que el texto. La monoespaciada queda para la línea de comandos de la Mesa.
- Pila: `-apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif`,
  con Inter variable servido en local (unos 110 kB en woff2).

### 4.3 Espacio, forma y capas

- **Rejilla de 4 px**: los tokens son `--space-1` a `--space-8` (4, 8, 12, 16,
  20, 24, 32 y 44) y sustituyen a los 71 paddings.
- **Tres radios** y uno de píldora: 8 (controles pequeños), 12 (botones y
  tarjetas del show), 20 (hojas y paneles) y 999. **Radios concéntricos**: el
  radio interior es el exterior menos el padding, que es lo que hace que una
  tarjeta dentro de un panel parezca de una pieza.
- **Material** (`--material-bar`): fondo translúcido con
  `backdrop-filter: blur(20px) saturate(160%)`. Solo en la barra del show, en
  la barra lateral y la de pestañas, en las hojas y en los controles que
  flotan sobre la Planta y el Escenario. Será **opaco** con
  `prefers-reduced-transparency`, en el tema de pase y si el aparato no da 60
  fps (ver §10).

### 4.4 Movimiento

| Token | Valor | Para qué |
|---|---|---|
| `--dur-press` | 80 ms | Estado pulsado |
| `--dur-fast` | 150 ms | Menús, avisos y estados |
| `--dur-base` | 250 ms | Hojas y barra lateral |
| `--ease-spring` | `linear()` que aproxima un muelle con amortiguación crítica | Lo que se desplaza |

- Cada animación se interrumpe si llega otro toque. Las hojas siguen al dedo.
- **No se anima**: el valor de un fader, un nivel, el estado de una función
  ni el GM. Son el DMX y van al instante.
- Con `prefers-reduced-motion`, los desplazamientos se vuelven fundidos y los
  muelles se acortan.

### 4.5 Iconos

Un solo `Glyph` (el de `nav.tsx`, sacado a `icons.tsx`) para **todos** los
iconos: deshacer, rehacer, volcar, play, stop, chevrones, más, ajustes y
compartir. Se acaban los iconos que son caracteres de texto.

---

## 5. Arquitectura de la información

Hoy hay ocho vistas planas y dos acciones mezcladas con ellas. Se ordenan por
**objetivo** (Endsley) y por **frecuencia** (Nielsen):

```
DIRECTO            MONTAJE                SISTEMA
  Consola            Funciones              Ajustes
  Mesa               Patch                    · Apariencia (tema, escala)
  Planta             Escenario 3D             · Idioma
                                              · Dispositivos  ← hoy, «Remoto»
ASISTENTE (en todas partes)                   · Asistente
                                              · Acerca de
```

**En pantalla ancha (regular)** hay una barra lateral con dos grupos,
«Directo» y «Montaje», y el Asistente debajo. Se puede ocultar (⌘/Ctrl+B) y
recuerda su estado. Ajustes va en la barra del show, como icono.

**En pantalla estrecha (compacta)** hay cinco pestañas:

```
[ Consola ]  [ Mesa ]  [ Planta ]  [ Montaje ]  [ Asistente ]
```

«Montaje» es una portada al estilo de la de Ajustes de iOS, con tres filas
(Funciones, Patch y Escenario) que llevan cada una su resumen («20 funciones»,
«22 fixtures en 4 universos»). No es una pestaña «Más»: es una sección con
nombre, y nada se pierde en el móvil.

**El tema sale de la navegación.** Pasa a Ajustes > Apariencia, a un atajo
(Ctrl+Alt+P) y a un interruptor dentro del menú del show. Se llama
**«Pase»** en todas partes. Los otros tres (§14, 2026-11-10) se nombran por la
luz de la sala: **Claro**, **Gris** y **Oscuro**.

**El modo operador** se queda como está: sin navegación.

---

## 6. La barra del show: tres grupos fijos

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 17Julio ● ▾          │   Tocar | Ordenar | Editar    ↶ ↷   │  GM 100  ■ PARAR TODO  ● BLACKOUT │
│ identidad y estado   │   modo y documento (según vista)   │  directo, siempre aquí            │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Izquierda, identidad**: el nombre del show con su menú (Nuevo, Abrir,
  Guardar, Guardar como, Importar y el interruptor de Pase). «Sin guardar» es
  un punto al lado del nombre, como en macOS. Las 22 fixtures pasan al menú.
  **La conexión no ocupa sitio cuando va bien.** Cuando se cae, sale una
  franja roja a todo lo ancho, «Sin conexión con la mesa · reintentando», que
  no se puede pasar por alto. Lo normal, discreto. Lo anómalo, grande.
- **Centro, lo de cada pantalla**: en la Consola, un **control segmentado**
  `Tocar | Ordenar | Editar`, que es un solo control con el modo siempre a la
  vista. Sustituye a los botones «Ordenar», «Editar» y «Listo · editando». Al
  lado, deshacer y rehacer como iconos. «Guardar» aparece solo si hay algo
  que guardar, como la única acción destacada. «Volcar» se convierte en una
  píldora con nombre, **«Volcar 12»**, que solo sale cuando hay algo sujeto.
- **Derecha, directo**: GM, BPM/TAP (compacto: el número es el botón de tap,
  y una pulsación larga lo edita), **Parar todo** y **Blackout**. Siempre en
  el mismo orden y en el mismo sitio.

**En el móvil** la barra cabe en una fila de 52 px (nombre, GM y Blackout), y
el resto del directo pasa a una **barra accesoria sobre las pestañas**, el
patrón del minirreproductor de iOS: `TAP 120 · PARAR TODO`. Pasa de **224 px
a unos 104 px** entre las dos.

---

## 7. Pantalla por pantalla

### Consola (la pantalla que importa)

- **Tarjetas en una rejilla de columnas fijas**, con tres tamaños (S, M y L)
  alineados a la rejilla. Sustituyen a las cajas de 8rem que refluyen, y usan
  todo el ancho.
- **Parada**: superficie elevada, con el color del show como **canto superior
  de 4 px y como tinte del 12 %** en toda la tarjeta, no como una raya.
- **En marcha**: la tarjeta se **llena** con el color del show al 55 %, con el
  texto en contraste y un icono ▶ en la esquina. Si el botón no tiene color,
  se llena de `--live`. Es superficie, color e icono a la vez, y se lee desde
  la otra punta de la cabina. La pantalla imita además lo que hace el rig: el
  rojo que suena se ve rojo.
- **Pulsado y esperando al daemon**: canto `--armed` desde el *pointerdown*,
  en menos de 0,1 s. Si el daemon lo rechaza, vuelve a su estado y sale un
  aviso.
- **Títulos de marco** en Title 3, con su caption del show en Footnote
  secundario. Se acabaron «— MAESTRO —» y las mayúsculas forzadas.
- **Niveles**: en ancho, una columna acoplada a la derecha, como un
  inspector, en vez del panel flotante. En compacto, una **hoja con dos
  alturas** (media y entera) con asa, que se sube desde la barra accesoria.
- **Modo operador en el teléfono**: tarjetas de **≥ 60 px** de alto con 8 px
  de separación (Parhi y otros).

### Mesa

- Las tiras de canal siguen siendo el centro, con más contraste en el número
  y en el valor. Las bandas por fixture cambian de borde a fondo, y lo
  sujetado por la mesa lleva un anillo `--tint` de 2 px.
- La línea de comandos pasa a ser un campo de búsqueda con su icono. El
  teclado numérico, en táctil, va en una hoja inferior.

### Planta

- El lienzo ocupa todo. Los controles, la selección y los presets **flotan en
  cristal** sobre el rig en vivo, el único sitio donde el cristal tiene
  sentido: controles sobre contenido rico.
- Las etiquetas de las lámparas se muestran según el zoom y la selección, para
  que dejen de pisarse.

### Escenario 3D

- Las cámaras pasan a ser un control segmentado flotante. La calidad va en
  Ajustes > Apariencia.
- Iluminación de cortesía y un suelo de referencia, para que las fixtures
  apagadas no se vean como bloques grises.

### Funciones

- **Vista dividida** en ancho: la lista a la izquierda (búsqueda, un
  segmentado por tipo y filas con icono de tipo, nombre, resumen y play de 44
  px) y el editor a la derecha. **En compacto**, navegación apilada con «‹
  Funciones».
- **Crear** pasa a ser un botón **+** en la barra, que abre una hoja con los
  diez tipos como rejilla de iconos. El formulario permanente desaparece.
- Las filas que suenan se ven como en la consola. Borrar se hace con un menú
  contextual o deslizando, y se deshace con un aviso.

### Patch

- Segmentado arriba: `Universos | Fixtures | Grupos | Canales | Audio`.
- **Lista agrupada con márgenes**, al estilo de Ajustes de iOS: una fila por
  universo con su resumen («ArtNet · eth0 → 22 fixtures») y un chevron al
  detalle. **«Eliminar» sale de la tarjeta** y va al final del detalle, con
  deshacer.
- Los `<select>` pasan a ser menús emergentes propios (§9).

### Asistente

- La conversación, con un ancho máximo de 680 px. El compositor va abajo, con
  el adjunto como icono y el envío como botón circular.
- **En todas partes**: ⌘/Ctrl+K lo abre como hoja lateral sobre cualquier
  pantalla, porque el asistente trabaja sobre lo que estás viendo.

### Ajustes (absorbe Remoto)

- Una hoja de verdad: modal, con Escape, foco atrapado y secciones agrupadas.
- **Dispositivos** (lo que hoy es «Remoto»): lista de conectados y
  emparejados, el botón primario «Emparejar un dispositivo» y el QR en su
  propia hoja.
- El tema se elige con un segmentado `Claro | Gris | Oscuro | Pase`, de más
  luz a menos.

### Estados vacíos y primer arranque

En una mesa vacía no se ven cuatro pantallas en blanco, sino tres pasos con
botón: **Patchea tus focos → Crea una escena → Ponla en un botón**. Cada
pantalla vacía dice qué falta y lleva un botón para hacerlo.

---

## 8. Faders: el control que más castiga un error

Hoy el `Slider` es un `<input type="range">` transparente sobre el dibujo.
Eso conserva el teclado y el lector de pantalla, y está bien. Pero un toque
en la pista **salta** al punto tocado, y en directo un dedo que cae a mitad de
un fader de washes manda la sala al 100 %.

- **Arrastre relativo en táctil**: el valor se mueve con el desplazamiento
  del dedo, no con la posición donde cayó. El teclado y el lector de pantalla
  siguen yendo con el input nativo.
- **Doble toque sobre el valor** para escribirlo. **Pulsación larga** para
  llevarlo a 0 o a 100, con dos opciones explícitas en un menú.
- Marcas al 0, 50 y 100 %. El valor, en Headline tabular.
- Esto **se mide antes de decidirlo** (§11, R0): si los operadores esperan
  que salte, se deja como opción por fader.

---

## 9. Componentes nuevos

Todos en `web/src/ui/`, con sus tests de rol y teclado:

| Componente | Sustituye | Notas |
|---|---|---|
| `Button` (relleno, tintado, simple y destructivo) | Los estilos sueltos de `button` | Un solo componente, cuatro estilos |
| `Segmented` | Pestañas de Patch, modos de la Consola y cámaras 3D | `role="radiogroup"` y flechas del teclado |
| `Menu` / `PopupButton` | Los 84 `<select>` y el menú del proyecto | `role="listbox"` o `menu`, tipear para buscar, Escape. Se dibuja con el tema, también en pase |
| `Sheet` | `<dialog open>`, `window.confirm` y `window.prompt` | `showModal()`, foco atrapado, Escape, alturas media y entera en compacto |
| `Toast` | `.toast` | **Con acción «Deshacer»**. Un error se queda hasta que se cierra; lo informativo se va a los 4 s |
| `List` / `ListRow` | Tarjetas de universo, filas de función y dispositivos | Agrupada con márgenes, con chevron y menú contextual |
| `Tile` | `.widget.button` | Los tres estados de §7 |
| `Inspector` | Panel de niveles y paneles de edición | Columna en ancho, hoja en compacto |

---

## 10. Pase: el tema que protege la vista

Lo que dicen los estudios de visión nocturna, convertido en reglas:

1. **Solo el primario rojo.** Hoy el texto es `#ff7a33`, un naranja con casi
   la mitad de verde (`0x7a`). Todos los colores del pase pasan a ser
   `rgb(r, 0, 0)`. El primario rojo de sRGB está entre 620 y 640 nm, y el
   verde y el azul son justo lo que más ven los bastones (Rempel y otros).
2. **Un solo nivel de texto.** El secundario del pase (2,66:1) no se arregla
   subiendo el brillo, que deslumbra. Tampoco con un rojo más tenue, porque el
   texto fino solo lo leen los conos y los conos piden luz. Se quita: la
   jerarquía se hace con **tamaño y peso**, y en pase toda la escala sube un
   paso.
3. **Atenuador propio.** Un regulador de 0 a 60 % en Ajustes, que pone una
   capa negra encima de todo para bajar más que el brillo mínimo de la
   pantalla. Es el equivalente web de *Reducir punto blanco* de iOS.
4. **Nada del sistema a la vista.** Sin `confirm` ni `prompt` (§9), sin
   `<select>` nativos, con barras de scroll, `::selection` y anillo de foco en
   rojo, y con `theme-color` y la barra de título de la carcasa en negro.
5. **Sin cristal ni brillos.** El material es opaco y los `box-shadow` de
   brillo (como el del punto «en marcha») desaparecen.

---

## 11. Fases

Cada fase se publica sola, pasa `pnpm verify` y se comprueba en Chrome a 390,
834 y 1440 px, en Escena y en Pase. Los tests de interfaz buscan por nombre
accesible, así que **cada cambio de etiqueta lleva su test** (por ejemplo,
`nav.test.tsx` busca hoy un botón «Oscuro»).

- [ ] **R0 — Medir antes de tocar.**
  - Capturas de referencia de las ocho pantallas: tres anchos y dos temas.
  - `tokens.test.ts` con el contraste de hoy, que tiene que fallar en las tres
    parejas de §1.
  - Una prueba de guerrilla con **cinco personas** (con cinco salen la
    mayoría de los problemas) y cinco tareas cronometradas: *lanza el chaser
    arcoíris*, *baja los spots a la mitad*, *blackout y vuelta*, *crea una
    escena azul de los washes* y *patchea cuatro PAR LED*. Se apuntan el
    tiempo, los errores y dónde dudan.
- [ ] **R1 — Tokens y tipografía, sin mover nada de sitio.** Roles de color,
  escala de once estilos, rejilla de 4 px, tres radios, Inter en local, un
  solo sistema de iconos y el arreglo del nombre «Pase/Oscuro». Es la fase
  que más cambia el aspecto con menos riesgo.
- [ ] **R2 — Componentes.** Los ocho de §9, con `confirm`, `prompt` y los
  `<select>` ya sustituidos. Desde aquí, **Escape cierra todo**.
- [ ] **R3 — Navegación y barra del show.** Barra lateral y pestañas que se
  adaptan, la portada de Montaje, la barra en tres grupos, la barra accesoria
  en el móvil y la franja de desconexión.
- [ ] **R4 — Consola y Mesa.** Tarjetas en rejilla con sus tres estados, el
  inspector y la hoja de niveles, y los faders relativos (si R0 lo confirma).
- [ ] **R5 — Funciones y Patch.** Vista dividida, hojas de creación, listas
  agrupadas y borrar con deshacer.
- [ ] **R6 — Planta, Escenario, Asistente y Ajustes.** El cristal flotante, el
  Asistente en todas partes, Ajustes con Dispositivos y los estados vacíos.
- [ ] **R7 — Pase, movimiento y accesibilidad.** La paleta roja profunda, el
  atenuador, `reduced-motion`, `reduced-transparency`, `contrast: more` y
  `forced-colors`, y la prueba a 200 % de zoom. Al final, **la misma prueba de
  guerrilla de R0** y la comparación de tiempos y errores.

**Cuándo está hecho**:

- 0 parejas de tokens por debajo de 4,5:1.
- 1 escala tipográfica, sin tamaños sueltos en `theme.css`.
- 0 diálogos ni menús del sistema.
- ≤ 5 pestañas en compacto.
- La barra del show ocupa ≤ 15 % de la altura del móvil.
- Las cinco tareas de R0, más rápidas y con menos errores que en la medida
  inicial.

---

## 12. Riesgos

| # | Riesgo | Mitigación |
|---|---|---|
| 1 | **El cristal es caro.** `backdrop-filter` puede bajar de 60 fps en una tablet Android barata, y la Planta pinta cada frame DMX | Material opaco por defecto en aparatos con poca GPU (se mide el tiempo de frame al arrancar) y siempre en pase |
| 2 | **Memoria muscular.** Hay operadores que ya usan la mesa | La emergencia no se mueve (arriba a la derecha). El modo operador no cambia de sitio |
| 3 | **Tests que buscan por nombre.** Renombrar rompe `*.test.tsx` | Cada fase actualiza sus tests en el mismo commit |
| 4 | **Colores y fuentes del `.qxw`.** QLC+ guarda el color y la `QFont` de cada widget | Se siguen leyendo y respetando. El rediseño toca la interfaz que los rodea, no el archivo. `roundtrip-smoke.sh` sigue pasando |
| 5 | **Licencias de Apple.** | Ni SF Pro ni SF Symbols en el paquete. Se usan `system-ui` en Apple, Inter (OFL) en el resto e iconos propios |
| 6 | **Rediseñar a ciegas.** La estética hace que algo parezca más fácil sin que lo sea (Kurosu y Kashimura) | R0 y R7 miden lo mismo con las mismas tareas |

---

## 13. Por decidir

1. **El Asistente: ¿pestaña en el móvil u hoja en todas partes?** El plan
   propone las dos cosas: pestaña en compacto y ⌘/Ctrl+K en ancho.
2. ~~**¿Tema claro para montar de día?**~~ **Decidido (2026-11-10): sí, y uno
   gris intermedio.** Los estudios dan ventaja al claro con luz normal y letra
   pequeña, y el show se monta casi siempre con luz. Lo que esta propuesta
   temía se resuelve sin prohibirlo: el tema por defecto sigue siendo Oscuro,
   el suelo de la planta y el 3D se quedan a oscuras en todos los temas, y
   salir del pase vuelve al tema de la sala, no a uno fijo. Ver §14.
3. **¿Se queda el violeta orquídea como acento?** Propuesta: sí, es la marca,
   ajustado a ≥ 4,5:1 y reservado a selección y foco.
4. **Fader relativo o absoluto en táctil.** Se decide con los datos de R0.
5. **¿Prueba con operadores de verdad?** El plan da más fruto con técnicos de
   iluminación que con cualquier otra persona.

---

## Fuentes

**Apple**

- [HIG: Dark Mode](https://developer.apple.com/design/human-interface-guidelines/dark-mode)
- [HIG: Color](https://developer.apple.com/design/human-interface-guidelines/color)
- [HIG: Layout](https://developer.apple.com/design/human-interface-guidelines/layout)
- [HIG: Typography](https://developer.apple.com/design/human-interface-guidelines/typography)
- [HIG: Motion](https://developer.apple.com/design/human-interface-guidelines/motion)
- [HIG: Materials](https://developer.apple.com/design/human-interface-guidelines/materials)
- [HIG: Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)
- [HIG: Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars)
- [HIG: Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars)
- [HIG: Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars)
- [HIG: Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets)
- [HIG: Alerts](https://developer.apple.com/design/human-interface-guidelines/alerts)
- [HIG: Sliders](https://developer.apple.com/design/human-interface-guidelines/sliders)
- [Liquid Glass: visión general](https://developer.apple.com/documentation/technologyoverviews/liquid-glass)
- [WWDC 2025: *Meet Liquid Glass*](https://developer.apple.com/videos/play/wwdc2025/219/)
- *Designing Fluid Interfaces* (WWDC 2018), con las demos reproducidas en
  [nathangitter/fluid-interfaces](https://github.com/nathangitter/fluid-interfaces)
- Licencia de SF Pro: [foro de desarrolladores de Apple](https://developer.apple.com/forums/thread/733267)

**Comportamiento de usuarios**

- NN/g: [Flat UI Elements Attract Less Attention and Cause Uncertainty](https://www.nngroup.com/articles/flat-ui-less-attention-cause-uncertainty/)
- NN/g: [Dark Mode vs. Light Mode](https://www.nngroup.com/articles/dark-mode/)
- NN/g: [Touch Target Size](https://www.nngroup.com/articles/touch-target-size/)
- NN/g: [The 3 Response Time Limits](https://www.nngroup.com/videos/3-response-time-limits-interaction-design/)
- Nielsen: [Progressive Disclosure](https://jakobnielsenphd.substack.com/p/progressive-disclosure)
- NN/g: [Aesthetic-Usability Effect](https://www.nngroup.com/articles/aesthetic-usability-effect/)
- Parhi, Karlson y Bederson, [*Target Size Study for One-Handed Thumb Use on Small Touchscreen Devices*](https://dx.doi.org/10.1145/1152215.1152260), MobileHCI 2006
- Kurosu y Kashimura, [*Apparent Usability vs. Inherent Usability*](https://chi1995.chistatic.hosting.acm.org/proceedings/shortppr/mk_bdy.htm), CHI 1995
- A. Raskin, [*Never Use a Warning When You Mean Undo*](https://alistapart.com/article/neveruseawarning)
- J. Raskin, [*The Humane Interface*](https://en.wikipedia.org/wiki/The_Humane_Interface), y [Modes Are Still Harmful](https://www.raskincenter.org/ideas/modes-are-harmful/)
- Endsley, Bolte y Jones, [*Designing for Situation Awareness*](https://www.taylorfrancis.com/books/mono/10.1201/9780203485088/designing-situation-awareness-mica-endsley-betty-bolte-debra-jones)

**Visión nocturna y control físico**

- Rempel, Mantiuk y Heidrich, [*Display Considerations for Improved Night Vision Performance*](https://web.uvic.ca/~agrempel/night_display.pdf), University of British Columbia y Bangor University
- Merchel, Altinsoy y Stamm, [*Tactile Music Instrument Recognition for Audio Mixers*](https://tu-dresden.de/ing/elektrotechnik/ias/aha/ressourcen/dateien/professur/publikationen/Merchel2010e_-_Tactile_Music_Instrument_Recognition_for_Audio_Mixers.pdf), AES 2010

---

## 14. Estado de la ejecución (2026-11-09)

Todo verificado con `pnpm verify` (biome, **606 tests**, tsc y build), con
`server/test/ui-smoke.sh` en Chrome sobre los diez proyectos de la CI y con
capturas a 1440 y 390 px en los dos temas.

**Hecho**

- [x] **R1 — Tokens y tipografía.** Roles de color con alias para las 4.000
  líneas de CSS que había; escala de once estilos (**de 20 tamaños sueltos a
  1**, la rejilla de 512 celdas, que es un dato denso); radios en tokens
  (6/10/14/20 y píldora); Inter servida en local con su OFL en el paquete y en
  `NOTICE`; un solo sistema de iconos (`icons.tsx`) en vez de caracteres; el
  tema se llama **Escena** y **Pase** en todas partes.
- [x] **`tokens.test.ts`**: contraste WCAG de cada pareja texto/fondo en los
  dos temas, el pase sin verde ni azul, los bordes a 3:1 con
  `prefers-contrast`, y el texto sobre el botón principal. El acento violeta
  como texto daba 4,09:1; ahora el texto usa `--accent-text` (≥ 5,6:1) y el
  botón principal `--accent-fill` (5,25:1 con blanco).
- [x] **R2 — Componentes** (`ui.tsx`, con `ui.test.tsx`): `Sheet` modal de
  verdad (Escape, foco dentro y de vuelta, toque fuera, solo la de arriba
  oye Escape), `dialogo.confirmar` y `dialogo.preguntar` (**cero** `confirm`
  y `prompt` nativos), `Segmented`, `Toast` con «Deshacer» (los errores se
  quedan, las noticias se van a los 4 s) y `useDismiss` para los cuatro
  popovers de la barra.
- [x] **R3 — Navegación y barra.** Barra lateral con «Directo» y «Montaje»,
  que se pliega a iconos y recuerda; rail de iconos entre 900 y 1179 px;
  **cinco pestañas** en el móvil con la portada de Montaje. La barra del show
  en tres grupos. En el móvil, una fila arriba (**61 px, el 7 % de la
  altura**; antes 224 px) y la tira de directo encima de las pestañas (60 px).
  Las pestañas miden 76×51 px con etiquetas de 12 px (antes 34 px y 10,56 px),
  y no queda texto visible por debajo de 12 px. Franja roja de desconexión.
  Dispositivos (antes «Remoto») entra por Ajustes.
- [x] **R4 — Consola.** Tarjetas con los tres estados (parada, encendida con
  su color, pulsada esperando a la mesa). El texto se oscurece sobre rellenos
  claros por cálculo (`litOnLight`). Niveles en columna con espacio y en hoja
  en el móvil. Tarjetas de 60 px en el modo operador del teléfono.
  **Fader relativo en pantallas táctiles** (`relativeValue`, con tests).
- [x] **R5 — Funciones y Patch.** Vista dividida (lista y editor) y navegación
  apilada en el móvil; crear desde una hoja con los diez tipos; listas
  agrupadas; pestañas del patch como segmentado; «Eliminar universo» al pie
  y con deshacer, igual que borrar una función.
- [x] **R6 — Planta, Escenario, Asistente, Ajustes.** El panel de la planta en
  cristal, las cues encendidas como la consola, las cámaras del 3D como un
  segmentado, Ajustes como hoja agrupada, Ctrl/⌘+K al Asistente y una mesa
  vacía que dice los tres pasos.
- [x] **R7 — Pase y sistema.** Solo el primario rojo, atenuador propio de 0 a
  60 %, `theme-color` negro, `select` con chevron propio (rojo en el pase),
  `prefers-reduced-motion`, `prefers-reduced-transparency`,
  `prefers-contrast` y `forced-colors`.

**Lo que cambió por el camino, y por qué**

- **El Asistente con Ctrl/⌘+K navega a su pantalla** en vez de abrirse como
  hoja lateral encima de la actual. Montar la conversación dos veces duplicaba
  su estado y su conexión con el proveedor. Si se quiere la hoja, es una
  refactorización de `conversacion.tsx`, no de la interfaz.
- **El menú abierto de un `<select>` sigue siendo el del sistema.** El control
  cerrado ya es el de la mesa. Sustituir los 84 por un menú propio se queda
  para una fase aparte, con sus tests.
- **En el móvil**, el modo de la consola, «Modo operador» y Ajustes van en el
  menú del show: es lo que la HIG dice de las barras estrechas, pasar lo que
  no cabe a un menú en vez de encoger los controles.
- **Cinco radios en vez de tres**: hacía falta uno pequeño (6 px) para
  muestras y celdas.

**Pendiente**

- [ ] **La prueba con cinco personas** (R0) y su repetición (R7). No la puede
  hacer un agente: son técnicos de luces cronometrados con las cinco tareas
  de §11.
- [ ] Menú propio para los `<select>` (ver arriba).
- [ ] Medir el cristal en una tablet Android barata (riesgo 1) antes de darlo
  por bueno fuera del escritorio.

### Claro y Gris (2026-11-10)

Dos temas más, y los cuatro se nombran por cuánta luz hay en la sala:
**Claro** (montar en una oficina o de día), **Gris** (media luz, con la luz de
trabajo encendida), **Oscuro** (la función; es el de siempre y sigue siendo
el que sale por defecto) y **Pase**.

- [x] **Claro**: la disposición agrupada de Apple. Fondo gris `#f2f2f7`, el
  contenido en blanco y la profundidad con sombra, porque en claro una sombra
  se ve. El violeta, el verde de «en vivo», el ámbar y el rojo se oscurecen
  hasta leerse como texto sobre blanco. El mando de los faders es blanco con
  sombra, como en el sistema. Lo respalda que el texto oscuro sobre claro se
  lee más rápido y con menos errores con luz normal, a cualquier edad
  (Piepenbrock, Mayr, Mund y Buchner, *Ergonomics*, 2013).
- [x] **Gris**: el oscuro subido a grises medios (`#333539` de base), con cada
  rol de texto aclarado para conservar el contraste.
- [x] **El suelo de la planta sigue a oscuras en Claro**: se le vuelven a
  declarar los tokens del oscuro, porque una lámpara blanca encendida no se
  ve sobre blanco. El 3D ya era oscuro en todos.
- [x] **Una tarjeta encendida se ve igual en los cuatro temas**: el relleno se
  mezcla con un blanco fijo (`--lit-white`) y no con el color del texto del
  tema, que en Claro es casi negro. Así `litOnLight` sigue acertando.
- [x] **Salir del pase vuelve al tema de la sala** (`tema.ts`), con Ctrl+Alt+P
  o con el interruptor del menú del show. Antes volvía siempre al oscuro.
- [x] `color-scheme: light` en Claro (barras de desplazamiento y menús nativos
  en claro), el chevron de los `select` en gris, `theme-color` por tema, y
  `prefers-contrast` con valores propios para Claro y Gris.
- [x] **`tokens.test.ts` mide los cuatro temas**: texto a 4,5:1 sobre cada
  fondo, bordes a 3:1 con `prefers-contrast`. `tema.test.ts` cubre la vuelta
  del pase, y `app.test.tsx` los cuatro botones y el atajo. `pnpm verify`:
  **638 tests**; `ui-smoke.sh` en Chrome, en verde con vc-actions (78) y
  Sample (81).
