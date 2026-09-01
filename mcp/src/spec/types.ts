/**
 * El proyecto entero como un documento declarativo.
 *
 * La regla que lo gobierna todo: **se direcciona por nombre, nunca por id**.
 * Los identificadores los reparte el motor —el hueco libre más bajo—, así que
 * un cliente no puede escribirlos, solo descubrirlos después de crear. Un
 * archivo escrito a mano que hablase de ids sería un archivo que no se puede
 * aplicar dos veces, y aplicar dos veces sin que pase nada la segunda es la
 * propiedad de la que cuelga todo lo demás.
 *
 * Un nombre repetido dentro de su sección es un error, no una advertencia: un
 * documento con dos escenas «Azul» no dice a cuál se refiere el chaser.
 */

export const SPEC_VERSION = 1

/** Un canal, dicho como lo diría una persona o como lo cuenta la máquina. */
export type ChannelRef = string | number

export interface StagePlacement {
  /** Milímetros contra la rejilla del escenario. */
  x?: number
  y?: number
  z?: number
  /** Grados. `rotation` gira sobre el eje vertical. */
  rotation?: number
  rotationX?: number
  rotationZ?: number
  /** Color del filtro, "#rrggbb". */
  gel?: string
  zoom?: number
  hidden?: boolean
  locked?: boolean
  /** Un foco colgado boca abajo se apunta invirtiendo un eje. */
  invertPan?: boolean
  invertTilt?: boolean
}

export interface FixtureSpec {
  name: string
  manufacturer: string
  model: string
  mode: string
  universe: number
  /** Primer canal, contado desde 1, como lo que va impreso en el foco. */
  address: number
  stage?: StagePlacement
}

export interface PatchSpec {
  /** Un nombre de `GET /io`, literal. "Art-Net" cuando el plugin se llama "ArtNet" no da error: da un universo sin salida. */
  plugin: string
  line?: string
  /** Solo en la entrada: lo que da sentido a las notas y los CC de un ala MIDI. */
  profile?: string
}

export interface UniverseSpec {
  name: string
  output?: PatchSpec | null
  input?: PatchSpec | null
  feedback?: PatchSpec | null
  passthrough?: boolean
}

export interface StageSpec {
  width?: number
  height?: number
  depth?: number
  units?: 'meters' | 'feet'
}

export interface FixtureGroupSpec {
  name: string
  /** Por nombre de fixture. */
  fixtures?: string[]
  size?: { width: number; height: number }
  /** La rejilla es el lienzo sobre el que corren las matrices RGB. */
  cells?: { x: number; y: number; fixture: string; head?: number }[]
}

export interface SceneValueSpec {
  fixture: string
  /** El nombre del canal en el modo de esa fixture, o su índice desde 0. */
  channel: ChannelRef
  value: number
}

export interface ChaserStepSpec {
  /** La función que dispara el paso, por nombre. */
  function: string
  fadeIn?: number
  hold?: number
  fadeOut?: number
  duration?: number
  /** La etiqueta del cue. */
  note?: string
}

export interface EfxHeadSpec {
  fixture: string
  head?: number
  offset?: number
  reverse?: boolean
  mode?: string
}

export interface FunctionSpec {
  name: string
  type: string
  /** Carpeta en el árbol de funciones. */
  path?: string
  fadeIn?: number
  fadeOut?: number
  duration?: number
  runOrder?: string
  direction?: string
  tempoType?: string

  /** Scene. */
  values?: SceneValueSpec[]

  /** Chaser y Sequence. */
  steps?: ChaserStepSpec[]
  fadeInMode?: string
  fadeOutMode?: string
  durationMode?: string
  /** Sequence: la escena de la que cuelga. */
  scene?: string

  /** Collection. */
  members?: string[]

  /** EFX. */
  algorithm?: string
  geometry?: Record<string, number>
  propagation?: string
  heads?: EfxHeadSpec[]

  /** RGBMatrix. */
  group?: string
  colors?: (string | null)[]
  blendMode?: string
  controlMode?: string
  properties?: Record<string, string>

  /** Script. */
  data?: string

  /** Audio y Video. */
  source?: string
  volume?: number
  device?: string
  screen?: number
  fullscreen?: boolean
  layer?: number
}

export interface WidgetSpec {
  type: string
  caption?: string
  /** Por nombre de función. Un botón, un slider de playback, una animación. */
  functionId?: string
  /** Cue list: el chaser que corre, por nombre. */
  chaserId?: string
  action?: string
  sliderMode?: string
  levelChannels?: { fixture: string; channel: ChannelRef }[]
  background?: string | null
  foreground?: string | null
  font?: string | null
  page?: number
  pages?: number
  geometry?: { x?: number; y?: number; width?: number; height?: number }
  input?: { universe: number; channel: number } | null
  children?: WidgetSpec[]
}

export interface ConsoleSpec {
  widgets?: WidgetSpec[]
}

export interface ShowSpec {
  /** Versión del formato. Un documento sin esto no es un documento de esto. */
  orchidlights: number
  project?: {
    name?: string
    /** La función con la que abre el show, por nombre. `null` es ninguna. */
    startupFunction?: string | null
  }
  stage?: StageSpec
  universes?: UniverseSpec[]
  fixtures?: FixtureSpec[]
  fixtureGroups?: FixtureGroupSpec[]
  functions?: FunctionSpec[]
  console?: ConsoleSpec
}
