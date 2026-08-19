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
import { type PlanFixture, type PlanState, api } from './api'

/** How far the drawing is from the truth, in pixels per millimetre. Set from
 *  the grid so a stage of any size fits the same box. */
const PLAN_WIDTH = 720

export function Plan({
  revision,
  universes,
  onError,
}: {
  revision: number
  /** The latest frame of each universe, 1-based, as the feed delivers it. */
  universes: Record<number, Uint8Array>
  onError: (message: string | null) => void
}) {
  const [plan, setPlan] = useState<PlanState | null>(null)
  /* The lamp being moved and where it is right now, in millimetres.
   *
     It used to be only the id: the lamp stayed where it was until the finger
     came up and then jumped. Placing a rig that way is guesswork -- you find
     out where you put something after you have put it. */
  const [drag, setDrag] = useState<{ id: number; x: number; y: number } | null>(null)
  const surface = useRef<HTMLDivElement>(null)

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

  if (plan === null) return <p className="hint">Leyendo la planta…</p>

  const grid = plan.grid
  /* Millimetres across the stage. The grid is in metres or feet; either way the
     positions are millimetres, which is what QLC+ stores. */
  const across = grid.units === 'feet' ? grid.width * 304.8 : grid.width * 1000
  const deep = grid.units === 'feet' ? grid.depth * 304.8 : grid.depth * 1000
  const scale = PLAN_WIDTH / across

  const placed = plan.fixtures.filter((f) => f.x !== undefined && f.y !== undefined)
  const unplaced = plan.fixtures.filter((f) => f.x === undefined || f.y === undefined)

  /** Pointer coordinates as millimetres on the stage, clamped to it. */
  const toStage = (event: React.PointerEvent) => {
    const box = surface.current?.getBoundingClientRect()
    if (box === undefined) return null

    return {
      x: Math.round(Math.max(0, Math.min(across, (event.clientX - box.left) / scale))),
      y: Math.round(Math.max(0, Math.min(deep, (event.clientY - box.top) / scale))),
    }
  }

  const place = (id: number, x: number, y: number) => {
    onError(null)
    api
      .setPlanPosition(id, { x, y })
      .then(reload)
      .catch((e) => {
        onError(e instanceof Error ? e.message : String(e))
        reload()
      })
  }

  return (
    <div className="plan">
      <p className="hint">
        Cada lámpara con el color que está dando ahora mismo, calculado aquí a partir de los frames
        DMX. Arrastra para colocarlas; el escenario mide {grid.width} × {grid.depth}{' '}
        {grid.units === 'feet' ? 'pies' : 'metros'}.
      </p>

      <div
        className="plan-stage"
        ref={surface}
        data-dragging={drag !== null}
        style={{ width: PLAN_WIDTH, height: deep * scale }}
        onPointerMove={(e) => {
          if (drag === null) return
          e.preventDefault()
          const at = toStage(e)
          if (at !== null) setDrag({ id: drag.id, ...at })
        }}
        onPointerUp={() => {
          if (drag === null) return
          place(drag.id, drag.x, drag.y)
          setDrag(null)
        }}
        onPointerLeave={() => {
          /* The finger left the stage. Committing where it last was beats
             dropping the move: a lamp dragged to the very edge is a lamp
             somebody meant to put at the edge. */
          if (drag === null) return
          place(drag.id, drag.x, drag.y)
          setDrag(null)
        }}
      >
        {plan.background && (
          <img className="plan-background" src="/api/v1/plan/background" alt="" />
        )}

        {placed.map((fixture) => (
          <Lamp
            key={fixture.id}
            fixture={fixture}
            /* While it is being dragged the lamp is drawn where the finger is,
               not where the daemon still has it. */
            at={drag !== null && drag.id === fixture.id ? drag : null}
            scale={scale}
            colour={colourOf(fixture, universes)}
            onGrab={(event) => {
              const at = toStage(event)
              setDrag({ id: fixture.id, x: at?.x ?? fixture.x ?? 0, y: at?.y ?? fixture.y ?? 0 })
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

      {unplaced.length > 0 && (
        <div className="plan-tray">
          <p className="hint">
            Sin colocar ({unplaced.length}). Púlsalas para ponerlas en el centro y arrastra desde
            ahí.
          </p>
          <div className="tray-items">
            {unplaced.map((fixture) => (
              <button
                key={fixture.id}
                type="button"
                className="tray-item"
                style={{ borderColor: colourOf(fixture, universes) ?? undefined }}
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
        </div>
      )}
    </div>
  )
}

function Lamp({
  fixture,
  at,
  scale,
  colour,
  onGrab,
  onRemove,
}: {
  fixture: PlanFixture
  /** Where the finger has it, while it is being dragged. */
  at: { x: number; y: number } | null
  scale: number
  colour: string | null
  onGrab: (event: React.PointerEvent) => void
  onRemove: () => void
}) {
  const x = at?.x ?? fixture.x ?? 0
  const y = at?.y ?? fixture.y ?? 0

  return (
    <div
      className="lamp"
      data-dragging={at !== null}
      data-dark={colour === null}
      data-fixture={fixture.id}
      style={{
        left: `${x * scale}px`,
        top: `${y * scale}px`,
        transform: `translate(-50%, -50%) rotate(${fixture.rotation ?? 0}deg)`,
        ...(colour !== null ? { background: colour, boxShadow: `0 0 18px ${colour}` } : {}),
      }}
      title={`${fixture.name} · U${fixture.universe} @ ${fixture.address + 1}`}
      onPointerDown={(e) => {
        e.preventDefault()
        onGrab(e)
      }}
      onDoubleClick={onRemove}
    >
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
