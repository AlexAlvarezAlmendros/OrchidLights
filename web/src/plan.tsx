/**
 * The rig, as a plan, with each lamp showing what it is doing right now.
 *
 * The colour is worked out here rather than sent from the daemon. The interface
 * already receives every DMX frame; once it knows that fixture 4's red is
 * channel 0 and its dimmer is channel 6, it can colour the whole plan on every
 * frame without asking anything. Asking per frame would make this a slideshow,
 * and a plan that lags is worse than no plan, because it is believed.
 *
 * A fixture nobody has placed is not drawn on the stage at the origin. It sits
 * in a tray below, waiting to be put somewhere: a plan that quietly stacks every
 * unplaced lamp in one corner looks like a plan, and is not.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { type FunctionState, type PlanFixture, type PlanState, api } from './api'
import { Slider } from './slider'
import { authHeaders } from './token'

/** A handful of colours worth reaching for without a picker: the ones a rig
 *  gets asked for by name. A full picker belongs in the scene editor, where a
 *  colour is being decided rather than tried. */
const SWATCHES = [
  '#ffffff',
  '#ff2d2d',
  '#ff9a2d',
  '#ffe22d',
  '#2dff77',
  '#2dc9ff',
  '#5c3dff',
  '#ff2db4',
]

export function Plan({
  revision,
  universes,
  functions,
  running,
  blackout,
  onBlackout,
  onToggle,
  onError,
}: {
  revision: number
  /** The latest frame of each universe, 1-based, as the feed delivers it. */
  universes: Record<number, Uint8Array>
  /** Whether the rig is blacked out. The frames this view colours lamps from
   *  are the engine's post-GM values, which keep the old look during a
   *  blackout while the plugins send zeros -- so without this flag the plan
   *  paints a lit rig over a dark venue and somebody goes looking for a fault
   *  that is not there. */
  blackout: boolean
  onBlackout: () => void
  /** The show's own cues, for the dock along the bottom. Driving a rig is not
   *  only pointing at lamps: most of a pase is firing what somebody built. */
  functions: FunctionState[]
  running: Set<number>
  onToggle: (id: number) => void
  onError: (message: string | null) => void
}) {
  const [plan, setPlan] = useState<PlanState | null>(null)
  /* The lamp being moved and where it is right now, in millimetres.
   *
     It used to be only the id: the lamp stayed where it was until the finger
     came up and then jumped. Placing a rig that way is guesswork -- you find
     out where you put something after you have put it. */
  const [drag, setDrag] = useState<{
    id: number
    linked?: number | undefined
    head?: number | undefined
    x: number
    y: number
  } | null>(null)
  /* The background image, fetched rather than pointed at: an <img src> cannot
     carry the Authorization header, so on a token-guarded daemon it would 401
     into a silently missing backdrop. A blob URL keeps the pixels and the
     auth path together. */
  const [backgroundUrl, setBackgroundUrl] = useState<string | null>(null)
  /* Which lamps you are working on. The plan stops being a picture of the rig
     the moment you can point at part of it and say "these". */
  const [chosen, setChosen] = useState<number[]>([])
  const [level, setLevel] = useState(255)
  const surface = useRef<HTMLDivElement>(null)
  /* A finger down on a lamp is not yet a drag. Below the threshold it is a tap,
     which chooses the lamp instead of moving it -- the same rule as the
     console, for the same reason: one gesture that does two things needs to
     know which one before it commits to either. */
  const pending = useRef<{
    id: number
    linked?: number | undefined
    head?: number | undefined
    x: number
    y: number
  } | null>(null)
  /* A rectangle dragged over empty stage selects everything inside it. */
  const [marquee, setMarquee] = useState<{
    x0: number
    y0: number
    x1: number
    y1: number
  } | null>(null)

  const reload = useCallback(() => {
    api
      .plan()
      .then(setPlan)
      .catch((e) => onError(e instanceof Error ? e.message : String(e)))
  }, [onError])

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the trigger
  useEffect(() => {
    reload()
  }, [reload, revision])

  /* Above the early return on purpose: hooks must run on every render, and
     a hook that appears only once the plan has loaded is React error #310 --
     which took the whole app down the first time the plan opened. */
  useEffect(() => {
    if (plan === null || plan.background === false) {
      setBackgroundUrl(null)
      return
    }
    let revoked: string | null = null
    fetch('/api/v1/plan/background', { headers: authHeaders() })
      .then((response) => (response.ok ? response.blob() : null))
      .then((blob) => {
        if (blob === null) return
        revoked = URL.createObjectURL(blob)
        setBackgroundUrl(revoked)
      })
      .catch(() => setBackgroundUrl(null))
    return () => {
      if (revoked !== null) URL.revokeObjectURL(revoked)
    }
  }, [plan])

  if (plan === null) return <p className="hint">Leyendo la planta…</p>

  const grid = plan.grid
  /* Millimetres across the stage. The grid is in metres or feet; either way the
     positions are millimetres, which is what QLC+ stores. */
  const across = grid.units === 'feet' ? grid.width * 304.8 : grid.width * 1000
  const deep = grid.units === 'feet' ? grid.depth * 304.8 : grid.depth * 1000

  const placed = plan.fixtures.filter(
    (f) => f.x !== undefined && f.y !== undefined && f.hidden !== true,
  )
  const unplaced = plan.fixtures.filter((f) => f.x === undefined || f.y === undefined)
  const hidden = plan.fixtures.filter(
    (f) => f.x !== undefined && f.y !== undefined && f.hidden === true,
  )

  /** Pointer coordinates as millimetres on the stage, clamped to it. */
  const toStage = (event: React.PointerEvent) => {
    const box = surface.current?.getBoundingClientRect()
    if (box === undefined) return null

    /* From the box the stage actually has on screen, not from a scale worked
       out up front: it is sized by its aspect ratio against whatever room the
       window gives it, so the only honest scale is the one it ended up with. */
    return {
      x: Math.round(
        Math.max(0, Math.min(across, ((event.clientX - box.left) / box.width) * across)),
      ),
      y: Math.round(Math.max(0, Math.min(deep, ((event.clientY - box.top) / box.height) * deep))),
    }
  }

  const selected = plan?.fixtures.filter((f) => chosen.includes(f.id)) ?? []

  const fail = (e: unknown) => onError(e instanceof Error ? e.message : String(e))

  /* How many of the chosen can actually take each thing. A control that is
     offered and does nothing is the failure this whole codebase is arranged
     against, so both are counted and both are said. */
  /* Chasers and EFX: what a pase is made of. Scenes are left out -- a console
     full of colour buttons already fires those, and every scene in the dock
     would bury the handful that are cues. */
  const cues = functions.filter((f) => f.type === 'Chaser' || f.type === 'EFX')

  const dimmable = selected.filter((f) => f.roles.intensity !== undefined).length
  const mixable = selected.filter((f) => colourValues(f, { r: 0, g: 0, b: 0 }).length > 0).length

  /** Give the selection a colour, resolved per fixture: an RGB bar and a CMY
   *  head want different numbers for the same red. */
  const paint = (hex: string) => {
    const rgb = parseHex(hex)
    const values = selected.flatMap((f) =>
      colourValues(f, rgb).map((v) => ({ fixture: f.id, channel: v.channel, value: v.value })),
    )
    if (values.length === 0) return
    onError(null)
    api.setLive(values).catch(fail)
  }

  /** And an intensity, on whatever each of them calls its dimmer. */
  const dim = (value: number) => {
    setLevel(value)
    const values = selected
      .filter((f) => f.roles.intensity !== undefined)
      .map((f) => ({ fixture: f.id, channel: f.roles.intensity as number, value }))
    if (values.length === 0) return
    onError(null)
    api.setLive(values).catch(fail)
  }

  const place = (id: number, x: number, y: number, linked?: number, head?: number) => {
    onError(null)
    api
      .setPlanPosition(id, { x, y, linked, head })
      .then(reload)
      .catch((e) => {
        onError(e instanceof Error ? e.message : String(e))
        reload()
      })
  }

  return (
    <div className="plan">
      <p className="hint plan-hint">
        Cada lámpara con el color que está dando ahora mismo. Toca para elegirlas, arrastra para
        colocarlas · {grid.width} × {grid.depth} {grid.units === 'feet' ? 'pies' : 'm'}
      </p>

      {/* The stage and the panel that acts on it, in one box.
       *
          Together, because on a wide screen the panel sits in the stage's
          corner -- below the fold is where a panel goes to be missed -- and on
          a phone it drops below the stage instead of over it. Fixed to the
          bottom of the window was the first try and it covered the navigation:
          choosing a lamp left no way off the screen. */}
      <div className="plan-frame">
        {/* Fills the room the window has, rather than being letterboxed to the
          proportions of the grid.
       *
          Those proportions are usually a default nobody chose -- QLC+ opens at
          5 x 5 m -- and holding to them left two thirds of a wide screen black
          while the rig was squeezed into a square in the middle. Lamps are
          placed in per cent, so along each axis the drawing stays exact and the
          only thing lost is the aspect.

          Which is why the metre grid below is drawn all the time now and not
          just while something is being placed: it is what keeps the scale
          readable once the two axes no longer share one. */}
        <div
          className="plan-stage"
          ref={surface}
          data-dragging={drag !== null}
          style={
            {
              // One grid line per metre (or per foot), taken from the project.
              '--cols': grid.width,
              '--rows': grid.depth,
            } as React.CSSProperties
          }
          onPointerDown={(e) => {
            /* Only the bare stage starts a rectangle: lamps grab their own
               pointer first. */
            const target = e.target as HTMLElement
            if (target !== surface.current && !target.classList.contains('plan-background')) return
            const at = toStage(e)
            if (at !== null) setMarquee({ x0: at.x, y0: at.y, x1: at.x, y1: at.y })
          }}
          onPointerMove={(e) => {
            if (marquee !== null) {
              const at = toStage(e)
              /* Functional on purpose: a fast sweep can outrun the render
                 that refreshed this closure. */
              if (at !== null)
                setMarquee((current) =>
                  current !== null ? { ...current, x1: at.x, y1: at.y } : current,
                )
              return
            }
            const held = pending.current
            if (held !== null && drag === null) {
              const far = Math.abs(e.clientX - held.x) > 8 || Math.abs(e.clientY - held.y) > 8
              if (!far) return
              const at = toStage(e)
              setDrag({
                id: held.id,
                linked: held.linked,
                head: held.head,
                x: at?.x ?? 0,
                y: at?.y ?? 0,
              })
              return
            }

            if (drag === null) return
            e.preventDefault()
            const at = toStage(e)
            if (at !== null) setDrag({ id: drag.id, linked: drag.linked, head: drag.head, ...at })
          }}
          onPointerUp={() => {
            if (marquee !== null) {
              const left = Math.min(marquee.x0, marquee.x1)
              const right = Math.max(marquee.x0, marquee.x1)
              const top = Math.min(marquee.y0, marquee.y1)
              const bottom = Math.max(marquee.y0, marquee.y1)
              setMarquee(null)
              /* A real sweep selects; a stray tap on the stage keeps the
                 selection as it was. */
              if (right - left > 200 || bottom - top > 200) {
                setChosen(
                  placed
                    .filter(
                      (f) =>
                        (f.x ?? 0) >= left &&
                        (f.x ?? 0) <= right &&
                        (f.y ?? 0) >= top &&
                        (f.y ?? 0) <= bottom,
                    )
                    .map((f) => f.id),
                )
              }
              return
            }

            const held = pending.current
            pending.current = null

            if (drag !== null) {
              place(drag.id, drag.x, drag.y, drag.linked, drag.head)
              setDrag(null)
              return
            }

            /* A tap chooses. Tapping a chosen one lets it go, so a selection is
             built and unbuilt with the same gesture and needs no modifier -- on
             a phone there is no modifier to hold. */
            if (held !== null) {
              setChosen((current) =>
                current.includes(held.id)
                  ? current.filter((id) => id !== held.id)
                  : [...current, held.id],
              )
            }
          }}
          onPointerLeave={() => {
            /* The finger left the stage. Committing where it last was beats
             dropping the move: a lamp dragged to the very edge is a lamp
             somebody meant to put at the edge. */
            pending.current = null
            if (drag === null) return
            place(drag.id, drag.x, drag.y, drag.linked, drag.head)
            setDrag(null)
          }}
        >
          {backgroundUrl !== null && <img className="plan-background" src={backgroundUrl} alt="" />}

          {marquee !== null && (
            <div
              className="plan-marquee"
              aria-hidden="true"
              style={{
                left: `${(Math.min(marquee.x0, marquee.x1) / across) * 100}%`,
                top: `${(Math.min(marquee.y0, marquee.y1) / deep) * 100}%`,
                width: `${(Math.abs(marquee.x1 - marquee.x0) / across) * 100}%`,
                height: `${(Math.abs(marquee.y1 - marquee.y0) / deep) * 100}%`,
              }}
            />
          )}

          {/* Linked lamps: the same patch drawn again, dashed to say so.
              Dragged and removed like the original; the daemon knows which
              copy by its linked index. */}
          {placed.flatMap((fixture) =>
            (fixture.linkedItems ?? []).map((item) => {
              const dragging =
                drag !== null &&
                drag.id === fixture.id &&
                drag.linked === item.linked &&
                drag.head === item.head
              const x = dragging ? drag.x : item.x
              const y = dragging ? drag.y : item.y
              const colour = blackout ? null : colourOf(fixture, universes)
              return (
                <div
                  key={`${fixture.id}:${item.head}:${item.linked}`}
                  className="lamp linked-lamp"
                  data-dragging={dragging}
                  data-dark={colour === null}
                  style={{
                    left: `${(x / across) * 100}%`,
                    top: `${(y / deep) * 100}%`,
                    transform: `translate(-50%, -50%) rotate(${item.rotation ?? 0}deg)`,
                    ...(colour !== null
                      ? { background: colour, borderColor: colour, boxShadow: `0 0 22px ${colour}` }
                      : {}),
                  }}
                  title={`${item.name} (enlazada con ${fixture.name})`}
                  onPointerDown={(e) => {
                    e.preventDefault()
                    if (fixture.locked === true) return
                    pending.current = {
                      id: fixture.id,
                      linked: item.linked,
                      head: item.head,
                      x: e.clientX,
                      y: e.clientY,
                    }
                  }}
                  onDoubleClick={() =>
                    api
                      .removeLinkedFixture(fixture.id, item.linked, item.head)
                      .then(reload)
                      .catch(fail)
                  }
                >
                  <span className="lamp-label">{item.name}</span>
                </div>
              )
            }),
          )}

          {placed.map((fixture) => (
            <Lamp
              key={fixture.id}
              fixture={fixture}
              aim={blackout ? null : aimOf(fixture, universes)}
              /* While it is being dragged the lamp is drawn where the finger is,
               not where the daemon still has it. */
              at={
                drag !== null && drag.id === fixture.id && drag.linked === undefined ? drag : null
              }
              across={across}
              deep={deep}
              chosen={chosen.includes(fixture.id)}
              colour={blackout ? null : colourOf(fixture, universes)}
              onGrab={(event) => {
                /* A locked lamp still selects; it just cannot be dragged.
                   That is what the padlock means on every plan ever drawn. */
                if (fixture.locked === true) return
                pending.current = { id: fixture.id, x: event.clientX, y: event.clientY }
              }}
              onRemove={() => {
                api
                  .clearPlanPosition(fixture.id)
                  .then(reload)
                  .catch((e) => onError(e instanceof Error ? e.message : String(e)))
              }}
            />
          ))}
        </div>

        {/* What you can do to what you chose, in the corner of the stage.
       *
         On the stage rather than under it: below the fold is where a panel
         goes to be missed, and choosing a lamp and seeing nothing happen is
         how an interface teaches somebody that it is broken. A corner covers
         less than a lamp does. */}
        {selected.length > 0 && (
          <div className="selection">
            <div className="selection-head">
              <strong>
                {selected.length === 1 ? selected[0]?.name : `${selected.length} lámparas`}
              </strong>
              <span className="spacer" />
              <button
                type="button"
                className="icon"
                aria-label="Deseleccionar"
                title="Deseleccionar"
                onClick={() => setChosen([])}
              >
                ✕
              </button>
            </div>

            <label className="field">
              <span className="field-head">
                Intensidad
                {dimmable === 0 ? ' · ninguna de estas tiene dímer' : ''}
                <span className="num">{Math.round((level / 255) * 100)}%</span>
              </span>
              {/* Green rather than the console's violet: this bar drives the
                rig directly, and green is what says "live" everywhere else. */}
              <Slider
                min={0}
                max={255}
                value={level}
                fill="var(--live)"
                disabled={dimmable === 0}
                onChange={(e) => dim(Number(e.target.value))}
              />
            </label>

            <div className="swatches">
              {SWATCHES.map((hex) => (
                <button
                  key={hex}
                  type="button"
                  className="swatch"
                  style={{ background: hex }}
                  disabled={mixable === 0}
                  aria-label={`Poner ${hex}`}
                  onClick={() => paint(hex)}
                />
              ))}
            </div>

            {/* Said plainly rather than by a control that quietly does nothing:
            a dimmer cannot be made amber, and a moving head with a colour
            wheel does not mix either. */}
            {mixable < selected.length && (
              <p className="hint">
                {mixable === 0
                  ? 'Ninguna de estas mezcla color.'
                  : `${selected.length - mixable} de ${selected.length} no mezclan color.`}
              </p>
            )}

            {selected.length >= 2 && <Arrange selected={selected} onDone={reload} onFail={fail} />}

            {selected.length === 1 && selected[0] !== undefined && (
              <LampProps key={selected[0].id} fixture={selected[0]} onDone={reload} onFail={fail} />
            )}

            <button type="button" onClick={() => api.releaseLive().then(() => undefined, fail)}>
              Soltar
            </button>

            <p className="hint">
              Es una mesa, no una edición: no toca el proyecto ni sobrevive a una recarga.
            </p>
          </div>
        )}
      </div>

      {/* The cues, along the bottom.
       *
         A pase is mostly firing what somebody already built, so the chases
         belong on the screen you drive from rather than one tab away. */}
      {cues.length > 0 && (
        <div className="cuedock">
          {cues.map((cue) => (
            <button
              key={cue.id}
              type="button"
              className="cue"
              data-running={running.has(cue.id)}
              onClick={() => onToggle(cue.id)}
            >
              <span className="cue-name">{cue.name}</span>
              <span className="cue-state">
                {running.has(cue.id)
                  ? cue.steps
                    ? `paso ${(cue.step ?? 0) + 1}/${cue.steps}`
                    : 'en marcha'
                  : cue.type === 'EFX'
                    ? 'EFX'
                    : `${cue.steps ?? 0} pasos`}
              </span>
            </button>
          ))}

          {/* At the end of the dock as well as up in the bar.
           *
              Not a duplicate so much as the same action within reach: during a
              pase the thumb lives down here among the cues, and the one control
              you may need without looking is the one that stops everything. */}
          <button
            type="button"
            className="cue blackout"
            data-active={blackout}
            aria-pressed={blackout}
            onClick={onBlackout}
          >
            <span className="cue-name">{blackout ? 'SALIR' : 'BLACKOUT'}</span>
          </button>
        </div>
      )}

      {/* Folded away by default. A rig with seventeen lamps nobody has placed
          would otherwise take more of the screen than the stage does, and the
          stage is the thing. */}
      {unplaced.length > 0 && (
        <details className="plan-tray">
          <summary>Sin colocar ({unplaced.length})</summary>
          <p className="hint">Púlsalas para ponerlas en el centro y arrastra desde ahí.</p>
          <div className="tray-items">
            {unplaced.map((fixture) => (
              <button
                key={fixture.id}
                type="button"
                className="tray-item"
                style={{
                  borderColor: blackout ? undefined : (colourOf(fixture, universes) ?? undefined),
                }}
                onClick={() =>
                  api
                    .setPlanPosition(fixture.id, {
                      x: Math.round(across / 2),
                      y: Math.round(deep / 2),
                    })
                    .then(reload)
                    .catch((e) => onError(e instanceof Error ? e.message : String(e)))
                }
              >
                {fixture.name}
              </button>
            ))}
          </div>
        </details>
      )}

      <details className="plan-tray">
        <summary>Escenario</summary>
        <div className="fields">
          <label className="field">
            <span>Ancho ({grid.units === 'feet' ? 'pies' : 'm'})</span>
            <input
              type="number"
              min={1}
              max={1000}
              defaultValue={grid.width}
              onBlur={(e) =>
                Number(e.target.value) !== grid.width &&
                api
                  .setPlanGrid({ width: Number(e.target.value) })
                  .then(reload)
                  .catch(fail)
              }
            />
          </label>
          <label className="field">
            <span>Fondo ({grid.units === 'feet' ? 'pies' : 'm'})</span>
            <input
              type="number"
              min={1}
              max={1000}
              defaultValue={grid.depth}
              onBlur={(e) =>
                Number(e.target.value) !== grid.depth &&
                api
                  .setPlanGrid({ depth: Number(e.target.value) })
                  .then(reload)
                  .catch(fail)
              }
            />
          </label>
          <label className="field">
            <span>Unidades</span>
            <select
              value={grid.units}
              onChange={(e) => api.setPlanGrid({ units: e.target.value }).then(reload).catch(fail)}
            >
              <option value="meters">Metros</option>
              <option value="feet">Pies</option>
            </select>
          </label>
          <label className="field">
            <span>Imagen de fondo</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/svg+xml"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file === undefined) return
                api
                  .uploadAsset(file)
                  .then(() => api.setPlanBackground(file.name))
                  .then(reload)
                  .catch(fail)
              }}
            />
          </label>
          {plan.background && (
            <button
              type="button"
              onClick={() => api.removePlanBackground().then(reload).catch(fail)}
            >
              Quitar fondo
            </button>
          )}
        </div>
      </details>

      {/* A hidden lamp that simply vanished could never be brought back. */}
      {hidden.length > 0 && (
        <details className="plan-tray">
          <summary>Ocultas ({hidden.length})</summary>
          <div className="tray-items">
            {hidden.map((fixture) => (
              <button
                key={fixture.id}
                type="button"
                className="tray-item"
                onClick={() =>
                  api.setPlanPosition(fixture.id, { hidden: false }).then(reload).catch(fail)
                }
              >
                {fixture.name}
              </button>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}

/**
 * Align and distribute, the two moves QLC+'s 2D offers a selection: a row of
 * pars eyeballed into place becomes a ROW, and the daemon holds the exact
 * millimetres the smoke can read back.
 */
function Arrange({
  selected,
  onDone,
  onFail,
}: {
  selected: PlanFixture[]
  onDone: () => void
  onFail: (e: unknown) => void
}) {
  const placed = selected.filter((f) => f.x !== undefined && f.y !== undefined)

  const move = (moves: { id: number; x?: number; y?: number }[]) =>
    Promise.all(
      moves.map((m) =>
        api.setPlanPosition(m.id, {
          ...(m.x !== undefined ? { x: m.x } : {}),
          ...(m.y !== undefined ? { y: m.y } : {}),
        }),
      ),
    )
      .then(onDone)
      .catch(onFail)

  const alignRow = () => {
    const y = Math.round(placed.reduce((sum, f) => sum + (f.y ?? 0), 0) / placed.length)
    move(placed.map((f) => ({ id: f.id, y })))
  }
  const alignColumn = () => {
    const x = Math.round(placed.reduce((sum, f) => sum + (f.x ?? 0), 0) / placed.length)
    move(placed.map((f) => ({ id: f.id, x })))
  }
  const distribute = (axis: 'x' | 'y') => {
    const sorted = [...placed].sort((a, b) => (a[axis] ?? 0) - (b[axis] ?? 0))
    const first = sorted[0]?.[axis] ?? 0
    const last = sorted[sorted.length - 1]?.[axis] ?? 0
    const step = sorted.length > 1 ? (last - first) / (sorted.length - 1) : 0
    move(sorted.map((f, i) => ({ id: f.id, [axis]: Math.round(first + i * step) })))
  }

  if (placed.length < 2) return null

  return (
    <div className="arrange">
      <button type="button" title="Alinear en fila (misma profundidad)" onClick={alignRow}>
        ⇤⇥
      </button>
      <button type="button" title="Alinear en columna (misma anchura)" onClick={alignColumn}>
        ⤒⤓
      </button>
      <button
        type="button"
        title="Distribuir a lo ancho, equidistantes"
        onClick={() => distribute('x')}
      >
        ⇹
      </button>
      <button
        type="button"
        title="Distribuir en profundidad, equidistantes"
        onClick={() => distribute('y')}
      >
        ⇳
      </button>
    </div>
  )
}

/**
 * What a lamp IS on the plan, as opposed to what it is doing: gel, rotation,
 * fixed zoom, and the four flags QLC+ hangs off a plan item. Per head, when
 * the fixture has more than one -- a pixel bar's cells can wear different
 * gels, and the file says which with a Head attribute.
 */
function LampProps({
  fixture,
  onDone,
  onFail,
}: {
  fixture: PlanFixture
  onDone: () => void
  onFail: (e: unknown) => void
}) {
  const [head, setHead] = useState(0)
  const heads = fixture.heads ?? 1

  const item = head === 0 ? fixture : fixture.headItems?.find((h) => h.head === head)

  const write = (patch: Parameters<typeof api.setPlanPosition>[1]) =>
    api
      .setPlanPosition(fixture.id, { ...patch, head })
      .then(onDone)
      .catch(onFail)

  const flag = (
    key: 'hidden' | 'locked' | 'invertPan' | 'invertTilt',
    label: string,
    title: string,
  ) => (
    <label className="field row-field" title={title}>
      <input
        type="checkbox"
        checked={item?.[key] === true}
        onChange={(e) => write({ [key]: e.target.checked })}
      />
      <span>{label}</span>
    </label>
  )

  return (
    <details className="lamp-props">
      <summary>Propiedades</summary>

      {heads > 1 && (
        <label className="field">
          <span>Cabeza</span>
          <select value={head} onChange={(e) => setHead(Number(e.target.value))}>
            <option value={0}>Toda la fixture</option>
            {Array.from({ length: heads }, (_, i) => i)
              .slice(1)
              .map((i) => (
                <option key={i} value={i}>
                  Cabeza {i + 1}
                </option>
              ))}
          </select>
        </label>
      )}

      <div className="fields">
        <label className="field">
          <span>Gel</span>
          <input
            type="color"
            value={item?.gel ?? '#ffffff'}
            onChange={(e) => write({ gel: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Rotación</span>
          <input
            type="number"
            min={0}
            max={359}
            value={item?.rotation ?? 0}
            onChange={(e) => write({ rotation: Number(e.target.value) })}
          />
        </label>
        {head === 0 && (
          <label className="field">
            <span>Altura (mm)</span>
            <input
              type="number"
              min={0}
              max={30000}
              title="A cuántos milímetros del suelo cuelga; el fichero la guarda y la 3D la usará"
              value={'z' in (item ?? {}) ? ((item as PlanFixture).z ?? 0) : 0}
              onChange={(e) => write({ z: Number(e.target.value) })}
            />
          </label>
        )}
        {head === 0 && (
          <label className="field">
            <span>Inclinación (X°)</span>
            <input
              type="number"
              min={-180}
              max={180}
              title="La percha: cómo cuelga el aparato, no hacia dónde apunta"
              value={'rotationX' in (item ?? {}) ? ((item as PlanFixture).rotationX ?? 0) : 0}
              onChange={(e) => write({ rotationX: Number(e.target.value) })}
            />
          </label>
        )}
        <label className="field">
          <span>Zoom fijo</span>
          <input
            type="number"
            min={0}
            max={180}
            title="Ancho de haz en grados; 0 lo deja al canal"
            value={item?.zoom ?? 0}
            onChange={(e) => write({ zoom: Number(e.target.value) })}
          />
        </label>
      </div>

      <button
        type="button"
        title="Dibuja esta lámpara otra vez en la planta: mismo patch, otro sitio (un dímer que alimenta dos focos)"
        onClick={() =>
          api
            .addLinkedFixture(fixture.id, {
              head,
              x: (fixture.x ?? 0) + 500,
              y: fixture.y ?? 0,
            })
            .then(onDone)
            .catch(onFail)
        }
      >
        Añadir enlazada
      </button>

      {flag('hidden', 'Oculta', 'No se dibuja en la planta; se recupera desde «Ocultas»')}
      {flag('locked', 'Bloqueada', 'Se queda donde está: la planta no la deja arrastrar')}
      {flag(
        'invertPan',
        'Pan invertido',
        'Para la vista 2D/3D y QLC+: el indicador de pan se dibuja al revés',
      )}
      {flag(
        'invertTilt',
        'Tilt invertido',
        'Para la vista 2D/3D y QLC+: el indicador de tilt se dibuja al revés',
      )}
    </details>
  )
}

function Lamp({
  fixture,
  at,
  aim,
  across,
  deep,
  chosen,
  colour,
  onGrab,
  onRemove,
}: {
  fixture: PlanFixture
  /** Where the finger has it, while it is being dragged. */
  at: { x: number; y: number } | null
  /** Where the head points, when it has pan or tilt to point with. */
  aim: { angle: number; lean: number } | null
  /** The stage, in millimetres, so a position can be a fraction of it. */
  across: number
  deep: number
  /** Part of what you are working on. */
  chosen: boolean
  colour: string | null
  onGrab: (event: React.PointerEvent) => void
  onRemove: () => void
}) {
  const x = at?.x ?? fixture.x ?? 0
  const y = at?.y ?? fixture.y ?? 0

  /* The real footprint when the definition declares one: a two-metre bar
     drawn as the same dot as a PAR is a plan that lies about rigging room. */
  const footprint =
    fixture.width !== undefined && fixture.width > 400
      ? { width: `${Math.min(40, (fixture.width / across) * 100)}%` }
      : {}

  return (
    <div
      className="lamp"
      data-dragging={at !== null}
      data-chosen={chosen}
      data-dark={colour === null}
      data-fixture={fixture.id}
      style={{
        left: `${(x / across) * 100}%`,
        top: `${(y / deep) * 100}%`,
        transform: `translate(-50%, -50%) rotate(${fixture.rotation ?? 0}deg)`,
        ...footprint,
        /* Lit: filled, ringed in its own colour, and throwing a halo. The
           halo is the whole point of drawing a rig from above -- a flat disc
           says which lamp, a glow says which lamp is on, and that is the
           question somebody standing at the desk is actually asking. */
        ...(colour !== null
          ? { background: colour, borderColor: colour, boxShadow: `0 0 22px ${colour}` }
          : {}),
      }}
      title={`${fixture.name} · U${fixture.universe} @ ${fixture.address + 1}`}
      onPointerDown={(e) => {
        e.preventDefault()
        onGrab(e)
      }}
      onDoubleClick={onRemove}
    >
      {aim !== null && (
        <span
          className="lamp-aim"
          aria-hidden="true"
          style={{
            transform: `rotate(${aim.angle}deg)`,
            height: `${20 + aim.lean * 80}%`,
          }}
        />
      )}
      {/* The label carries the position while the lamp is moving. Placing a rig
          means putting a lamp *somewhere*, and "somewhere" on a plan is a
          measurement, not a feeling. */}
      <span className="lamp-label">
        {at !== null ? `${(x / 1000).toFixed(2)} · ${(y / 1000).toFixed(2)} m` : fixture.name}
      </span>
    </div>
  )
}

/**
 * What colour a fixture is putting out, from the frame on the wire.
 *
 * Returns null when it is dark, which the caller draws as an outline rather
 * than as black: a lamp at zero and a lamp whose universe is not being received
 * look identical if both are painted black, and only one of them is a problem.
 *
 * A fixture with no colour channels is white scaled by its dimmer -- which is
 * what a dimmer-only lamp is. One with neither is reported dark, because
 * nothing about it is known.
 */
/**
 * A colour, resolved into the channel values that produce it on this fixture.
 *
 * The inverse of colourOf, and deliberately in the same file: the roles are one
 * contract, and a second copy of the mapping somewhere else is a second thing
 * to drift. Returns an empty list for a fixture that cannot take a colour at
 * all -- a plain dimmer has nothing to mix with -- which is a fact the caller
 * has to show rather than paper over.
 *
 * White and amber are driven to zero along with it. A red asked for on an RGBW
 * bar whose white is still up is pink, and nobody asked for pink.
 */
export function colourValues(
  fixture: PlanFixture,
  colour: { r: number; g: number; b: number },
): { channel: number; value: number }[] {
  const roles = fixture.roles
  const out: { channel: number; value: number }[] = []

  if (roles.red !== undefined && roles.green !== undefined && roles.blue !== undefined) {
    out.push({ channel: roles.red, value: colour.r })
    out.push({ channel: roles.green, value: colour.g })
    out.push({ channel: roles.blue, value: colour.b })
  } else if (
    roles.cyan !== undefined &&
    roles.magenta !== undefined &&
    roles.yellow !== undefined
  ) {
    /* Subtractive: the filter takes light out, so full cyan is no red. */
    out.push({ channel: roles.cyan, value: 255 - colour.r })
    out.push({ channel: roles.magenta, value: 255 - colour.g })
    out.push({ channel: roles.yellow, value: 255 - colour.b })
  } else {
    return []
  }

  for (const extra of [roles.white, roles.amber]) {
    if (extra !== undefined) out.push({ channel: extra, value: 0 })
  }

  return out
}

/** #rrggbb into the three numbers the channels want. */
export function parseHex(hex: string): { r: number; g: number; b: number } {
  const n = Number.parseInt(hex.replace('#', ''), 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

/**
 * Where a moving head points, read straight off the frame: pan as an angle,
 * tilt as how far off straight-down the beam leans. Inverted flags flip the
 * reading -- which is the flags' whole job, and the promise F15a left open.
 */
export function aimOf(
  fixture: PlanFixture,
  universes: Record<number, Uint8Array>,
): { angle: number; lean: number } | null {
  const roles = fixture.roles
  if (roles.pan === undefined && roles.tilt === undefined) return null
  const frame = universes[fixture.universe]
  if (frame === undefined) return null

  let pan = roles.pan !== undefined ? (frame[fixture.address + roles.pan] ?? 0) : 128
  let tilt = roles.tilt !== undefined ? (frame[fixture.address + roles.tilt] ?? 0) : 255
  if (fixture.invertPan === true) pan = 255 - pan
  if (fixture.invertTilt === true) tilt = 255 - tilt

  return {
    /* Pan sweeps the needle around the symbol; the fixture's own plan
       rotation is added by the transform it sits inside. */
    angle: (pan / 255) * 360 - 180,
    /* Tilt stretches it: centred beam (straight down) shows a stub, full
       throw a long needle. */
    lean: Math.abs(tilt - 128) / 128,
  }
}

export function colourOf(
  fixture: PlanFixture,
  universes: Record<number, Uint8Array>,
): string | null {
  const frame = universes[fixture.universe]
  if (frame === undefined) return null

  const at = (offset: number | undefined) =>
    offset === undefined ? undefined : frame[fixture.address + offset]

  const roles = fixture.roles
  const dimmer = at(roles.intensity)

  let r: number | undefined
  let g: number | undefined
  let b: number | undefined

  if (roles.red !== undefined) {
    r = at(roles.red) ?? 0
    g = at(roles.green) ?? 0
    b = at(roles.blue) ?? 0
  } else if (roles.cyan !== undefined) {
    /* Subtractive: a cyan filter at full takes all the red out. */
    r = 255 - (at(roles.cyan) ?? 0)
    g = 255 - (at(roles.magenta) ?? 0)
    b = 255 - (at(roles.yellow) ?? 0)
  }

  // White, amber and UV sit on top of whatever the colour mixing produced.
  const white = at(roles.white) ?? 0
  const amber = at(roles.amber) ?? 0

  if (r === undefined || g === undefined || b === undefined) {
    // No colour mixing at all: a dimmer is a white lamp.
    if (dimmer === undefined && white === 0 && amber === 0) return null
    r = 255
    g = 255
    b = 255
  }

  r = Math.min(255, r + white + amber)
  g = Math.min(255, g + white + Math.round(amber * 0.75))
  b = Math.min(255, b + white)

  // The dimmer scales all of it. A fixture without one is at full by definition.
  const level = dimmer === undefined ? 255 : dimmer
  if (level === 0) return null

  const scaled = (value: number) => Math.round((value * level) / 255)
  const out = [scaled(r), scaled(g), scaled(b)]

  if (out[0] === 0 && out[1] === 0 && out[2] === 0) return null

  return `rgb(${out[0]}, ${out[1]}, ${out[2]})`
}
