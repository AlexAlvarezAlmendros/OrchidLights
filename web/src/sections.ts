/**
 * The console, read as sections rather than as rows.
 *
 * QLC+ gives an operator one way to write a heading -- a label widget -- and
 * one way to lay anything out: absolute pixels. What comes back is a run of
 * widgets with labels sprinkled through it, and the structure the operator had
 * in mind lives in those labels and nowhere else.
 *
 * This reads it out: everything between one label and the next is a section,
 * and inside a section a fader is a different kind of thing from a button. That
 * is what lets the console be drawn as a designed screen instead of as the
 * pixel positions of somebody's 1920-wide desktop, without changing one byte of
 * their project.
 *
 * Their order survives it. Grids flow in document order, so arranging the
 * console still decides where things sit.
 */

import type { Row, VcWidget } from './layout'

export interface Section {
  /** The label that opened it, cleaned of the dashes operators pad them with.
   *  Null for whatever comes before the first label. */
  title: string | null
  /** Buttons, cue lists, pads, frames: the things you press. */
  controls: VcWidget[]
  /** Faders, which get a column of their own -- a slider mixed into a grid of
   *  buttons is either too short to use or too tall for the row. */
  levels: VcWidget[]
}

/** A label's caption without the decoration. QLC+ has no heading, so operators
 *  write "— MAESTRO —"; the dashes are the workaround, not the name. */
export function headingOf(widget: VcWidget): string {
  return (widget.caption ?? '').replace(/^[\s—–-]+|[\s—–-]+$/g, '')
}

export function toSections(rows: readonly Row[]): Section[] {
  const sections: Section[] = []
  let current: Section | null = null

  const open = (title: string | null) => {
    current = { title, controls: [], levels: [] }
    sections.push(current)
    return current
  }

  for (const row of rows) {
    for (const widget of row.widgets) {
      if (widget.type === 'label') {
        const title = headingOf(widget)
        /* An empty label is a spacer, not a heading. Opening a section for it
           would put a blank title between two groups that belong together. */
        if (title !== '') open(title)
        continue
      }

      const into = current ?? open(null)
      if (widget.sliderMode) into.levels.push(widget)
      else into.controls.push(widget)
    }
  }

  /* Empty sections stay.
   *
     Dropping a heading with nothing under it looked tidy and was wrong: a
     label the operator wrote is in the project, and a run mode that hides it
     is a run mode where something exists and cannot be seen. That is the one
     failure this whole layer is arranged against -- the same rule that keeps a
     widget the stored arrangement never mentioned. An odd-looking empty
     heading is their project saying so. */
  return sections
}
