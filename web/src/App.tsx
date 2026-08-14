import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type FixtureState, type FunctionState, type WidgetPatch, api } from './api'
import { type LayoutRows, moveWidget, resolveRows, rowsToLayout } from './arrange'
import { CueList } from './cuelist'
import { WidgetEditor } from './editor'
import { type Row, type VcWidget, growFactor, isContainer, pagesOf } from './layout'
import { type Connection, Live } from './live'
import { CREATABLE, placeBelow } from './widgets'

type Theme = 'stage' | 'blackout'

/**
 * What the console is for right now.
 *
 * 'run' fires functions. 'arrange' reorders. 'edit' changes what the widgets
 * are. They are exclusive on purpose: in arrange mode a tap must never also
 * press the button it is moving, and the same goes for editing it.
 */
type Mode = 'run' | 'arrange' | 'edit'

/** Transport for a cue list: a chaser plus next and previous. */
type CueAction = 'play' | 'stop' | 'next' | 'previous' | 'step'

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
  const [mode, setMode] = useState<Mode>('run')
  const [layout, setLayout] = useState<LayoutRows | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const [dirty, setDirty] = useState(false)
  const [selected, setSelected] = useState<number | null>(null)
  const [fixtures, setFixtures] = useState<FixtureState[]>([])

  const live = useRef<Live | null>(null)
  const editing = mode === 'arrange'

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
          if (w.id !== undefined) {
            if (w.sliderMode && w.value !== undefined) seeded[w.id] = w.value
            if (w.speedTargets && w.speedMs !== undefined) seeded[w.id] = w.speedMs
          }
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
      .fixtures()
      .then(setFixtures)
      .catch(() => setFixtures([]))
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

  const cueList = useCallback((chaser: number, action: CueAction, index = -1) => {
    live.current?.cuelist(chaser, action, index)
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

  /* Every edit re-reads the console rather than patching the local copy: the
     daemon is the one that decides what a change means, and two clients editing
     the same show must not drift apart over it. */
  const refresh = useCallback(async () => {
    const console_ = await api.vc()
    setVc(console_)
    setDirty(true)
  }, [])

  const selectedWidget = useMemo(() => {
    if (selected === null || !vc) return null
    const find = (w: VcWidget): VcWidget | null => {
      if (w.id === selected) return w
      for (const child of w.children ?? []) {
        const found = find(child)
        if (found) return found
      }
      return null
    }
    return find(vc)
  }, [selected, vc])

  const editWidget = useCallback(
    async (patch: WidgetPatch) => {
      if (selected === null) return
      await api.editWidget(selected, patch)
      await refresh()
    },
    [selected, refresh],
  )

  const deleteWidget = useCallback(async () => {
    if (selected === null) return
    await api.removeWidget(selected)
    setSelected(null)
    await refresh()
  }, [selected, refresh])

  const unidentified = useMemo(() => {
    if (!vc) return 0
    const count = (w: VcWidget): number =>
      (w.id === undefined && w !== vc ? 1 : 0) +
      (w.children ?? []).reduce((n, child) => n + count(child), 0)
    return count(vc)
  }, [vc])

  const assignIds = useCallback(async () => {
    await api.assignWidgetIds()
    await refresh()
  }, [refresh])

  const addWidget = useCallback(
    async (type: string) => {
      const spec = CREATABLE.find((c) => c.type === type)

      const created = await api.addWidget({
        type,
        ...(current ? { parent: current.id } : {}),
        caption: spec?.label ?? type,
        geometry: placeBelow(current?.children ?? [], type),
      })

      await refresh()
      setSelected(Number(created.id))
    },
    [current, refresh],
  )

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
        {vc &&
          /* One control at a time. Showing "Ordenar" beside "Listo" made it
             read as two separate states, when there is only ever one. */
          (mode === 'run' ? (
            <>
              <button type="button" onClick={() => setMode('arrange')}>
                Ordenar
              </button>
              <button type="button" onClick={() => setMode('edit')}>
                Editar
              </button>
            </>
          ) : (
            <button
              type="button"
              aria-pressed={true}
              onClick={() => {
                setMode('run')
                setSelected(null)
              }}
            >
              Listo · {mode === 'arrange' ? 'ordenando' : 'editando'}
            </button>
          ))}
        {mode !== 'run' && dirty && (
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

      {mode === 'edit' && (
        <nav className="palette" aria-label="Añadir widget">
          <span className="hint">Añadir:</span>
          {CREATABLE.map((c) => (
            <button key={c.type} type="button" onClick={() => addWidget(c.type)}>
              + {c.label}
            </button>
          ))}
        </nav>
      )}

      {/* A console written by QLC+ 4 carries no widget ids, and every edit
          addresses a widget by id -- so it is not partly editable, it is not
          editable at all until this has run. Saying so beats a screen full of
          widgets that quietly refuse to be tapped. */}
      {mode === 'edit' && unidentified > 0 && (
        <div className="notice">
          <span>
            {unidentified} widgets vienen sin identificador, de una versión antigua de QLC+, y no se
            pueden editar hasta que lo tengan.
          </span>
          <button type="button" onClick={assignIds}>
            Asignar identificadores
          </button>
        </div>
      )}

      <div className="workspace">
        <main className="console">
          {error && <p className="empty">{error}</p>}

          {current ? (
            <Surface
              rows={rows}
              running={running}
              allFunctions={functions}
              onToggle={toggle}
              onCueList={cueList}
              levels={levels}
              onLevel={setLevel}
              onSpeed={setSpeed}
              editing={editing}
              dragging={dragging}
              onDragStart={setDragging}
              onDrop={drop}
              selecting={mode === 'edit'}
              selected={selected}
              onSelect={setSelected}
            />
          ) : (
            <FunctionList functions={functions} onToggle={toggle} />
          )}
        </main>

        {mode === 'edit' && selectedWidget && (
          <WidgetEditor
            widget={selectedWidget}
            functions={functions}
            fixtures={fixtures}
            onApply={editWidget}
            onDelete={deleteWidget}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
    </div>
  )
}

function Surface({
  rows,
  running,
  allFunctions,
  onToggle,
  onCueList,
  levels,
  onLevel,
  onSpeed,
  editing,
  dragging,
  onDragStart,
  onDrop,
  selecting,
  selected,
  onSelect,
}: {
  rows: Row[]
  running: Set<number>
  allFunctions: FunctionState[]
  onToggle: (id: number) => void
  onCueList: (chaser: number, action: CueAction, index?: number) => void
  levels: Record<number, number>
  onLevel: (id: number, value: number) => void
  onSpeed: (id: number, milliseconds: number) => void
  editing: boolean
  dragging: number | null
  onDragStart: (id: number | null) => void
  onDrop: (rowIndex: number, beforeId: number | null) => void
  selecting: boolean
  selected: number | null
  onSelect: (id: number) => void
}) {
  if (rows.length === 0) {
    return <p className="empty">Esta página está vacía.</p>
  }

  return (
    <>
      {rows.map((row, rowIndex) => (
        <div className="row" key={`${rowIndex}-${row.widgets[0]?.id}`} data-editing={editing}>
          {row.widgets.map((child, childIndex) => (
            // Position in the key, because an id is not guaranteed: a console
            // from QLC+ 4 has none until the operator asks for them.
            <Fragment key={child.id ?? `${rowIndex}-${childIndex}`}>
              {editing && dragging !== null && dragging !== child.id && (
                <DropSlot onDrop={() => onDrop(rowIndex, child.id ?? null)} />
              )}
              <Widget
                widget={child}
                grow={growFactor(child, row)}
                running={running}
                allFunctions={allFunctions}
                onToggle={onToggle}
                onCueList={onCueList}
                levels={levels}
                onLevel={onLevel}
                onSpeed={onSpeed}
                editing={editing}
                dragged={dragging === child.id}
                onDragStart={onDragStart}
                selecting={selecting}
                selected={selected === child.id}
                onSelect={onSelect}
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
  allFunctions,
  onToggle,
  onCueList,
  levels,
  onLevel,
  onSpeed,
  editing,
  dragged,
  onDragStart,
  selecting,
  selected,
  onSelect,
}: {
  widget: VcWidget
  grow: number
  running: Set<number>
  allFunctions: FunctionState[]
  onToggle: (id: number) => void
  onCueList: (chaser: number, action: CueAction, index?: number) => void
  levels: Record<number, number>
  onLevel: (id: number, value: number) => void
  onSpeed: (id: number, milliseconds: number) => void
  editing: boolean
  dragged: boolean
  onDragStart: (id: number | null) => void
  selecting: boolean
  selected: boolean
  onSelect: (id: number) => void
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
        onPointerDown={() => onDragStart(dragged ? null : (widget.id ?? null))}
      >
        {widget.caption || widget.type}
      </button>
    )
  }

  // And while editing, a tap picks the widget rather than operating it. Same
  // rule, same reason: choosing what a button does must not also press it.
  if (selecting) {
    return (
      <button
        type="button"
        className={`widget ${widget.type} arranging`}
        style={style}
        data-selected={selected}
        data-unidentified={widget.id === undefined}
        aria-pressed={selected}
        disabled={widget.id === undefined}
        onClick={() => widget.id !== undefined && onSelect(widget.id)}
      >
        {/* One child, so the line break works: .widget is a flex container and
            a bare <br> between two text nodes never breaks anything. */}
        <span>
          {widget.caption || widget.type}
          <br />
          <small>{widget.id === undefined ? 'sin identificador' : widget.type}</small>
        </span>
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

  if (widget.type === 'cuelist') {
    return <CueList widget={widget} style={style} functions={allFunctions} onCommand={onCueList} />
  }

  if (widget.speedTargets) {
    return (
      <SpeedDial
        widget={widget}
        style={style}
        value={levels[widget.id ?? -1] ?? widget.speedMs ?? 0}
        onChange={onSpeed}
      />
    )
  }

  if (widget.sliderMode) {
    return (
      <Fader
        widget={widget}
        style={style}
        value={levels[widget.id ?? -1] ?? widget.value ?? 0}
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
      <span>
        {widget.caption || widget.type}
        <br />
        <small>({widget.type})</small>
      </span>
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

  // Same as a level fader: the engine addresses a dial by widget id.
  const usable = widget.id !== undefined

  return (
    <label className="widget fader speeddial" style={style} data-usable={usable}>
      <span className="fader-caption">{widget.caption || 'Velocidad'}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={10}
        value={value}
        disabled={!usable}
        aria-label={widget.caption}
        onChange={(e) => widget.id !== undefined && onChange(widget.id, Number(e.target.value))}
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

  /* A playback or submaster slider parses fine but has nothing behind it here
     yet. Nor does one with no id: the engine keys its level sliders by widget
     id, so a fader without one has nothing to address.
   *
   * Disabled is honest either way. Showing it live would be a lie the operator
   * only discovers when the light does not move. */
  const usable = widget.controllable === true && widget.id !== undefined

  return (
    <label className="widget fader" style={style} data-usable={usable}>
      <span className="fader-caption">{widget.caption || `#${widget.id ?? '?'}`}</span>
      <input
        type="range"
        min={low}
        max={high}
        value={value}
        disabled={!usable}
        aria-label={widget.caption}
        onChange={(e) => widget.id !== undefined && onChange(widget.id, Number(e.target.value))}
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
