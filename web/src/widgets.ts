/**
 * What can be added to a console, and where a new one goes.
 *
 * Separate from the editor component because the placement rule is a real rule
 * with a real consequence, not presentation: it decides which row the widget
 * lands in once the console reflows.
 */

import type { Geometry, VcWidget } from './layout'

/** Widget types worth offering. The rest exist in the file format but have no
 *  control here yet, and creating one would only add a grey box. */
export const CREATABLE = [
  { type: 'button', label: 'Botón', width: 120, height: 60 },
  { type: 'slider', label: 'Fader', width: 60, height: 220 },
  { type: 'label', label: 'Etiqueta', width: 200, height: 40 },
  { type: 'cuelist', label: 'Cue list', width: 320, height: 220 },
  { type: 'clock', label: 'Reloj', width: 150, height: 60 },
  { type: 'frame', label: 'Marco', width: 300, height: 200 },
  { type: 'soloframe', label: 'Marco solo', width: 300, height: 200 },
  { type: 'speeddial', label: 'Dial de tempo', width: 160, height: 120 },
  { type: 'xypad', label: 'XY pad', width: 240, height: 240 },
  { type: 'audiotriggers', label: 'Triggers de audio', width: 220, height: 140 },
  { type: 'matrix', label: 'Matriz', width: 220, height: 140 },
  /* A knob IS a slider (WidgetStyle="Knob" in the file); it earns its own
     entry because the operator asks for "a knob", not for a slider option. */
  { type: 'knob', label: 'Knob', width: 90, height: 110 },
] as const

/** How far below the last widget a new one starts. Only has to clear the row
 *  tolerance in layout.ts; the exact number is not load-bearing. */
const GAP = 40

/**
 * Where to put a new widget: below everything already on the page.
 *
 * The position still matters even though the console reflows, because the rows
 * *come from* these positions. A widget dropped at 0,0 would be spliced into
 * whatever row the designer built at the top of the console -- landing a new
 * button in the middle of the colour bank. Below the last one, it arrives in a
 * row of its own, and can then be dragged wherever it belongs.
 */
export function placeBelow(siblings: VcWidget[], type: string): Geometry {
  const spec = CREATABLE.find((c) => c.type === type)
  const bottom = siblings.reduce((y, w) => Math.max(y, w.geometry.y + w.geometry.height), 0)

  return {
    x: 0,
    y: bottom + GAP,
    width: spec?.width ?? 120,
    height: spec?.height ?? 60,
  }
}
