import { useState } from 'react'

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

  const min = Number(input.min ?? 0)
  const max = Number(input.max ?? 100)
  const controlled = input.value !== undefined
  const shown = controlled ? Number(input.value) : (dragged ?? Number(input.defaultValue ?? 0))
  const percent = max > min ? Math.round(((shown - min) / (max - min)) * 100) : 0

  return (
    <span
      className="track"
      style={
        {
          '--pct': `${percent}%`,
          ...(fill ? { '--fill-colour': fill } : {}),
        } as React.CSSProperties
      }
    >
      <span className="fill" />
      <span className="thumb" />
      <input
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
