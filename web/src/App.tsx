import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type FixtureState,
  type FunctionState,
  type ProjectState,
  type WidgetPatch,
  api,
} from './api'
import type { GrandMasterState } from './api'
import { Unauthorized } from './api'
import { type LayoutRows, moveWidget, resolveRows, rowsToLayout } from './arrange'
import { AudioTriggers } from './audiotriggers'
import { CueList } from './cuelist'
import { type Insertion, insertionAt, isNoop, sameInsertion } from './drag'
import { WidgetEditor } from './editor'
import { Functions } from './functions'
import {
  type Row,
  type VcWidget,
  childrenOnPage,
  groupIntoRows,
  growFactor,
  isContainer,
  pagesOf,
} from './layout'
import { type Connection, Live } from './live'
import { GrandMasterDock, StopAll } from './maestro'
import { MatrixWidget } from './matrix'
import { Nav } from './nav'
import { Plan } from './plan'
import { ProjectMenu } from './proyecto'
import { splitHeading, toSections } from './sections'
import { Setup } from './setup'
import { resolveClose, takePendingOpen } from './shell'
import { Slider } from './slider'
import { getToken, setToken } from './token'
import type { View } from './views'
import { CREATABLE, placeBelow } from './widgets'
import { XYPad } from './xypad'

type Theme = 'stage' | 'blackout'

/**
 * What the console is for right now.
 *
 * 'run' fires functions. 'arrange' reorders. 'edit' changes what the widgets
 * are. They are exclusive on purpose: in arrange mode a tap must never also
 * press the button it is moving, and the same goes for editing it.
 */
type Mode = 'run' | 'arrange' | 'edit'

/**
 * Which half of the application is on screen.
 *
 * 'console' is the desk. 'setup' is the patch -- universes, their output, and
 * the fixtures in them -- which is what makes light come out and which, until
 * now, was reachable only with curl.
 */

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
  /* The daemon's word, not this client's memory of pressing the button:
     seeded from /status and kept fresh by the feed, so a blackout engaged
     from a phone shows up here too. */
  const [blackout, setBlackout] = useState(false)
  const [grandMaster, setGrandMaster] = useState<GrandMasterState | null>(null)
  /* One transient line for things that went wrong out-of-band -- a rejected
     WS command, a lost connection. A press that does nothing and says nothing
     teaches the operator the desk is broken. */
  const [toast, setToast] = useState<string | null>(null)
  /* The daemon wants a token this client does not hold. Not an error state: a
     phone arriving at a --listen-all desk by bare URL lands here by design,
     types the token once, and never sees this again. */
  const [needToken, setNeedToken] = useState(false)
  /* The desktop shell asked "close with unsaved edits?" and the page owns the
     question: three honest answers where a native two-button dialog offers
     two. Null while nobody is closing. */
  const [closeAsk, setCloseAsk] = useState(false)
  const [levels, setLevels] = useState<Record<number, number>>({})
  /* Channels groups, kept apart from the console's faders on purpose: a group
     and a widget can both be number 3 and have nothing to do with each other. */
  const [groupLevels, setGroupLevels] = useState<Record<number, number>>({})
  /* Where each running show has got to, by function id. The daemon sends it
     while one plays; a local timer would drift and would keep counting after
     the show had stopped. */
  const [shows, setShows] = useState<Record<number, number>>({})
  /* The latest frame of each universe, kept only while the plan is open.
     Sixty frames a second through React state would re-render the whole app;
     the plan is the one screen that needs them, so nothing else subscribes. */
  const [frames, setFrames] = useState<Record<number, Uint8Array>>({})
  const [planError, setPlanError] = useState<string | null>(null)
  /* The last external control the daemon saw. Kept so the widget editor can
     learn a binding by watching for the next thing the operator touches. */
  const [lastInput, setLastInput] = useState<{
    universe: number
    channel: number
    value: number
  } | null>(null)
  const [mode, setMode] = useState<Mode>('run')
  const [layout, setLayout] = useState<LayoutRows | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  /* Where the widget being dragged would land if it were let go now, and where
     to draw the thing following the finger.
   *
     Both are live: the whole difference between a drag that feels solid and one
     that feels approximate is whether "where will this go?" is answered while
     the finger is still down, rather than after. */
  const [dropAt, setDropAt] = useState<Insertion | null>(null)
  const [ghost, setGhost] = useState<{ x: number; y: number; label: string } | null>(null)
  const [dirty, setDirty] = useState(false)
  const [selected, setSelected] = useState<number | null>(null)
  const [fixtures, setFixtures] = useState<FixtureState[]>([])
  /* What show is loaded and whether it has unsaved edits. A daemon can hold
     several over an evening, and "which one is up" is not a question anybody
     should have to leave the screen to answer. */
  const [project, setProject] = useState<ProjectState | null>(null)
  const [view, setView] = useState<View>('console')
  /* Operator mode: the console and nothing else.
   *
   * Sticky, because the phone this is for is taped to a truss and gets
   * reopened by somebody who did not put it there. It is a guard against a
   * sleeve on a screen, not a lock -- anybody who wants out gets out, and
   * saying otherwise would be the kind of claim this codebase does not make. */
  const [operator, setOperator] = useState(
    () => window.localStorage.getItem('orchid.operator') === 'yes',
  )
  const [pads, setPads] = useState<Record<number, { x: number; y: number }>>({})
  /** Bumped whenever the project changed under us, so the screens that keep
   *  their own state know to re-read it. */
  const [revision, setRevision] = useState(0)
  const [spectrum, setSpectrum] = useState<{ bands: number[]; volume: number }>({
    bands: [],
    volume: 0,
  })
  const [audio, setAudio] = useState<
    Record<number, { enabled: boolean; capturing: boolean; unavailable?: string }>
  >({})
  /** Which page of the frame on screen, for a frame that has pages. */
  const [framePage, setFramePage] = useState(0)
  /** How much of this console's editing history is behind and ahead. */
  const [history, setHistory] = useState({ undo: 0, redo: 0 })

  const live = useRef<Live | null>(null)
  const editing = mode === 'arrange'

  /* The panic shortcut, the same combination QLC+ uses. In the desktop shell
     a global shortcut covers the app being unfocused; this one covers every
     browser. */
  useEffect(() => {
    const panic = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !event.ctrlKey || !event.shiftKey) return
      event.preventDefault()
      api.stopAll(0).catch(() => undefined)
    }
    window.addEventListener('keydown', panic)
    return () => window.removeEventListener('keydown', panic)
  }, [])

  /* Stuck in 'auth' means the daemon asked and this client had no good
     answer. The successful handshake passes through the same state for
     milliseconds, so it only counts after it has settled. */
  useEffect(() => {
    if (connection !== 'auth') return
    const timer = setTimeout(() => setNeedToken(true), 1500)
    return () => clearTimeout(timer)
  }, [connection])

  /* The shell's hand-offs. Both arrive as window events so the SAME page code
     runs whether a path came from a native dialog, a file dropped on the
     window, or a second launch in a terminal -- and so a browser, which never
     receives them, needs no other code path removed or faked. */
  useEffect(() => {
    /* Pull, don't catch: the shell PARKS the path and pings, and this pulls
       it -- on the ping, and once on mount, which is what makes a request
       that arrived while the splash was still up (or before React mounted)
       impossible to lose. The pull consumes, so mount+ping never double-open. */
    const claim = () => {
      takePendingOpen()
        .then((path) => {
          if (path === null) return
          if (
            dirty &&
            !window.confirm('Hay cambios sin guardar que se perderán. ¿Abrir igualmente?')
          )
            return
          return api.openProjectPath(path)
        })
        .catch((e: unknown) => setToast(e instanceof Error ? e.message : String(e)))
    }
    const onCloseRequest = () => setCloseAsk(true)

    claim()
    window.addEventListener('orchid-open-ping', claim)
    window.addEventListener('orchid-close-request', onCloseRequest)
    return () => {
      window.removeEventListener('orchid-open-ping', claim)
      window.removeEventListener('orchid-close-request', onCloseRequest)
    }
  }, [dirty])

  /* Closing a tab with unsaved edits gets the browser's own "are you sure".
     Only while dirty: registering it permanently would nag on every close. */
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => {
      /* Without a user gesture the browser refuses the panel anyway and logs
         a warning about the attempt -- so asking is pure noise exactly when
         nobody is there to answer. The suite's zero-console-errors net is
         what caught this. */
      if (navigator.userActivation?.hasBeenActive !== true) return
      event.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  /* A toast is a moment, not a state: it clears itself so the next problem is
     legible, and touching nothing else. */
  useEffect(() => {
    if (toast === null) return
    const timer = setTimeout(() => setToast(null), 6000)
    return () => clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    const feed = new Live({
      onFunctions: setFunctions,
      onConnection: setConnection,
      onSlider: (id, value) => setLevels((current) => ({ ...current, [id]: value })),
      onChannelGroup: (id, value) => setGroupLevels((current) => ({ ...current, [id]: value })),
      onInput: (universe, channel, value) => setLastInput({ universe, channel, value }),
      onUniverse: (universe, channels) =>
        setFrames((current) => ({ ...current, [universe]: channels })),
      onShow: (id, elapsed, running) =>
        setShows((current) => {
          if (running) return { ...current, [id]: elapsed }
          const { [id]: _gone, ...rest } = current
          return rest
        }),
      onPad: (id, x, y) => setPads((current) => ({ ...current, [id]: { x, y } })),
      onSpectrum: (bands, volume) => setSpectrum({ bands, volume }),
      onAudioTriggers: (id, state) => setAudio((current) => ({ ...current, [id]: state })),
      onBlackout: setBlackout,
      onGrandMaster: setGrandMaster,
      onError: setToast,
      onProject: (isDirty) => {
        setDirty(isDirty)
        /* The identity (name, autosave) re-reads cheaply; the flag is what
           needs to be instant. */
        api
          .project()
          .then(setProject)
          .catch(() => undefined)
      },
      /* Somebody else edited the show. Re-read what they touched rather than
         patching a local copy from the message: the daemon decides what a
         change means, and two clients guessing at it is how they drift. */
      onChanged: (what) => {
        const all = what.includes('project')
        if (all || what.includes('vc'))
          api
            .vc()
            .then(setVc)
            .catch(() => undefined)
        if (all || what.includes('fixtures')) {
          api
            .fixtures()
            .then(setFixtures)
            .catch(() => undefined)
        }
        if (all) {
          api
            .layout()
            .then((l) => setLayout(l.pages[0]?.rows ?? null))
            .catch(() => undefined)
        }
        /* The patch screen holds its own state; this is what tells it to look
           again.
         *
         * Deliberately not bumped for a plain "functions" change: the function
         * list already has a live channel of its own, and bumping here made the
         * open function editor re-read the body of a function that had just
         * been deleted -- a 404 for something the client should have known was
         * gone. */
        if (all || what.includes('vc') || what.includes('groups')) {
          setRevision((n) => n + 1)
        }

        /* Anything at all changed the document, so the unsaved marker in the
           header is stale. It is cheap and it is the only warning there is. */
        api
          .project()
          .then(setProject)
          .catch(() => undefined)
      },
    })
    live.current = feed
    feed.connect(getToken() ?? undefined)

    api
      .project()
      .then((state) => {
        setProject(state)
        setDirty(state.modified)
      })
      .catch(() => setProject(null))

    api
      .vc()
      .then((console_) => {
        setVc(console_)
        // The one field of /status the console needs at boot; the feed keeps
        // it fresh afterwards.
        api
          .status()
          .then((status) => setBlackout(status.blackout === true))
          .catch(() => undefined)
        api
          .grandMaster()
          .then(setGrandMaster)
          .catch(() => setGrandMaster(null))
        // Seed the faders from the values the project was saved with, so the
        // interface opens showing the desk as the show left it.
        const seeded: Record<number, number> = {}
        const seededPads: Record<number, { x: number; y: number }> = {}
        const visit = (w: VcWidget) => {
          if (w.id !== undefined) {
            if (w.sliderMode && w.value !== undefined) seeded[w.id] = w.value
            if (w.speedTargets && w.speedMs !== undefined) seeded[w.id] = w.speedMs
            if (w.padHeads) seededPads[w.id] = { x: w.padX ?? 0, y: w.padY ?? 0 }
          }
          for (const child of w.children ?? []) visit(child)
        }
        visit(console_)
        setLevels(seeded)
        setPads(seededPads)
      })
      // A project without a Virtual Console is normal, not a failure: plenty of
      // shows are driven straight from the function list.
      .catch(() => setVc(null))

    api
      .functions()
      .then(setFunctions)
      .catch((e: unknown) => {
        if (e instanceof Unauthorized) setNeedToken(true)
        else setErrorMessage(e)
      })
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

  const flash = useCallback((id: number, on: boolean) => live.current?.flash(id, on), [])

  /* The two button actions that have no function behind them. Stop-all walks
     the running set through the same stop path a tap uses -- the daemon's
     stop-everything call arrives with F6, and until then this is the honest
     version, not a dead control. */
  const buttonAction = useCallback(
    (action: 'Blackout' | 'StopAll') => {
      if (action === 'Blackout') {
        api.blackout(!blackout).then(
          (state) => setBlackout(state.blackout),
          (e: unknown) => setToast(e instanceof Error ? e.message : String(e)),
        )
        return
      }
      for (const id of running) live.current?.toggle(id, true)
    },
    [blackout, running],
  )

  const setSpeed = useCallback((id: number, milliseconds: number) => {
    setLevels((current) => ({ ...current, [id]: milliseconds }))
    live.current?.setSpeedDial(id, milliseconds)
  }, [])

  const cueList = useCallback((chaser: number, action: CueAction, index = -1) => {
    live.current?.cuelist(chaser, action, index)
  }, [])

  const toggleAudio = useCallback((id: number, enabled: boolean) => {
    live.current?.setAudioTriggers(id, enabled)
  }, [])

  const applyPreset = useCallback((id: number, preset: number) => {
    live.current?.setMatrixPreset(id, preset)
  }, [])

  const movePad = useCallback((id: number, x: number, y: number) => {
    // Optimistic, like a fader: the dot follows the finger and the engine
    // catches up on its next tick.
    setPads((current) => ({ ...current, [id]: { x, y } }))
    live.current?.setPad(id, x, y)
  }, [])

  /* A channels group's fader. Its own map because group ids and widget ids are
     different id spaces: both start at 0 and mean different things. */
  const setGroupLevel = useCallback((id: number, value: number) => {
    setGroupLevels((current) => ({ ...current, [id]: value }))
    live.current?.setChannelGroup(id, value)
  }, [])

  const setLevel = useCallback((id: number, value: number) => {
    // Optimistic: the fader follows the finger and the engine catches up on its
    // next tick. Waiting for a round trip would make a drag feel like mud.
    setLevels((current) => ({ ...current, [id]: value }))
    live.current?.setSlider(id, value)
  }, [])

  /* DMX frames only while the plan is open.
   *
   * They arrive at the flush rate, and pushing them through React state re-
   * renders whatever is mounted. The plan is the one screen that needs them, so
   * nothing else pays for them -- and the frames are dropped on the way out, so
   * coming back never shows a stale look as if it were current. */
  useEffect(() => {
    const ids = [...new Set(fixtures.map((f) => f.universe))]
    if (ids.length === 0) return

    if (view !== 'plan') {
      live.current?.unsubscribe(ids)
      setFrames({})
      return
    }

    live.current?.subscribe(ids)
    return () => {
      live.current?.unsubscribe(ids)
      setFrames({})
    }
  }, [view, fixtures])

  const pages = vc ? pagesOf(vc) : []
  const current = pages[page] ?? pages[0]

  /* Paging is the frame's own: QLC+ stores pages per frame, not per console,
     and each child names its page in @Page. Ignoring that draws every page on
     top of the others. */
  const framePages = current?.pages ?? 0
  const rows = current ? resolveRows(childrenOnPage(current, framePage), layout) : []

  const drop = useCallback(
    (rowIndex: number, beforeId: number | null) => {
      if (dragging === null) return

      const from = layout ?? rowsToLayout(rows)

      /* Dropping a widget back where it already was is not an edit. Marking the
         show modified for it would put a Guardar button on screen for a move
         that never happened. */
      if (isNoop(from, dragging, { rowIndex, beforeId })) {
        setDragging(null)
        setDropAt(null)
        setGhost(null)
        return
      }

      setLayout(moveWidget(from, dragging, rowIndex, beforeId))
      setDragging(null)
      setDropAt(null)
      setGhost(null)
      setDirty(true)
    },
    [dragging, layout, rows],
  )

  /**
   * Following the finger.
   *
   * The insertion point is read off whatever is under the pointer rather than
   * from rects measured when the drag began: the console reflows -- rows wrap
   * at every width, and a widget leaving one changes where the rest sit -- so
   * anything measured up front is wrong as soon as it matters. The ghost is
   * pointer-events: none precisely so this sees through it.
   */
  const dragOver = useCallback((x: number, y: number) => {
    const under = document.elementFromPoint(x, y)
    if (under === null) return

    const widget = under.closest<HTMLElement>('[data-widget-id]')

    if (widget !== null) {
      const rowIndex = Number(widget.dataset.row ?? 0)
      const id = widget.dataset.widgetId === '' ? null : Number(widget.dataset.widgetId)
      const box = widget.getBoundingClientRect()

      const after = widget.nextElementSibling?.closest<HTMLElement>('[data-widget-id]') ?? null
      const next =
        after === null
          ? null
          : {
              id: after.dataset.widgetId === '' ? null : Number(after.dataset.widgetId),
              rowIndex: Number(after.dataset.row ?? 0),
              left: 0,
              right: 0,
            }

      const where = insertionAt({ id, rowIndex, left: box.left, right: box.right }, x, next)
      setDropAt((current) => (sameInsertion(current, where) ? current : where))
      return
    }

    /* Past the end of a row but still inside it: append there. Below every row:
       a new one. Anywhere else, keep the last answer rather than flickering to
       nothing -- a caret that disappears while the finger is still moving reads
       as the drag having been dropped. */
    const row = under.closest<HTMLElement>('.row[data-row]')
    if (row !== null) {
      const where = { rowIndex: Number(row.dataset.row ?? 0), beforeId: null }
      setDropAt((current) => (sameInsertion(current, where) ? current : where))
      return
    }

    if (under.closest('.newrow') !== null) {
      setDropAt((current) =>
        sameInsertion(current, { rowIndex: rowsRef.current, beforeId: null })
          ? current
          : { rowIndex: rowsRef.current, beforeId: null },
      )
    }
  }, [])

  /* The row count, read during a pointer move without making the callback
     depend on it -- a drag handler rebuilt mid-gesture drops the gesture. */
  const rowsRef = useRef(0)
  rowsRef.current = rows.length

  const dragMove = useCallback(
    (x: number, y: number, label: string) => {
      setGhost({ x, y, label })
      dragOver(x, y)
    },
    [dragOver],
  )

  /* Reading the landing point out of state at the moment the finger lifts,
     rather than closing over it: the handler is attached once per render and
     the drop has to use where the caret actually is, not where it was when
     this callback was built. */
  const dropAtRef = useRef<Insertion | null>(null)
  dropAtRef.current = dropAt

  const dragEnd = useCallback(() => {
    const where = dropAtRef.current
    if (where === null) {
      /* Let go somewhere that is not a place: nothing moves, and the widget is
         put back down rather than left waiting. */
      setDragging(null)
      setGhost(null)
      return
    }
    drop(where.rowIndex, where.beforeId)
  }, [drop])

  /* Escape puts it back. A drag with no way out is a drag people are afraid to
     start. */
  useEffect(() => {
    if (dragging === null && selected === null) return

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setDragging(null)
      setDropAt(null)
      setGhost(null)
      setSelected(null)
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dragging, selected])

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
    api
      .vcHistory()
      .then(setHistory)
      .catch(() => undefined)
  }, [])

  const undo = useCallback(async () => {
    await api.undoConsole()
    await refresh()
  }, [refresh])

  const redo = useCallback(async () => {
    await api.redoConsole()
    await refresh()
  }, [refresh])

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

  /* The patch decides what the console can point at, so a fixture added or
     removed there has to reach the widget editor's channel picker. Deleting one
     also edits the console itself, which is why the tree is re-read too. */
  const reloadFixtures = useCallback(() => {
    api
      .fixtures()
      .then(setFixtures)
      .catch(() => undefined)
    api
      .vc()
      .then(setVc)
      .catch(() => undefined)
  }, [])

  /* Functions change under the console: a widget can point at one that has
     just been renamed or deleted, so both lists are re-read together. */
  const reloadFunctions = useCallback(() => {
    api
      .functions()
      .then(setFunctions)
      .catch(() => undefined)
    setDirty(true)
  }, [])

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

  const enterOperator = useCallback(() => {
    setOperator(true)
    setView('console')
    setMode('run')
    setSelected(null)
    window.localStorage.setItem('orchid.operator', 'yes')
  }, [])

  const leaveOperator = useCallback(() => {
    setOperator(false)
    window.localStorage.removeItem('orchid.operator')
  }, [])

  return (
    <div className="app" data-operator={operator}>
      {/* Where you are, down the left with room and across the bottom without.
          Gone in operator mode, along with everything else that is not the
          console. */}
      {!operator && (
        <Nav
          view={view}
          theme={theme}
          onView={(target) => {
            setView(target)
            setMode('run')
            setSelected(null)
          }}
          onTheme={() => setTheme(theme === 'stage' ? 'blackout' : 'stage')}
        />
      )}

      {/* Everything that is not the rail. One column, so the shell is a grid of
          exactly two things and nothing else has to declare where it lives. */}
      <div className="screen">
        <header className="showbar">
          {/* What is loaded and whether it is alive -- the two things worth a
            permanent place. The name is the show, not the product: an operator
            with three shows on one daemon needs to know which one is up. */}
          <div className="showbar-id">
            <ProjectMenu
              name={project?.name.replace(/\.qxw$/i, '') || 'OrchidLights'}
              dirty={dirty}
              onError={setToast}
            />
            <span>
              {fixtures.length} fixtures
              {dirty ? ' · sin guardar' : ''}
            </span>
          </div>

          <GrandMasterDock state={grandMaster} onState={setGrandMaster} onError={setToast} />

          <span className="chip" data-state={connection}>
            <span className="dot" />
            {connection === 'open'
              ? 'en vivo'
              : connection === 'closed'
                ? 'sin conexión'
                : connection}
          </span>
          {running.size > 0 && <span className="chip">{running.size} en marcha</span>}

          <span className="spacer" />

          {operator ? (
            <Unlock onUnlock={leaveOperator} />
          ) : (
            <button type="button" onClick={enterOperator} title="Solo la consola, sin edición">
              Operador
            </button>
          )}
          {!operator &&
            view === 'console' &&
            vc &&
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
          {view === 'console' && mode === 'edit' && (
            <>
              <button type="button" disabled={history.undo === 0} onClick={undo} title="Deshacer">
                ↶ {history.undo || ''}
              </button>
              <button type="button" disabled={history.redo === 0} onClick={redo} title="Rehacer">
                ↷ {history.redo || ''}
              </button>
            </>
          )}
          {/* Reachable whenever there is something to save. It used to hide
              outside the console's edit modes, which left every other screen
              -- patch a fixture, edit a function -- with the "sin guardar"
              notice and no way to act on it. */}
          {dirty && (
            <button type="button" onClick={persist}>
              Guardar
            </button>
          )}
          <StopAll running={running.size} onError={setToast} />
          <button
            type="button"
            className="danger"
            data-active={blackout}
            aria-pressed={blackout}
            onClick={() =>
              api.blackout(!blackout).then(
                (state) => setBlackout(state.blackout),
                (e: unknown) => setToast(e instanceof Error ? e.message : String(e)),
              )
            }
          >
            {blackout ? 'SALIR DE BLACKOUT' : 'BLACKOUT'}
          </button>
        </header>

        {toast !== null && (
          <p className="toast" role="alert">
            {toast}
          </p>
        )}

        {/* A crash left edits newer than the file. Offered, never auto-loaded:
            whether the last thirty seconds beat the file is the operator's
            call, and "Seguir con el archivo" leaves the shadow alone (the
            next real save clears it). */}
        {project?.autosave && (
          <div className="notice">
            <span>
              Hay una copia de recuperación más nueva que el proyecto (guardada{' '}
              {new Date(project.autosave.savedAt).toLocaleTimeString()}).
            </span>
            <button
              type="button"
              onClick={() =>
                api.recoverAutosave().then(
                  () => api.project().then(setProject, () => undefined),
                  (e: unknown) => setToast(e instanceof Error ? e.message : String(e)),
                )
              }
            >
              Recuperar
            </button>
            <button
              type="button"
              onClick={() =>
                setProject((current) => {
                  if (current === null) return current
                  // exactOptionalPropertyTypes: absent, not undefined.
                  const { autosave: _dismissed, ...rest } = current
                  return rest
                })
              }
            >
              Seguir con el archivo
            </button>
          </div>
        )}

        {/* Closing the desktop window over unsaved edits. Guardar y salir is
            first because it is almost always the answer; Cancelar leaves
            everything exactly as it was. */}
        {closeAsk && (
          <dialog className="gate" open aria-label="Cerrar con cambios sin guardar">
            <div className="gate-card">
              <h2>Hay cambios sin guardar</h2>
              <p>¿Guardar el proyecto antes de salir?</p>
              <button
                type="button"
                onClick={() =>
                  api.saveProject().then(
                    () => resolveClose(),
                    (e: unknown) => {
                      setCloseAsk(false)
                      setToast(e instanceof Error ? e.message : String(e))
                    },
                  )
                }
              >
                Guardar y salir
              </button>
              <button type="button" onClick={() => resolveClose()}>
                Salir sin guardar
              </button>
              <button type="button" onClick={() => setCloseAsk(false)}>
                Cancelar
              </button>
            </div>
          </dialog>
        )}

        {/* Full-screen on purpose: nothing behind it works without the token,
            and a console that half-renders and half-refuses reads as broken
            rather than as locked. */}
        {needToken && (
          <dialog className="gate" open aria-label="Conectar con la mesa">
            <form
              className="gate-card"
              onSubmit={(event) => {
                event.preventDefault()
                const field = event.currentTarget.elements.namedItem('token') as HTMLInputElement
                if (field.value.trim() === '') return
                setToken(field.value)
                /* A full reload rather than surgical refetches: every request
                   and the feed must retry with the new token, and boot already
                   knows how to bring everything up in order. */
                window.location.reload()
              }}
            >
              <h2>Conectar con la mesa</h2>
              <p>
                Este daemon pide un token. Está en el archivo <code>~/.orchidlights/api-token</code>{' '}
                de la máquina que lo ejecuta.
              </p>
              <input
                name="token"
                type="password"
                autoComplete="off"
                placeholder="Token"
                aria-label="Token de acceso"
              />
              <button type="submit">Conectar</button>
            </form>
          </dialog>
        )}

        {view === 'console' && (pages.length > 1 || framePages > 1) && (
          <nav className="pages">
            {pages.length > 1 &&
              pages.map((p, i) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    setPage(i)
                    setFramePage(0)
                  }}
                  aria-pressed={i === page}
                >
                  {p.caption || `Página ${i + 1}`}
                </button>
              ))}
            {framePages > 1 &&
              Array.from({ length: framePages }, (_, i) => (
                <button
                  // biome-ignore lint/suspicious/noArrayIndexKey: the index is the page
                  key={`page-${i}`}
                  type="button"
                  onClick={() => setFramePage(i)}
                  aria-pressed={i === framePage}
                >
                  {i + 1}
                </button>
              ))}
          </nav>
        )}

        {/* What the mode expects of you, in one line.
       *
         Both non-run modes change what a tap does, and a screen that changes
         under your finger without saying so is a screen you learn by making
         mistakes on. One sentence costs nothing and removes the whole class. */}
        {view === 'console' && mode !== 'run' && (
          <p className="modehint">
            {mode === 'arrange'
              ? 'Arrastra un widget para moverlo, o tócalo y luego toca un hueco. Escape lo devuelve.'
              : 'Toca un widget para editarlo. Escape cierra el panel.'}
          </p>
        )}

        {view === 'console' && mode === 'edit' && (
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
        {view === 'console' && mode === 'edit' && unidentified > 0 && (
          <div className="notice">
            <span>
              {unidentified} widgets vienen sin identificador, de una versión antigua de QLC+, y no
              se pueden editar hasta que lo tengan.
            </span>
            <button type="button" onClick={assignIds}>
              Asignar identificadores
            </button>
          </div>
        )}

        {/* The thing that follows the finger.
       *
         Fixed to the viewport and outside every scrolling box, because a ghost
         clipped by the container it started in stops being a ghost. It never
         takes a pointer event: the drop target is read with elementFromPoint,
         and a ghost that answered would be the only thing ever found. */}
        {ghost !== null && (
          <div
            className="ghost"
            style={{ left: `${ghost.x}px`, top: `${ghost.y}px` }}
            aria-hidden="true"
          >
            {ghost.label}
          </div>
        )}

        {view === 'plan' ? (
          <main className="console">
            {planError && <p className="editor-error">{planError}</p>}
            <Plan
              revision={revision}
              universes={frames}
              functions={functions}
              running={running}
              blackout={blackout}
              onBlackout={() => buttonAction('Blackout')}
              onToggle={toggle}
              onError={setPlanError}
            />
          </main>
        ) : view === 'setup' ? (
          <main className="console">
            {/* The patch changes what the console is pointing at, so a fixture
              added or removed here has to reach the widget editor too. */}
            <Setup
              revision={revision}
              levels={groupLevels}
              onLevel={setGroupLevel}
              onChanged={reloadFixtures}
            />
          </main>
        ) : view === 'functions' ? (
          <main className="console">
            <Functions
              functions={functions}
              fixtures={fixtures}
              shows={shows}
              running={running}
              revision={revision}
              onToggle={toggle}
              onChanged={reloadFunctions}
            />
          </main>
        ) : (
          <div className="workspace">
            <main
              className="console"
              /* Tapping the space around the widgets puts the panel away. Every
               interface with a selection has this, and its absence is only
               noticed as a nagging sense that something is stuck open. */
              onPointerDown={(event) => {
                if (mode !== 'edit') return
                if ((event.target as HTMLElement).closest('.widget') !== null) return
                setSelected(null)
              }}
            >
              {error && <p className="empty">{error}</p>}

              {current ? (
                <Surface
                  rows={rows}
                  running={running}
                  allFunctions={functions}
                  onToggle={toggle}
                  desk={{ blackout, onFlash: flash, onAction: buttonAction }}
                  onCueList={cueList}
                  pads={pads}
                  onPad={movePad}
                  onPreset={applyPreset}
                  audio={audio}
                  spectrum={spectrum}
                  onAudio={toggleAudio}
                  levels={levels}
                  onLevel={setLevel}
                  onSpeed={setSpeed}
                  editing={editing}
                  dragging={dragging}
                  dropAt={dropAt}
                  ghost={ghost}
                  onDragStart={setDragging}
                  onDragMove={dragMove}
                  onDragEnd={dragEnd}
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
                learning={lastInput}
                onApply={editWidget}
                onDelete={deleteWidget}
                onClose={() => setSelected(null)}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** What a button needs beyond its own function: the desk-wide actions.
 *  Bundled so the plumbing through Surface and NestedFrame stays one prop. */
interface DeskActions {
  blackout: boolean
  onFlash: (id: number, on: boolean) => void
  onAction: (action: 'Blackout' | 'StopAll') => void
}

function Surface({
  rows,
  running,
  allFunctions,
  onToggle,
  onCueList,
  pads,
  onPad,
  onPreset,
  audio,
  spectrum,
  onAudio,
  levels,
  onLevel,
  onSpeed,
  editing,
  dragging,
  dropAt,
  ghost,
  onDragStart,
  onDragMove,
  onDragEnd,
  onDrop,
  selecting,
  selected,
  onSelect,
  desk,
}: {
  rows: Row[]
  running: Set<number>
  allFunctions: FunctionState[]
  onToggle: (id: number) => void
  desk: DeskActions
  onCueList: (chaser: number, action: CueAction, index?: number) => void
  pads: Record<number, { x: number; y: number }>
  onPad: (id: number, x: number, y: number) => void
  onPreset: (id: number, preset: number) => void
  audio: Record<number, { enabled: boolean; capturing: boolean; unavailable?: string }>
  spectrum: { bands: number[]; volume: number }
  onAudio: (id: number, enabled: boolean) => void
  levels: Record<number, number>
  onLevel: (id: number, value: number) => void
  onSpeed: (id: number, milliseconds: number) => void
  editing: boolean
  dragging: number | null
  dropAt: Insertion | null
  ghost: { x: number; y: number; label: string } | null
  onDragStart: (id: number | null) => void
  onDragMove: (x: number, y: number, label: string) => void
  onDragEnd: () => void
  onDrop: (rowIndex: number, beforeId: number | null) => void
  selecting: boolean
  selected: number | null
  onSelect: (id: number) => void
}) {
  if (rows.length === 0) {
    return <p className="empty">Esta página está vacía.</p>
  }

  /* Two ways to draw the same console.
   *
     Running it, the console is a screen: sections with headings, a grid of
     equal controls, faders in a column of their own. Arranging or editing it,
     it is the operator's own rows again -- because that is what is being
     arranged, and a drag that reorders something drawn somewhere else is a drag
     nobody can aim.
   *
     Neither changes the project. The grid flows in document order, so the order
     arranged in the other mode is still the order that comes out here. */
  if (!editing && !selecting) {
    const sections = toSections(rows)

    const draw = (widget: VcWidget, index: number) => (
      <Widget
        key={widget.id ?? `w-${index}`}
        widget={widget}
        rowIndex={0}
        dropBefore={false}
        grow={1}
        running={running}
        allFunctions={allFunctions}
        onToggle={onToggle}
        desk={desk}
        onCueList={onCueList}
        pads={pads}
        onPad={onPad}
        onPreset={onPreset}
        audio={audio}
        spectrum={spectrum}
        onAudio={onAudio}
        levels={levels}
        onLevel={onLevel}
        onSpeed={onSpeed}
        editing={false}
        dragged={false}
        onDragStart={onDragStart}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
        selecting={false}
        selected={false}
        onSelect={onSelect}
      />
    )

    /* Every fader in one column, for the whole console rather than per section.
     *
       A fader is a thing you hold while you press other things, so it wants to
       be in the same place all the time and always reachable -- which is what a
       desk does with them, and what a per-section strip cannot do: it puts the
       levels wherever their heading happens to fall, and leaves a hole beside
       whichever section is short.
     *
       The section each group came from stays written above it, so nothing is
       lost by moving them. */
    const levelGroups = sections
      .filter((section) => section.levels.length > 0)
      .map((section) => ({ title: section.title, widgets: section.levels }))

    return (
      <div className="board" data-levels={levelGroups.length > 0}>
        <div className="blocks">
          {sections.map((section, index) => (
            <section className="block" key={section.title ?? `block-${index}`}>
              {section.title !== null && <Heading text={section.title} />}
              {section.controls.length > 0 && (
                <div className="grid">{section.controls.map(draw)}</div>
              )}
            </section>
          ))}
        </div>

        {levelGroups.length > 0 && (
          <aside className="levels" aria-label="Niveles">
            <h2 className="section">Niveles</h2>
            {levelGroups.map((group, index) => (
              <div className="levels-group" key={group.title ?? `levels-${index}`}>
                {/* Only worth a caption when there is more than one group to
                    tell apart. */}
                {levelGroups.length > 1 && group.title !== null && (
                  <span className="levels-title">{group.title}</span>
                )}
                {group.widgets.map(draw)}
              </div>
            ))}
          </aside>
        )}
      </div>
    )
  }

  return (
    <>
      {rows.map((row, rowIndex) => (
        <div
          className="row"
          key={`${rowIndex}-${row.widgets[0]?.id}`}
          data-editing={editing}
          data-row={rowIndex}
        >
          {row.widgets.map((child, childIndex) => (
            // Position in the key, because an id is not guaranteed: a console
            // from QLC+ 4 has none until the operator asks for them.
            <Fragment key={child.id ?? `${rowIndex}-${childIndex}`}>
              {/* The sticky path: tapped rather than dragged, the widget waits
                  and every gap becomes a target. Kept because it is the precise
                  way to place something on a phone, and the only way without a
                  pointer at all. */}
              {editing && dragging !== null && dragging !== child.id && ghost === null && (
                <DropSlot onDrop={() => onDrop(rowIndex, child.id ?? null)} />
              )}
              <Widget
                widget={child}
                rowIndex={rowIndex}
                dropBefore={
                  dropAt !== null &&
                  dropAt.rowIndex === rowIndex &&
                  dropAt.beforeId === (child.id ?? null)
                }
                grow={growFactor(child, row)}
                running={running}
                allFunctions={allFunctions}
                onToggle={onToggle}
                desk={desk}
                onCueList={onCueList}
                pads={pads}
                onPad={onPad}
                onPreset={onPreset}
                audio={audio}
                spectrum={spectrum}
                onAudio={onAudio}
                levels={levels}
                onLevel={onLevel}
                onSpeed={onSpeed}
                editing={editing}
                dragged={dragging === child.id}
                onDragStart={onDragStart}
                onDragMove={onDragMove}
                onDragEnd={onDragEnd}
                selecting={selecting}
                selected={selected === child.id}
                onSelect={onSelect}
              />
            </Fragment>
          ))}
          {editing && dragging !== null && ghost === null && (
            <DropSlot onDrop={() => onDrop(rowIndex, null)} />
          )}
          {/* The caret for "at the end of this row", which has no widget to sit
              in front of. */}
          {editing &&
            dropAt !== null &&
            dropAt.rowIndex === rowIndex &&
            dropAt.beforeId === null && <span className="caret" aria-hidden="true" />}
        </div>
      ))}

      {editing && dragging !== null && (
        <div className="row newrow" data-active={dropAt !== null && dropAt.rowIndex >= rows.length}>
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
  desk,
  onCueList,
  pads,
  onPad,
  onPreset,
  audio,
  spectrum,
  onAudio,
  levels,
  onLevel,
  onSpeed,
  editing,
  dragged,
  rowIndex,
  dropBefore,
  onDragStart,
  onDragMove,
  onDragEnd,
  selecting,
  selected,
  onSelect,
}: {
  widget: VcWidget
  grow: number
  running: Set<number>
  allFunctions: FunctionState[]
  onToggle: (id: number) => void
  desk: DeskActions
  onCueList: (chaser: number, action: CueAction, index?: number) => void
  pads: Record<number, { x: number; y: number }>
  onPad: (id: number, x: number, y: number) => void
  onPreset: (id: number, preset: number) => void
  audio: Record<number, { enabled: boolean; capturing: boolean; unavailable?: string }>
  spectrum: { bands: number[]; volume: number }
  onAudio: (id: number, enabled: boolean) => void
  levels: Record<number, number>
  onLevel: (id: number, value: number) => void
  onSpeed: (id: number, milliseconds: number) => void
  editing: boolean
  dragged: boolean
  rowIndex: number
  /** The drop caret belongs immediately before this widget. */
  dropBefore: boolean
  onDragStart: (id: number | null) => void
  onDragMove: (x: number, y: number, label: string) => void
  onDragEnd: () => void
  selecting: boolean
  selected: boolean
  onSelect: (id: number) => void
}) {
  /* The colour the designer gave the widget, shown as a stripe down its edge
     rather than poured over the whole card.
   *
     Flooding it was how the old desk did it and it costs twice: the caption
     goes unreadable whenever the pair was picked for a lamp instead of a
     screen, and a wall of saturated slabs leaves nothing to tell the operator
     what is running -- every card already shouts. On the edge the colour still
     identifies the button across a dark room, and the card is free to say
     something with its own surface. Foreground stands in when that is the only
     colour there is, so nothing the designer chose is dropped. */
  const tint = widget.background ?? widget.foreground
  const style = {
    '--grow': grow,
    ...(tint ? { '--tint': tint } : {}),
  } as React.CSSProperties

  /* Where the finger went down, and whether it has gone anywhere since. In a
     ref because a drag that re-rendered on every pixel would drop frames on the
     one screen where dropped frames read as the desk being slow. */
  const origin = useRef<{ x: number; y: number; moved: boolean } | null>(null)

  // While arranging, every widget is a handle and nothing fires its function:
  // moving a button must never also press it.
  if (editing) {
    const label = widget.caption || widget.type

    return (
      <>
        {dropBefore && <span className="caret" aria-hidden="true" />}
        <button
          type="button"
          className={`widget ${widget.type} arranging`}
          style={style}
          data-tint={tint !== undefined}
          data-dragged={dragged}
          data-widget-id={widget.id ?? ''}
          data-row={rowIndex}
          /* Both gestures, decided by whether the finger moved.
           *
             A drag is what a hand reaches for and it shows where the widget is
             going. A tap is what works when there is no pointer to drag with,
             and it is the precise way to place something on a phone: the widget
             waits, every gap becomes a target, and one more tap puts it there.
             Neither has to be chosen or explained. */
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            origin.current = { x: event.clientX, y: event.clientY, moved: false }
            onDragStart(widget.id ?? null)
          }}
          onPointerMove={(event) => {
            const from = origin.current
            if (from === null) return

            /* A threshold, so a tap that trembles is still a tap. Below it
               nothing has begun and the sticky path is still on the table. */
            if (!from.moved) {
              const far =
                Math.abs(event.clientX - from.x) > 8 || Math.abs(event.clientY - from.y) > 8
              if (!far) return
              origin.current = { ...from, moved: true }
            }

            onDragMove(event.clientX, event.clientY, label)
          }}
          onPointerUp={() => {
            const moved = origin.current?.moved === true
            origin.current = null
            if (moved) onDragEnd()
            else if (dragged) onDragStart(null) // tapped again: put it down
          }}
          onPointerCancel={() => {
            origin.current = null
            onDragStart(null)
          }}
        >
          {label}
        </button>
      </>
    )
  }

  /* A label is a section heading, and QLC+ has no other way to write one.
   *
     Operators spell them "— MAESTRO —" because a label is all the format
     offers, so the dashes are a workaround for a missing feature, not part of
     the name. Read as a heading and drawn as one, the console gets the
     structure its author was reaching for. In arrange and edit mode it stays a
     widget: there it is a thing to move and rename, not a title. */
  if (widget.type === 'label' && !editing && !selecting) {
    const heading = (widget.caption ?? '').replace(/^[\s\u2014\u2013-]+|[\s\u2014\u2013-]+$/g, '')
    if (heading === '') return null

    return <h2 className="section">{heading}</h2>
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

  if (widget.type === 'button') {
    const action = widget.action ?? 'Toggle'

    /* Blackout and stop-all carry no function of their own: QLC+ writes the
       invalid-id sentinel there. Before this branch they fell through to the
       toggle path and started a function that does not exist -- the daemon
       said so, and the error was dropped on the floor. */
    if (action === 'Blackout' || action === 'StopAll') {
      const active = action === 'Blackout' && desk.blackout
      return (
        <button
          type="button"
          className="widget button"
          style={style}
          data-tint={tint !== undefined}
          data-running={active}
          aria-pressed={active}
          onClick={() => desk.onAction(action)}
        >
          {widget.caption || (action === 'Blackout' ? 'Blackout' : 'Parar todo')}
        </button>
      )
    }

    if (widget.functionId !== undefined) {
      const id = widget.functionId

      if (action === 'Flash') {
        /* Held, not latched: light while the finger is down. Releasing
           anywhere -- including off the button -- lets go, because a flash
           that sticks because the pointer slipped is a stuck light on stage. */
        return (
          <button
            type="button"
            className="widget button"
            style={style}
            data-tint={tint !== undefined}
            data-running={running.has(id)}
            aria-pressed={running.has(id)}
            onPointerDown={(e) => {
              /* Capture is the enhancement -- releasing off the button still
                 lets go -- and it must never gate the action: a synthetic
                 pointer (tests, some assistive tech) has no capturable id and
                 throws. */
              try {
                e.currentTarget.setPointerCapture(e.pointerId)
              } catch {
                // The pointerup listener still covers the common case.
              }
              desk.onFlash(id, true)
            }}
            onPointerUp={() => desk.onFlash(id, false)}
            onPointerCancel={() => desk.onFlash(id, false)}
          >
            {widget.caption || `#${id}`}
          </button>
        )
      }

      return (
        <button
          type="button"
          className="widget button"
          style={style}
          data-tint={tint !== undefined}
          data-running={running.has(id)}
          aria-pressed={running.has(id)}
          onClick={() => onToggle(id)}
        >
          {widget.caption || `#${id}`}
        </button>
      )
    }
  }

  if (widget.type === 'audiotriggers') {
    const state = audio[widget.id ?? -1]
    return (
      <AudioTriggers
        widget={widget}
        style={style}
        spectrum={spectrum.bands}
        volume={spectrum.volume}
        enabled={state?.enabled === true}
        capturing={state?.capturing === true}
        {...(state?.unavailable ? { unavailable: state.unavailable } : {})}
        onToggle={onAudio}
      />
    )
  }

  if (widget.type === 'matrix') {
    return (
      <MatrixWidget
        widget={widget}
        style={style}
        value={levels[widget.id ?? -1] ?? widget.value ?? 0}
        onLevel={onLevel}
        onPreset={onPreset}
      />
    )
  }

  if (widget.type === 'xypad') {
    return (
      <XYPad
        widget={widget}
        style={style}
        position={pads[widget.id ?? -1] ?? { x: widget.padX ?? 0, y: widget.padY ?? 0 }}
        onMove={onPad}
      />
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
      <NestedFrame
        widget={widget}
        style={style}
        running={running}
        allFunctions={allFunctions}
        onToggle={onToggle}
        desk={desk}
        onCueList={onCueList}
        pads={pads}
        onPad={onPad}
        onPreset={onPreset}
        audio={audio}
        spectrum={spectrum}
        onAudio={onAudio}
        levels={levels}
        onLevel={onLevel}
        onSpeed={onSpeed}
      />
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

/**
 * A frame inside a page, with what is in it.
 *
 * Drawn as a grey box until now, which on a console built out of frames meant
 * most of the show was invisible: the QLC+ sample has 125 widgets and four of
 * them were on screen.
 *
 * Its children reflow by the same rule as the page, so a frame on a phone
 * wraps rather than shrinking. Paging is the frame's own -- QLC+ stores pages
 * per frame, not per console.
 */
function NestedFrame({
  widget,
  style,
  running,
  allFunctions,
  desk,
  onToggle,
  onCueList,
  pads,
  onPad,
  onPreset,
  audio,
  spectrum,
  onAudio,
  levels,
  onLevel,
  onSpeed,
}: {
  widget: VcWidget
  style: React.CSSProperties
  running: Set<number>
  allFunctions: FunctionState[]
  desk: DeskActions
  onToggle: (id: number) => void
  onCueList: (chaser: number, action: CueAction, index?: number) => void
  pads: Record<number, { x: number; y: number }>
  onPad: (id: number, x: number, y: number) => void
  onPreset: (id: number, preset: number) => void
  audio: Record<number, { enabled: boolean; capturing: boolean; unavailable?: string }>
  spectrum: { bands: number[]; volume: number }
  onAudio: (id: number, enabled: boolean) => void
  levels: Record<number, number>
  onLevel: (id: number, value: number) => void
  onSpeed: (id: number, milliseconds: number) => void
}) {
  const [page, setPage] = useState(widget.currentPage ?? 0)

  const children = childrenOnPage(widget, page)
  const rows = groupIntoRows(children)
  const pages = widget.pages ?? 0

  return (
    <section
      className="widget frame"
      style={{ ...style, '--basis': '100%' } as React.CSSProperties}
      data-solo={widget.type === 'soloframe'}
    >
      {/* A header-less frame is a grouping the designer wanted invisible, so
          giving it a title would be adding furniture nobody asked for. */}
      {widget.showHeader !== false && (widget.caption || pages > 1) && (
        <header className="frame-head">
          <span>{widget.caption}</span>
          {pages > 1 && (
            <nav className="frame-pages">
              {Array.from({ length: pages }, (_, index) => (
                <button
                  // The page number is the identity: a fixed list, in order.
                  // biome-ignore lint/suspicious/noArrayIndexKey: the index is the page
                  key={index}
                  type="button"
                  aria-pressed={index === page}
                  onClick={() => setPage(index)}
                >
                  {index + 1}
                </button>
              ))}
            </nav>
          )}
        </header>
      )}

      <div className="frame-body">
        {rows.map((row, rowIndex) => (
          <div className="row" key={`${rowIndex}-${row.widgets[0]?.id}`}>
            {row.widgets.map((child, childIndex) => (
              <Widget
                key={child.id ?? `${rowIndex}-${childIndex}`}
                widget={child}
                grow={growFactor(child, row)}
                running={running}
                allFunctions={allFunctions}
                onToggle={onToggle}
                desk={desk}
                onCueList={onCueList}
                pads={pads}
                onPad={onPad}
                onPreset={onPreset}
                audio={audio}
                spectrum={spectrum}
                onAudio={onAudio}
                levels={levels}
                onLevel={onLevel}
                onSpeed={onSpeed}
                editing={false}
                dragged={false}
                rowIndex={rowIndex}
                dropBefore={false}
                onDragStart={() => undefined}
                onDragMove={() => undefined}
                onDragEnd={() => undefined}
                selecting={false}
                selected={false}
                onSelect={() => undefined}
              />
            ))}
          </div>
        ))}
        {rows.length === 0 && <p className="hint">Vacío.</p>}
      </div>
    </section>
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
      <span className="fader-value num">
        {value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(2)} s`}
        {count > 0 && <> · {count} fn</>}
      </span>
      <Slider
        min={min}
        max={max}
        step={10}
        value={value}
        disabled={!usable}
        aria-label={widget.caption}
        onChange={(e) => widget.id !== undefined && onChange(widget.id, Number(e.target.value))}
      />
    </label>
  )
}

/** A section heading, and the aside the operator bracketed after it. */
function Heading({ text }: { text: string }) {
  const { title, note } = splitHeading(text)
  return (
    <h2 className="section">
      {title}
      {note !== null && <span className="section-note">{note}</span>}
    </h2>
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

  /* Movable when the daemon says there is something behind it: channels for a
     level fader, a function for a playback, something worth scaling for a
     submaster. And never without an id -- the engine keys its sliders by widget
     id, so a fader without one has nothing to address.
   *
   * Disabled is honest. Showing it live would be a lie the operator only
   * discovers when the light does not move. */
  const usable = widget.controllable === true && widget.id !== undefined

  return (
    <label className="widget fader" style={style} data-usable={usable}>
      <span className="fader-caption">{widget.caption || `#${widget.id ?? '?'}`}</span>
      <span className="fader-value num">{usable ? `${percent}%` : widget.sliderMode}</span>
      <Slider
        min={low}
        max={high}
        value={value}
        disabled={!usable}
        aria-label={widget.caption}
        onChange={(e) => widget.id !== undefined && onChange(widget.id, Number(e.target.value))}
      />
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

/**
 * Leaving operator mode: press and hold.
 *
 * A tap is what a sleeve does. A second of deliberate pressure is not, and it
 * needs no dialog to interrupt a show. This is a guard against accidents and
 * says so; it is not a lock, and calling it one would be a claim this codebase
 * has no business making.
 */
function Unlock({ onUnlock }: { onUnlock: () => void }) {
  const [held, setHeld] = useState(0)
  const timer = useRef<number | null>(null)

  const start = () => {
    if (timer.current !== null) return
    const began = performance.now()
    timer.current = window.setInterval(() => {
      const held = Math.min(1, (performance.now() - began) / 1000)
      setHeld(held)
      if (held >= 1) {
        stop()
        onUnlock()
      }
    }, 50)
  }

  const stop = () => {
    if (timer.current !== null) window.clearInterval(timer.current)
    timer.current = null
    setHeld(0)
  }

  /* Clearing the interval directly rather than through stop(): the cleanup
     must not depend on a function that is rebuilt on every render, and there is
     no state to reset on the way out of a component that is going away. */
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearInterval(timer.current)
    },
    [],
  )

  return (
    <button
      type="button"
      className="unlock"
      style={{ '--held': held } as React.CSSProperties}
      title="Mantén pulsado para salir del modo operador"
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
    >
      {held > 0 ? 'Suelta para cancelar…' : 'Operador 🔒'}
    </button>
  )
}
