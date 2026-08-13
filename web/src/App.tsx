import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type FunctionState, api } from './api'
import { type LayoutRows, moveWidget, resolveRows, rowsToLayout } from './arrange'
import { type Row, type VcWidget, growFactor, isContainer, pagesOf } from './layout'
import { type Connection, Live } from './live'

type Theme = 'stage' | 'blackout'

export function App() {
  const [connection, setConnection] = useState<Connection>('connecting')
  const [functions, setFunctions] = useState<FunctionState[]>([])
  const [vc, setVc] = useState<VcWidget | null>(null)
  const [page, setPage] = useState(0)
  // Persisted: an operator picks blackout mode once, at the start of the night,
  // and should not have to find the button again on every page load.
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem('orchid.theme') as Theme | null) ?? 'stage',
  )
  const [error, setError] = useState<string | null>(null)
  const [levels, setLevels] = useState<Record<number, number>>({})
  const [editing, setEditing] = useState(false)
  const [layout, setLayout] = useState<LayoutRows | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const [dirty, setDirty] = useState(false)

  const live = useRef<Live | null>(null)

  useEffect(() => {
    const feed = new Live({
      onFunctions: setFunctions,
      onConnection: setConnection,
      onSlider: (id, value) => setLevels((current) => ({ ...current, [id]: value })),
    })
    live.current = feed
    feed.connect()

    api
      .vc()
      .then((console_) => {
        setVc(console_)
        // Seed the faders from the values the project was saved with, so the
        // interface opens showing the desk as the show left it.
        const seeded: Record<number, number> = {}
        const visit = (w: VcWidget) => {
          if (w.sliderMode && w.value !== undefined) seeded[w.id] = w.value
          if (w.speedTargets && w.speedMs !== undefined) seeded[w.id] = w.speedMs
          for (const child of w.children ?? []) visit(child)
        }
        visit(console_)
        setLevels(seeded)
      })
      // A project without a Virtual Console is normal, not a failure: plenty of
      // shows are driven straight from the function list.
      .catch(() => setVc(null))

    api.functions().then(setFunctions).catch(setErrorMessage)
    api
      .layout()
      .then((l) => setLayout(l.pages[0]?.rows ?? null))
      .catch(() => setLayout(null))

    return () => feed.close()

    function setErrorMessage(e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('orchid.theme', theme)
  }, [theme])

  const running = useMemo(
    () => new Set(functions.filter((f) => f.running).map((f) => f.id)),
    [functions],
  )

  const toggle = useCallback((id: number) => live.current?.toggle(id, running.has(id)), [running])

  const setSpeed = useCallback((id: number, milliseconds: number) => {
    setLevels((current) => ({ ...current, [id]: milliseconds }))
    live.current?.setSpeedDial(id, milliseconds)
  }, [])

  const setLevel = useCallback((id: number, value: number) => {
    // Optimistic: the fader follows the finger and the engine catches up on its
    // next tick. Waiting for a round trip would make a drag feel like mud.
    setLevels((current) => ({ ...current, [id]: value }))
    live.current?.setSlider(id, value)
  }, [])

  const pages = vc ? pagesOf(vc) : []
  const current = pages[page] ?? pages[0]
  const rows = current ? resolveRows(current.children ?? [], layout) : []

  const drop = useCallback(
    (rowIndex: number, beforeId: number | null) => {
      if (dragging === null) return
      setLayout((currentLayout) =>
        moveWidget(currentLayout ?? rowsToLayout(rows), dragging, rowIndex, beforeId),
      )
      setDragging(null)
      setDirty(true)
    },
    [dragging, rows],
  )

  const persist = useCallback(async () => {
    const pageId = current?.id ?? 0
    await api.putLayout({ pages: [{ id: pageId, rows: layout ?? rowsToLayout(rows) }] })
    await api.saveProject()
    setDirty(false)
  }, [current, layout, rows])

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">OrchidLights</span>
        <span className="chip" data-state={connection}>
          {connection === 'open'
            ? 'en vivo'
            : connection === 'closed'
              ? 'sin conexión'
              : connection}
        </span>
        <span className="chip">{running.size} en marcha</span>
        <span className="spacer" />
        <button
          type="button"
          onClick={() => setTheme(theme === 'stage' ? 'blackout' : 'stage')}
          title="Modo seguro para la oscuridad"
        >
          {theme === 'stage' ? '🌙' : '☀'}
        </button>
        {vc && (
          <button type="button" onClick={() => setEditing(!editing)} aria-pressed={editing}>
            {editing ? 'Listo' : 'Ordenar'}
          </button>
        )}
        {editing && dirty && (
          <button type="button" onClick={persist}>
            Guardar
          </button>
        )}
        <button type="button" className="danger" onClick={() => api.blackout(true)}>
          BLACKOUT
        </button>
      </header>

      {pages.length > 1 && (
        <nav className="pages">
          {pages.map((p, i) => (
            <button key={p.id} type="button" onClick={() => setPage(i)} aria-pressed={i === page}>
              {p.caption || `Página ${i + 1}`}
            </button>
          ))}
        </nav>
      )}

      <main className="console">
        {error && <p className="empty">{error}</p>}

        {current ? (
          <Surface
            rows={rows}
            running={running}
            onToggle={toggle}
            levels={levels}
            onLevel={setLevel}
            onSpeed={setSpeed}
            editing={editing}
            dragging={dragging}
            onDragStart={setDragging}
            onDrop={drop}
          />
        ) : (
          <FunctionList functions={functions} onToggle={toggle} />
        )}
      </main>
    </div>
  )
}

function Surface({
  rows,
  running,
  onToggle,
  levels,
  onLevel,
  onSpeed,
  editing,
  dragging,
  onDragStart,
  onDrop,
}: {
  rows: Row[]
  running: Set<number>
  onToggle: (id: number) => void
  levels: Record<number, number>
  onLevel: (id: number, value: number) => void
  onSpeed: (id: number, milliseconds: number) => void
  editing: boolean
  dragging: number | null
  onDragStart: (id: number | null) => void
  onDrop: (rowIndex: number, beforeId: number | null) => void
}) {
  if (rows.length === 0) {
    return <p className="empty">Esta página está vacía.</p>
  }

  return (
    <>
      {rows.map((row, rowIndex) => (
        <div className="row" key={`${rowIndex}-${row.widgets[0]?.id}`} data-editing={editing}>
          {row.widgets.map((child) => (
            <Fragment key={child.id}>
              {editing && dragging !== null && dragging !== child.id && (
                <DropSlot onDrop={() => onDrop(rowIndex, child.id)} />
              )}
              <Widget
                widget={child}
                grow={growFactor(child, row)}
                running={running}
                onToggle={onToggle}
                levels={levels}
                onLevel={onLevel}
                onSpeed={onSpeed}
                editing={editing}
                dragged={dragging === child.id}
                onDragStart={onDragStart}
              />
            </Fragment>
          ))}
          {editing && dragging !== null && <DropSlot onDrop={() => onDrop(rowIndex, null)} />}
        </div>
      ))}

      {editing && dragging !== null && (
        <div className="row">
          <DropSlot wide onDrop={() => onDrop(rows.length, null)} label="Nueva fila" />
        </div>
      )}
    </>
  )
}

/**
 * A place a dragged widget can land.
 *
 * pointerup rather than a drag event: HTML5 drag and drop does not fire on
 * touch at all, and this is meant to be used on a phone.
 */
function DropSlot({
  onDrop,
  wide,
  label,
}: {
  onDrop: () => void
  wide?: boolean
  label?: string
}) {
  return (
    <button
      type="button"
      className="dropslot"
      data-wide={wide === true}
      onPointerUp={onDrop}
      onClick={onDrop}
      aria-label={label ?? 'Soltar aquí'}
    >
      {label}
    </button>
  )
}

function Widget({
  widget,
  grow,
  running,
  onToggle,
  levels,
  onLevel,
  onSpeed,
  editing,
  dragged,
  onDragStart,
}: {
  widget: VcWidget
  grow: number
  running: Set<number>
  onToggle: (id: number) => void
  levels: Record<number, number>
  onLevel: (id: number, value: number) => void
  onSpeed: (id: number, milliseconds: number) => void
  editing: boolean
  dragged: boolean
  onDragStart: (id: number | null) => void
}) {
  const style = {
    '--grow': grow,
    ...(widget.background ? { '--widget-bg': widget.background } : {}),
    ...(widget.foreground ? { color: widget.foreground } : {}),
  } as React.CSSProperties

  // While arranging, every widget is a handle and nothing fires its function:
  // moving a button must never also press it.
  if (editing) {
    return (
      <button
        type="button"
        className={`widget ${widget.type} arranging`}
        style={style}
        data-dragged={dragged}
        onPointerDown={() => onDragStart(dragged ? null : widget.id)}
      >
        {widget.caption || widget.type}
      </button>
    )
  }

  if (widget.type === 'label') {
    return <div className="widget label">{widget.caption}</div>
  }

  if (widget.type === 'button' && widget.functionId !== undefined) {
    const id = widget.functionId
    return (
      <button
        type="button"
        className="widget button"
        style={style}
        data-running={running.has(id)}
        aria-pressed={running.has(id)}
        onClick={() => onToggle(id)}
      >
        {widget.caption || `#${id}`}
      </button>
    )
  }

  if (widget.speedTargets) {
    return (
      <SpeedDial
        widget={widget}
        style={style}
        value={levels[widget.id] ?? widget.speedMs ?? 0}
        onChange={onSpeed}
      />
    )
  }

  if (widget.sliderMode) {
    return (
      <Fader
        widget={widget}
        style={style}
        value={levels[widget.id] ?? widget.value ?? 0}
        onChange={onLevel}
      />
    )
  }

  if (isContainer(widget)) {
    return (
      <div className="widget" style={style}>
        {widget.caption || 'Grupo'}
      </div>
    )
  }

  // Sliders, XY pads, cue lists and the rest still need their own controls.
  // Showing them greyed out is honest; hiding them would make the console look
  // complete when it is not.
  return (
    <div className="widget unsupported" style={style}>
      {widget.caption || widget.type}
      <br />
      <small>({widget.type})</small>
    </div>
  )
}

function SpeedDial({
  widget,
  style,
  value,
  onChange,
}: {
  widget: VcWidget
  style: React.CSSProperties
  value: number
  onChange: (id: number, milliseconds: number) => void
}) {
  const min = widget.speedMin ?? 0
  const max = widget.speedMax ?? 10000
  const count = widget.speedTargets?.length ?? 0

  return (
    <label className="widget fader speeddial" style={style} data-usable="true">
      <span className="fader-caption">{widget.caption || 'Velocidad'}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={10}
        value={value}
        aria-label={widget.caption}
        onChange={(e) => onChange(widget.id, Number(e.target.value))}
      />
      <span className="fader-value">
        {value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(2)} s`}
        {count > 0 && <> · {count} fn</>}
      </span>
    </label>
  )
}

function Fader({
  widget,
  style,
  value,
  onChange,
}: {
  widget: VcWidget
  style: React.CSSProperties
  value: number
  onChange: (id: number, value: number) => void
}) {
  const low = widget.low ?? 0
  const high = widget.high ?? 255
  const percent = high > low ? Math.round(((value - low) / (high - low)) * 100) : 0

  // A playback or submaster slider parses fine but has nothing behind it here
  // yet. Showing it disabled is honest; showing it live would be a lie the
  // operator only discovers when the light does not move.
  const usable = widget.controllable === true

  return (
    <label className="widget fader" style={style} data-usable={usable}>
      <span className="fader-caption">{widget.caption || `#${widget.id}`}</span>
      <input
        type="range"
        min={low}
        max={high}
        value={value}
        disabled={!usable}
        aria-label={widget.caption}
        onChange={(e) => onChange(widget.id, Number(e.target.value))}
      />
      <span className="fader-value">{usable ? `${percent}%` : widget.sliderMode}</span>
    </label>
  )
}

function FunctionList({
  functions,
  onToggle,
}: {
  functions: FunctionState[]
  onToggle: (id: number) => void
}) {
  if (functions.length === 0) {
    return <p className="empty">No hay ningún proyecto cargado.</p>
  }

  return (
    <div className="row">
      {functions.map((f) => (
        <button
          key={f.id}
          type="button"
          className="widget button"
          data-running={f.running}
          aria-pressed={f.running}
          onClick={() => onToggle(f.id)}
        >
          {f.name}
        </button>
      ))}
    </div>
  )
}
