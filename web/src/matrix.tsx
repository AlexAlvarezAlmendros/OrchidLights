/**
 * The RGB matrix widget: a fader over a matrix, plus its presets.
 *
 * The fader is the same thing a playback slider is -- at zero it stops the
 * matrix, above zero it rides its intensity -- so it goes over the same wire
 * message. The presets are the widget's own: a colour preset drops a stored
 * colour into one of the algorithm's five slots, an animation preset swaps the
 * algorithm and carries the script properties it was stored with.
 *
 * Knobs, images and text are shown but not offered. They are continuous or
 * need a file, and a button that looks live and does nothing is the failure
 * this project exists to avoid.
 */

import type { VcWidget } from './layout'
import { Slider } from './slider'

export function MatrixWidget({
  widget,
  style,
  value,
  onLevel,
  onPreset,
}: {
  widget: VcWidget
  style: React.CSSProperties
  value: number
  onLevel: (id: number, value: number) => void
  onPreset: (id: number, preset: number) => void
}) {
  const presets = widget.presets ?? []
  const usable = widget.id !== undefined && widget.functionId !== undefined

  if (!usable) {
    return (
      <div className="widget unsupported" style={style}>
        <span>
          {widget.caption || 'Matriz'}
          <br />
          <small>sin matriz</small>
        </span>
      </div>
    )
  }

  return (
    <div className="widget matrix" style={style}>
      <span className="fader-caption">{widget.caption || 'Matriz'}</span>

      <Slider
        min={0}
        max={255}
        value={value}
        aria-label={`${widget.caption || 'Matriz'}: intensidad`}
        onChange={(e) => widget.id !== undefined && onLevel(widget.id, Number(e.target.value))}
      />

      {presets.length > 0 && (
        <div className="matrix-presets">
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className="matrix-preset"
              disabled={!preset.applicable}
              // The stored colour is the button: on a bank of eight, the label
              // is the colour, not the word for it.
              style={preset.color ? { background: preset.color } : undefined}
              title={preset.resource || preset.color || preset.type}
              onClick={() => widget.id !== undefined && onPreset(widget.id, preset.id)}
            >
              {preset.resource || (preset.type.includes('Reset') ? '↺' : '')}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
