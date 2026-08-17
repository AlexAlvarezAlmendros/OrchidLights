/**
 * Audio triggers: driving the console from what the microphone hears.
 *
 * The widget is a switch and a spectrum. Each band has a bar, and a bar either
 * holds DMX channels at its level, starts a function when it rises past a
 * threshold, or drives another widget.
 *
 * The switch is deliberate rather than automatic. Opening a microphone is not a
 * neutral act -- it is a device the operator may be using for something else --
 * so the daemon holds it only while this is on, and says so when it could not
 * get one at all.
 */

import type { VcWidget } from './layout'

export function AudioTriggers({
  widget,
  style,
  spectrum,
  volume,
  enabled,
  capturing,
  unavailable,
  onToggle,
}: {
  widget: VcWidget
  style: React.CSSProperties
  spectrum: number[]
  volume: number
  enabled: boolean
  capturing: boolean
  unavailable?: string
  onToggle: (id: number, enabled: boolean) => void
}) {
  const bars = widget.bars ?? []
  const usable = widget.id !== undefined && bars.length > 0

  if (!usable) {
    return (
      <div className="widget unsupported" style={style}>
        <span>
          {widget.caption || 'Audio'}
          <br />
          <small>sin barras asignadas</small>
        </span>
      </div>
    )
  }

  // What each assigned bar is watching, so an idle band is visibly idle rather
  // than just short.
  const assigned = new Map(bars.filter((b) => !b.volume).map((b) => [b.index, b]))

  return (
    <div className="widget audiotriggers" style={style} data-on={enabled}>
      <div className="audio-head">
        <span className="fader-caption">{widget.caption || 'Audio'}</span>
        <span className="spacer" />
        <button
          type="button"
          aria-pressed={enabled}
          onClick={() => widget.id !== undefined && onToggle(widget.id, !enabled)}
        >
          {enabled ? 'Escuchando' : 'Escuchar'}
        </button>
      </div>

      {enabled && !capturing && (
        <p className="hint">{unavailable ?? 'No se pudo abrir ninguna entrada de audio.'}</p>
      )}

      <div className="audio-spectrum" aria-hidden="true">
        {(spectrum.length > 0 ? spectrum : new Array(widget.bands ?? 16).fill(0)).map(
          (band, index) => (
            <span
              // The position is the identity: a fixed row of bands, in order.
              // biome-ignore lint/suspicious/noArrayIndexKey: the index is the band
              key={index}
              className="audio-band"
              data-assigned={assigned.has(index)}
              style={{ height: `${Math.round((band / 255) * 100)}%` }}
            />
          ),
        )}
      </div>

      <span className="fader-value">
        {bars.length} barras · vol {Math.round((volume / 255) * 100)}%
      </span>
    </div>
  )
}
