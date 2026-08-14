/**
 * An XY pad: pointing moving heads with a finger.
 *
 * The pad's own coordinates are 0..1 on each axis, and the project decides what
 * that means for each head -- which slice of its pan and tilt travel the pad may
 * use, and whether an axis is inverted because the lamp hangs upside down. None
 * of that is the interface's business, which is why only the position goes over
 * the wire.
 *
 * Pointer events rather than mouse or touch: this is dragged on a phone at
 * least as often as with a mouse, and pointer capture is what keeps a drag
 * alive when the finger leaves the pad.
 */

import { useRef, useState } from 'react'
import type { VcWidget } from './layout'

export function XYPad({
  widget,
  style,
  position,
  onMove,
}: {
  widget: VcWidget
  style: React.CSSProperties
  position: { x: number; y: number }
  onMove: (id: number, x: number, y: number) => void
}) {
  const surface = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)

  const usable = widget.id !== undefined && (widget.padHeads ?? 0) > 0

  const aim = (event: React.PointerEvent) => {
    const box = surface.current?.getBoundingClientRect()
    if (!box || box.width === 0 || box.height === 0 || widget.id === undefined) return

    const x = (event.clientX - box.left) / box.width
    const y = (event.clientY - box.top) / box.height

    onMove(widget.id, clamp(x), clamp(y))
  }

  if (!usable) {
    return (
      <div className="widget unsupported" style={style}>
        <span>
          {widget.caption || 'XY pad'}
          <br />
          <small>sin cabezas</small>
        </span>
      </div>
    )
  }

  return (
    <div className="widget xypad" style={style}>
      <span className="fader-caption">{widget.caption || 'XY'}</span>
      <div
        ref={surface}
        className="xypad-surface"
        role="application"
        aria-label={`${widget.caption || 'XY pad'}: posición ${Math.round(position.x * 100)}, ${Math.round(position.y * 100)}`}
        data-dragging={dragging}
        onPointerDown={(e) => {
          // Capture so the drag survives the finger leaving the pad, which on
          // a small screen it does constantly.
          e.currentTarget.setPointerCapture(e.pointerId)
          setDragging(true)
          aim(e)
        }}
        onPointerMove={(e) => dragging && aim(e)}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture(e.pointerId)
          setDragging(false)
        }}
        onPointerCancel={() => setDragging(false)}
      >
        <span
          className="xypad-dot"
          style={{ left: `${position.x * 100}%`, top: `${position.y * 100}%` }}
        />
      </div>
      <span className="fader-value">
        {Math.round(position.x * 100)} · {Math.round(position.y * 100)}
      </span>
    </div>
  )
}

function clamp(value: number) {
  return Math.min(1, Math.max(0, value))
}
