/**
 * Turning a Virtual Console into something usable on a phone.
 *
 * QLC+ places every widget at an absolute pixel position on the canvas the show
 * was designed on -- 1920x1080 for the rigs this was built against. Scaling that
 * canvas down to a 390 px phone gives 30 px buttons: unhittable, in the dark,
 * mid-show. Scrolling a 1920 px canvas sideways is no better.
 *
 * So the geometry is read as *intent* rather than as coordinates. Widgets the
 * designer put side by side are a row; rows keep their order; and each row then
 * reflows to whatever width the screen actually has. The result rearranges on a
 * phone instead of shrinking, and stays recognisable next to the desktop layout.
 */

export interface Geometry {
  x: number
  y: number
  width: number
  height: number
}

export interface VcWidget {
  type: string

  /**
   * Absent on a console written by QLC+ 4, which wrote no ID attribute at all
   * and assigned them in memory on load -- the console that ships with QLC+ to
   * this day has not one.
   *
   * Every edit addresses a widget by id, so such a project is not partly
   * editable, it is entirely uneditable until POST /vc/widgets/ids has run.
   */
  id?: number

  caption?: string
  geometry: Geometry
  background?: string
  foreground?: string
  page?: number

  /** Audio triggers: how many bands the widget was built for, and what each
   *  assigned bar drives. */
  bands?: number
  bars?: {
    name: string
    index: number
    volume: boolean
    minThreshold: number
    maxThreshold: number
    drives: string
    functionId?: number
    widgetId?: number
    channels?: number
  }[]

  /** Matrix widget: the presets it can apply. `applicable` is false for the
   *  kinds that are not buttons -- knobs, images and text. */
  presets?: { id: number; type: string; color?: string; resource?: string; applicable: boolean }[]
  instantApply?: boolean

  /* Frames. A frame holds other widgets, and may page through them. */
  pages?: number
  currentPage?: number
  showHeader?: boolean
  collapsed?: boolean

  action?: string
  functionId?: number
  chaserId?: number
  clockType?: string
  clockTime?: number
  /** XY pad: how many heads it steers, and where it was left. Zero heads
   *  means a pad that steers nothing, which is a control that does nothing. */
  padHeads?: number
  padX?: number
  padY?: number
  sliderMode?: string
  levelChannels?: { fixture: number; channel: number }[]
  low?: number
  high?: number
  value?: number
  controllable?: boolean
  speedTargets?: { functionId: number; fadeIn: number; fadeOut: number; duration: number }[]
  speedMs?: number
  speedMin?: number
  speedMax?: number
  children?: VcWidget[]
}

export interface Row {
  /** Top of the row on the original canvas; used only for ordering. */
  top: number
  widgets: VcWidget[]
}

/**
 * How far apart two widgets' top edges can be and still count as one row,
 * as a fraction of the shorter widget's height.
 *
 * Rows are decided by where widgets *start*, not by whether they overlap.
 * Overlap is the obvious rule and it is wrong: a 400 px master fader spans
 * every band of buttons beside it, so under an overlap rule it drags all of
 * them into a single row and the layout collapses. Designers align things by
 * their tops, and a label sitting a few pixels proud of the buttons it titles
 * still belongs with them.
 */
const TOP_TOLERANCE = 0.5

function startsTogether(a: Geometry, b: Geometry): boolean {
  const shorter = Math.min(a.height, b.height)
  if (shorter <= 0) return Math.abs(a.y - b.y) === 0

  return Math.abs(a.y - b.y) <= shorter * TOP_TOLERANCE
}

/**
 * Group widgets into rows by vertical proximity, preserving reading order:
 * rows top to bottom, widgets left to right within a row.
 */
export function groupIntoRows(widgets: readonly VcWidget[]): Row[] {
  const sorted = [...widgets].sort((a, b) => {
    const dy = a.geometry.y - b.geometry.y
    return dy !== 0 ? dy : a.geometry.x - b.geometry.x
  })

  const rows: Row[] = []

  for (const widget of sorted) {
    // Compare against the row's own extent, not just its first member, or a
    // tall widget would swallow every short one below it.
    const row = rows.find((candidate) =>
      candidate.widgets.some((member) => startsTogether(member.geometry, widget.geometry)),
    )

    if (row) {
      row.widgets.push(widget)
      row.top = Math.min(row.top, widget.geometry.y)
    } else {
      rows.push({ top: widget.geometry.y, widgets: [widget] })
    }
  }

  rows.sort((a, b) => a.top - b.top)
  for (const row of rows) {
    row.widgets.sort((a, b) => a.geometry.x - b.geometry.x)
  }

  return rows
}

/**
 * Relative width of a widget within its row, as a flex-grow factor.
 *
 * Keeping the designer's proportions means a wide master fader still reads as
 * wider than the buttons beside it, without inheriting its absolute size.
 */
export function growFactor(widget: VcWidget, row: Row): number {
  const total = row.widgets.reduce((sum, w) => sum + Math.max(w.geometry.width, 1), 0)
  if (total === 0) return 1

  const share = Math.max(widget.geometry.width, 1) / total
  // Clamped: one enormous widget should not squeeze its neighbours to nothing.
  return Math.min(Math.max(share * row.widgets.length, 0.5), 4)
}

/** Widgets that are laid out rather than drawn. */
export function isContainer(widget: VcWidget): boolean {
  return widget.type === 'frame' || widget.type === 'soloframe'
}

/** The pages of a console: its top-level frames, or the console itself. */
export function pagesOf(root: VcWidget): VcWidget[] {
  const frames = (root.children ?? []).filter(isContainer)
  return frames.length > 0 ? frames : [root]
}

/**
 * The children of a frame that belong on the page it is showing.
 *
 * A frame that is not multipage shows everything: its children may still carry
 * a @Page from a design that once had pages, and hiding them would make widgets
 * vanish for a reason nobody can see. Only a frame that says it has pages
 * filters by them.
 */
export function childrenOnPage(frame: VcWidget, page: number): VcWidget[] {
  const children = frame.children ?? []
  if (!frame.pages || frame.pages <= 1) return children
  return children.filter((child) => (child.page ?? 0) === page)
}
