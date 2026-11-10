import { useRef, useState } from 'react'

/**
 * The slider, drawn.
 *
 * The browser's range input is a hairline with a dot on it: legible on a desk
 * at arm's length, invisible on a lighting desk being read across a stage in
 * the dark. So the bar is drawn -- a track, a fill and a thumb -- while the
 * input itself stays exactly where it was, transparent and full size on top.
 * That is deliberate: the keyboard, the pointer capture, the disabled state and
 * everything a screen reader knows about a range are the platform's, and none
 * of it is reimplemented here.
 *
 * One component for all of them, because every slider in this app is the same
 * gesture -- drag a value along a range -- and the moment there are two of them
 * there are two things for an operator to learn. It also closes the way the
 * first version of this leaked: a control that kept its raw input rendered a
 * tall vertical range in the middle of a row of buttons, and nothing said so
 * until somebody looked at the screen.
 *
 * On a touch screen one thing is not the platform's. A range input jumps to
 * wherever the finger lands, and a finger that lands mid-track on the washes
 * fader sends the room to full: a touch fader has no feel, so it cannot be
 * found without being moved (Merchel, Altinsoy & Stamm). There the drag is
 * relative -- the value follows how far the finger travels, from where it
 * was -- and the input only listens to the keyboard and the screen reader. A
 * mouse, which can be aimed, keeps the platform's absolute behaviour.
 */
export function Slider({
  fill,
  ...input
}: Omit<React.ComponentProps<'input'>, 'type'> & {
  /** What the fill is coloured with. The live desk uses green, so that a bar
   *  driving the rig right now does not look like one that is not. */
  fill?: string
}) {
  /* Uncontrolled sliders -- the ones that only report on release, because
     writing a scene value on every pixel would be a write per frame -- still
     have to draw where the finger is. This follows the input for them, and
     stands aside for a controlled one, whose value is the parent's to say. */
  const [dragged, setDragged] = useState<number | null>(null)
  const field = useRef<HTMLInputElement | null>(null)
  const grip = useRef<{
    x: number
    from: number
    width: number
    left: number
    relative: boolean
  } | null>(null)

  const min = Number(input.min ?? 0)
  const max = Number(input.max ?? 100)
  const step = input.step === undefined || input.step === 'any' ? 1 : Number(input.step)
  const controlled = input.value !== undefined
  const shown = controlled ? Number(input.value) : (dragged ?? Number(input.defaultValue ?? 0))
  const percent = max > min ? Math.round(((shown - min) / (max - min)) * 100) : 0

  /* Writes through the input, so every listener a parent put on it -- onChange,
     onInput, onPointerUp -- hears this exactly as it hears a native drag. */
  const write = (value: number) => {
    const el = field.current
    if (el === null) return
    const next = String(snap(value, min, max, step))
    if (el.value === next) return
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, next)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }

  return (
    <span
      className="track"
      style={
        {
          '--pct': `${percent}%`,
          ...(fill ? { '--fill-colour': fill } : {}),
        } as React.CSSProperties
      }
      onPointerDown={(event) => {
        if (!touchScreen() || input.disabled || field.current === null) return
        const rect = event.currentTarget.getBoundingClientRect()
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch {
          // Capture is an enhancement; the move events still arrive without it.
        }
        const relative = event.pointerType !== 'mouse'
        grip.current = {
          x: event.clientX,
          from: Number(field.current.value),
          width: rect.width,
          left: rect.left,
          relative,
        }
        if (!relative) write(min + ((event.clientX - rect.left) / rect.width) * (max - min))
      }}
      onPointerMove={(event) => {
        const held = grip.current
        if (held === null) return
        write(
          held.relative
            ? relativeValue(held.from, event.clientX - held.x, held.width, min, max)
            : min + ((event.clientX - held.left) / held.width) * (max - min),
        )
      }}
      onPointerUp={() => {
        if (grip.current === null) return
        grip.current = null
        /* The sliders that commit on release listen for this on the input. */
        field.current?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
        field.current?.dispatchEvent(new Event('change', { bubbles: true }))
      }}
      onPointerCancel={() => {
        grip.current = null
      }}
    >
      <span className="fill" />
      <span className="thumb" />
      <input
        ref={field}
        type="range"
        {...input}
        onInput={(event) => {
          if (!controlled) setDragged(Number((event.target as HTMLInputElement).value))
          input.onInput?.(event)
        }}
      />
    </span>
  )
}

/** A touch screen as the main pointer: where the relative drag takes over. */
function touchScreen(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
}

/**
 * Where a relative drag puts the value: the starting value plus the distance
 * travelled, as a share of the track's width, of the whole range. Clamped, so
 * a finger that runs off the end leaves the fader at the end.
 */
export function relativeValue(
  from: number,
  travelled: number,
  width: number,
  min: number,
  max: number,
): number {
  if (width <= 0) return from
  return Math.min(max, Math.max(min, from + (travelled / width) * (max - min)))
}

/** Onto the input's own grid, and inside its range. */
export function snap(value: number, min: number, max: number, step: number): number {
  const clamped = Math.min(max, Math.max(min, value))
  if (!(step > 0)) return clamped
  const snapped = Math.round((clamped - min) / step) * step + min
  return Math.min(max, Number(snapped.toFixed(6)))
}
