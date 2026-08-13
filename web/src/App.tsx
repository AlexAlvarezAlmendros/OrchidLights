import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type FunctionState, api } from './api'
import { type VcWidget, groupIntoRows, growFactor, isContainer, pagesOf } from './layout'
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

  const live = useRef<Live | null>(null)

  useEffect(() => {
    const feed = new Live({
      onFunctions: setFunctions,
      onConnection: setConnection,
    })
    live.current = feed
    feed.connect()

    api
      .vc()
      .then(setVc)
      // A project without a Virtual Console is normal, not a failure: plenty of
      // shows are driven straight from the function list.
      .catch(() => setVc(null))

    api.functions().then(setFunctions).catch(setErrorMessage)

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

  const pages = vc ? pagesOf(vc) : []
  const current = pages[page] ?? pages[0]

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
          <Surface widget={current} running={running} onToggle={toggle} />
        ) : (
          <FunctionList functions={functions} onToggle={toggle} />
        )}
      </main>
    </div>
  )
}

function Surface({
  widget,
  running,
  onToggle,
}: {
  widget: VcWidget
  running: Set<number>
  onToggle: (id: number) => void
}) {
  const children = widget.children ?? []
  if (children.length === 0) {
    return <p className="empty">Esta página está vacía.</p>
  }

  const rows = groupIntoRows(children)

  return (
    <>
      {rows.map((row) => (
        <div className="row" key={`${row.top}-${row.widgets[0]?.id}`}>
          {row.widgets.map((child) => (
            <Widget
              key={child.id}
              widget={child}
              grow={growFactor(child, row)}
              running={running}
              onToggle={onToggle}
            />
          ))}
        </div>
      ))}
    </>
  )
}

function Widget({
  widget,
  grow,
  running,
  onToggle,
}: {
  widget: VcWidget
  grow: number
  running: Set<number>
  onToggle: (id: number) => void
}) {
  const style = {
    '--grow': grow,
    ...(widget.background ? { '--widget-bg': widget.background } : {}),
    ...(widget.foreground ? { color: widget.foreground } : {}),
  } as React.CSSProperties

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
