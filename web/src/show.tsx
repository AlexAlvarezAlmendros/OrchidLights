/**
 * The show manager: a multi-track timeline, in the browser.
 *
 * A show is the one function whose body is a screen rather than a list. Each
 * track holds a scene and carries functions placed along it in time; what plays
 * is decided by where the bars sit, so the bars have to be draggable and the
 * positions have to be true.
 *
 * Two decisions worth stating:
 *
 *  - Dragging is optimistic on screen and authoritative on the daemon. The bar
 *    follows the pointer, and the move is sent on release; if the daemon
 *    refuses it -- because it would overlap something -- the timeline is
 *    reloaded and the bar goes back where it was, with the reason shown. A bar
 *    that stayed where it was dropped while the show played something else
 *    would be the worst kind of lie this interface can tell.
 *
 *  - The playhead is the show's own clock, sent by the daemon while it runs.
 *    Not a local timer started when play was pressed: that drifts, and it keeps
 *    moving when the show has stopped.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type FunctionBody, type FunctionState, type ShowItem, type ShowTrack, api } from './api'
import { type Span, collision } from './drag'
import { Slider } from './slider'

/** Milliseconds a drag snaps to. Fine enough to place a cue, coarse enough
 *  that a hand cannot leave a bar at 4993 ms by accident. */
const SNAP = 100

/** What can go on a timeline. The daemon refuses the rest with a reason, but
 *  offering them and then refusing is a worse way to say it. */
const PLACEABLE = ['Scene', 'Chaser', 'Sequence', 'Audio', 'Video', 'RGBMatrix', 'EFX']

export function ShowTimeline({
  fn,
  body,
  functions,
  elapsed,
  running,
  onRun,
  onReload,
}: {
  fn: FunctionState
  body: FunctionBody
  functions: FunctionState[]
  /** Milliseconds into the show, or undefined when it is not playing. */
  elapsed: number | undefined
  running: boolean
  onRun: (action: () => Promise<unknown>) => Promise<void>
  onReload: () => void
}) {
  const [zoom, setZoom] = useState(60) // pixels per second
  const [adding, setAddingTo] = useState<number | null>(null)

  const tracks = body.tracks ?? []
  const duration = body.duration ?? 0

  /* Room for what is there plus a little, so an empty show is still a surface
     to drop things onto rather than a hairline. */
  const span = Math.max(duration + 10_000, 30_000)
  const width = (span / 1000) * zoom

  const placeable = useMemo(
    () => functions.filter((f) => f.id !== fn.id && PLACEABLE.includes(f.type)),
    [functions, fn.id],
  )

  const apply = useCallback(
    (action: () => Promise<unknown>) => onRun(action).then(onReload, () => onReload()),
    [onRun, onReload],
  )

  return (
    <div className="timeline">
      <header className="timeline-head">
        <span className="fader-caption">{fn.name}</span>
        <span className="hint">{formatTime(duration)}</span>
        <span className="spacer" />
        <label className="field">
          <span>Zoom</span>
          <Slider
            min={10}
            max={200}
            value={zoom}
            aria-label="Zoom de la línea de tiempo"
            onChange={(e) => setZoom(Number(e.target.value))}
          />
        </label>
        <button type="button" onClick={() => apply(() => api.addTrack(fn.id, {}))}>
          + Pista
        </button>
      </header>

      {tracks.length === 0 && (
        <p className="hint">
          Este show no tiene pistas. Una pista sostiene una escena y lleva encima las funciones
          colocadas en el tiempo.
        </p>
      )}

      <div className="timeline-body">
        <div className="timeline-tracks">
          {tracks.map((track) => (
            <TrackHead
              key={track.id}
              showId={fn.id}
              track={track}
              functions={functions}
              onApply={apply}
              onAdd={() => setAddingTo(adding === track.id ? null : track.id)}
              adding={adding === track.id}
            />
          ))}
        </div>

        <div className="timeline-lanes">
          <Ruler span={span} zoom={zoom} />

          <div className="timeline-scroll">
            <div style={{ width, position: 'relative' }}>
              {tracks.map((track) => (
                <Lane key={track.id} showId={fn.id} track={track} zoom={zoom} onApply={apply} />
              ))}

              {/* The show's own clock, not a local one. Absent when it is not
                  playing, rather than parked at zero: a playhead sitting at the
                  start of a stopped show reads as "about to play". */}
              {running && elapsed !== undefined && (
                <div
                  className="playhead"
                  style={{ left: `${(elapsed / 1000) * zoom}px` }}
                  aria-hidden="true"
                />
              )}
            </div>
          </div>
        </div>
      </div>

      {adding !== null && (
        <AddItem
          showId={fn.id}
          trackId={adding}
          placeable={placeable}
          at={tracks.find((t) => t.id === adding)?.functions.reduce(endOf, 0) ?? 0}
          onApply={apply}
          onClose={() => setAddingTo(null)}
        />
      )}
    </div>
  )
}

const endOf = (latest: number, item: ShowItem) => Math.max(latest, item.start + item.duration)

function TrackHead({
  showId,
  track,
  functions,
  onApply,
  onAdd,
  adding,
}: {
  showId: number
  track: ShowTrack
  functions: FunctionState[]
  onApply: (action: () => Promise<unknown>) => Promise<void>
  onAdd: () => void
  adding: boolean
}) {
  const [name, setName] = useState(track.name)

  useEffect(() => setName(track.name), [track.name])

  const scenes = functions.filter((f) => f.type === 'Scene')

  return (
    <div className="track-head">
      <input
        className="grow"
        value={name}
        aria-label={`Nombre de la pista ${track.id}`}
        onChange={(e) => setName(e.target.value)}
        onBlur={() =>
          name !== track.name && onApply(() => api.patchTrack(showId, track.id, { name }))
        }
      />

      <div className="track-controls">
        {/* The scene a track is bound to is not decoration: the sequences on
            this track are that scene's values over time, so a track pointing
            at nothing carries sequences that address nothing. */}
        <select
          value={track.scene ?? ''}
          aria-label={`Escena de la pista ${track.id}`}
          onChange={(e) =>
            onApply(() =>
              api.patchTrack(showId, track.id, {
                scene: e.target.value === '' ? -1 : Number(e.target.value),
              }),
            )
          }
        >
          <option value="">Sin escena</option>
          {scenes.map((scene) => (
            <option key={scene.id} value={scene.id}>
              {scene.name}
            </option>
          ))}
        </select>

        <button
          type="button"
          aria-pressed={track.mute}
          data-muted={track.mute}
          title="Silenciar la pista"
          onClick={() => onApply(() => api.patchTrack(showId, track.id, { mute: !track.mute }))}
        >
          {track.mute ? '🔇' : '🔊'}
        </button>

        <button type="button" aria-pressed={adding} title="Añadir función" onClick={onAdd}>
          +
        </button>

        <button
          type="button"
          className="danger"
          aria-label={`Eliminar la pista ${track.name}`}
          onClick={() => onApply(() => api.removeTrack(showId, track.id))}
        >
          ✕
        </button>
      </div>
    </div>
  )
}

function Lane({
  showId,
  track,
  zoom,
  onApply,
}: {
  showId: number
  track: ShowTrack
  zoom: number
  onApply: (action: () => Promise<unknown>) => Promise<void>
}) {
  /* Which bar a drag would land on top of, so the whole lane can show it: the
     one being moved turns red and the one it would hit is marked. The daemon is
     still the authority and still refuses -- this only moves the refusal to
     before the finger comes up, which is the difference between "that will not
     fit" and "that did not fit". */
  const [blocked, setBlocked] = useState<number | null>(null)

  return (
    <div className="lane">
      {track.functions.map((item) => (
        <Bar
          key={item.id}
          showId={showId}
          item={item}
          spans={track.functions}
          zoom={zoom}
          hit={blocked === item.id}
          onBlocked={setBlocked}
          onApply={onApply}
        />
      ))}
    </div>
  )
}

/**
 * One function on the timeline.
 *
 * Dragged by the middle to move it, by the right edge to change how long it
 * plays. Both are optimistic while the pointer is down and committed on
 * release; a refusal reloads the timeline, which puts the bar back.
 */
function Bar({
  showId,
  item,
  spans,
  zoom,
  hit,
  onBlocked,
  onApply,
}: {
  showId: number
  item: ShowItem
  /** Everything on this track, to work out what a move would land on. */
  spans: ShowItem[]
  zoom: number
  /** Another bar is being dragged onto this one. */
  hit: boolean
  onBlocked: (id: number | null) => void
  onApply: (action: () => Promise<unknown>) => Promise<void>
}) {
  const [drag, setDrag] = useState<{ start: number; duration: number } | null>(null)
  const origin = useRef({ x: 0, start: 0, duration: 0, mode: 'move' as 'move' | 'resize' })

  /* The live drag lives in a ref as well as in state, and the handlers read the
     ref.
   *
     State alone is a frame behind: pointermove fires again before React has
     committed the pointerdown, so the handler still sees null and drops it. One
     frame of lag is barely visible, but a short quick drag can begin and end
     inside it -- and then the bar snaps back having done nothing, which reads
     as a control that ignores you. */
  const live = useRef<{ start: number; duration: number } | null>(null)

  const start = drag?.start ?? item.start
  const duration = drag?.duration ?? item.duration

  const set = (next: { start: number; duration: number } | null) => {
    live.current = next
    setDrag(next)
  }

  const begin = (event: React.PointerEvent, mode: 'move' | 'resize') => {
    if (item.locked) return
    event.preventDefault()
    event.stopPropagation()
    ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
    origin.current = { x: event.clientX, start: item.start, duration: item.duration, mode }
    set({ start: item.start, duration: item.duration })
  }

  /* What this move would land on, kept in a ref for the same reason the drag
     itself is: the drop reads it at the moment the finger lifts. */
  const hitting = useRef<(Span & { name?: string }) | null>(null)

  const move = (event: React.PointerEvent) => {
    if (live.current === null) return
    const delta = ((event.clientX - origin.current.x) / zoom) * 1000
    const snapped = Math.round(delta / SNAP) * SNAP

    const next =
      origin.current.mode === 'move'
        ? {
            start: Math.max(0, origin.current.start + snapped),
            duration: origin.current.duration,
          }
        : {
            /* A bar of no length is a cue that never plays. One snap is the
               floor. */
            start: origin.current.start,
            duration: Math.max(SNAP, origin.current.duration + snapped),
          }

    set(next)

    const onto = collision(spans, item.id, next.start, next.duration)
    hitting.current = onto
    onBlocked(onto?.id ?? null)
  }

  const end = () => {
    const dropped = live.current
    const onto = hitting.current
    if (dropped === null) return

    set(null)
    hitting.current = null
    onBlocked(null)

    /* Let go over something else: nothing moves, and the bar goes back where it
       was. The daemon would have refused it anyway; the difference is that this
       was visible the whole way, so letting go there was already a decision not
       to move it rather than a mistake to be told about. */
    if (onto !== null) return

    if (dropped.start !== item.start || dropped.duration !== item.duration) {
      onApply(() =>
        api.patchShowItem(showId, item.id, {
          start: dropped.start,
          duration: dropped.duration,
        }),
      )
    }
  }

  return (
    <div
      className="bar"
      data-missing={item.missing}
      data-locked={item.locked}
      data-dragging={drag !== null}
      data-blocked={drag !== null && hitting.current !== null}
      data-hit={hit}
      style={{
        left: `${(start / 1000) * zoom}px`,
        width: `${Math.max(2, (duration / 1000) * zoom)}px`,
        ...(item.color ? { background: item.color } : {}),
      }}
      onPointerDown={(e) => begin(e, 'move')}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <span className="bar-label">
        {item.name}
        {item.missing ? ' ⚠' : ''}
      </span>

      <span className="bar-time">
        {drag !== null && hitting.current !== null
          ? `choca con ${hitting.current.name}`
          : `${formatTime(start)} · ${formatTime(duration)}`}
      </span>

      <button
        type="button"
        className="bar-lock"
        aria-label={item.locked ? `Desbloquear ${item.name}` : `Bloquear ${item.name}`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => onApply(() => api.patchShowItem(showId, item.id, { locked: !item.locked }))}
      >
        {item.locked ? '🔒' : '🔓'}
      </button>

      <button
        type="button"
        className="bar-remove"
        aria-label={`Quitar ${item.name} de la pista`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => onApply(() => api.removeShowItem(showId, item.id))}
      >
        ✕
      </button>

      {/* The grip that changes how long it plays. Not offered on a locked
          item, because it would refuse and say so afterwards. */}
      {!item.locked && (
        <span
          className="bar-grip"
          onPointerDown={(e) => begin(e, 'resize')}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
        />
      )}
    </div>
  )
}

/** Place a function on a track. Defaults to just after whatever is already
 *  there, which is where a cue usually goes and never overlaps. */
function AddItem({
  showId,
  trackId,
  placeable,
  at,
  onApply,
  onClose,
}: {
  showId: number
  trackId: number
  placeable: FunctionState[]
  at: number
  onApply: (action: () => Promise<unknown>) => Promise<void>
  onClose: () => void
}) {
  const [start, setStart] = useState(String(at))

  useEffect(() => setStart(String(at)), [at])

  if (placeable.length === 0) {
    return (
      <p className="hint">
        No hay funciones que puedan ir en una línea de tiempo. Un script o una colección no tienen
        duración, así que no hay barra que dibujar ni final en el que pararlos.
      </p>
    )
  }

  return (
    <div className="card">
      <div className="fields">
        <label className="field">
          <span>Empieza en (ms)</span>
          <input
            type="number"
            min={0}
            step={100}
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>

        <label className="field grow-field">
          <span>Función</span>
          <select
            value=""
            onChange={(e) => {
              if (e.target.value === '') return
              onApply(() =>
                api.addShowItem(showId, trackId, {
                  function: Number(e.target.value),
                  start: Math.max(0, Number(start) || 0),
                }),
              ).then(onClose)
            }}
          >
            <option value="">Elegir…</option>
            {placeable.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name} ({f.type})
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  )
}

/** The ruler. Seconds while they fit, then every five or ten. */
function Ruler({ span, zoom }: { span: number; zoom: number }) {
  const step = zoom >= 80 ? 1000 : zoom >= 30 ? 5000 : 10_000
  const marks: number[] = []
  for (let t = 0; t <= span; t += step) marks.push(t)

  return (
    <div className="ruler" style={{ width: `${(span / 1000) * zoom}px` }}>
      {marks.map((t) => (
        <span key={t} className="tick" style={{ left: `${(t / 1000) * zoom}px` }}>
          {formatTime(t)}
        </span>
      ))}
    </div>
  )
}

/** m:ss for anything over a minute, seconds with one decimal below it. A cue
 *  at "4.2 s" is placeable; a cue at "4200" is arithmetic. */
export function formatTime(ms: number): string {
  if (ms >= 60_000) {
    const minutes = Math.floor(ms / 60_000)
    const seconds = Math.floor((ms % 60_000) / 1000)
    return `${minutes}:${String(seconds).padStart(2, '0')}`
  }
  return `${(ms / 1000).toFixed(1)} s`
}
