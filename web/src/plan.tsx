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
  onToggle,
  onError,
}: {
  revision: number
  /** The latest frame of each universe, 1-based, as the feed delivers it. */
  universes: Record<number, Uint8Array>
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
  const [drag, setDrag] = useState<{ id: number; x: number; y: number } | null>(null)
  /* Which lamps you are working on. The plan stops being a picture of the rig
     the moment you can point at part of it and say "these". */
  const [chosen, setChosen] = useState<number[]>([])
  const [level, setLevel] = useState(255)
  const surface = useRef<HTMLDivElement>(null)
  /* A finger down on a lamp is not yet a drag. Below the threshold it is a tap,
     which chooses the lamp instead of moving it -- the same rule as the
     console, for the same reason: one gesture that does two things needs to
     know which one before it commits to either. */
  const pending = useRef<{ id: number; x: number; y: number } | null>(null)

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

  const placed = plan.fixtures.filter((f) => f.x !== undefined && f.y !== undefined)
  const unplaced = plan.fixtures.filter((f) => f.x === undefined || f.y === undefined)

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
          onPointerMove={(e) => {
            const held = pending.current
            if (held !== null && drag === null) {
              const far = Math.abs(e.clientX - held.x) > 8 || Math.abs(e.clientY - held.y) > 8
              if (!far) return
              const at = toStage(e)
              setDrag({ id: held.id, x: at?.x ?? 0, y: at?.y ?? 0 })
              return
            }

            if (drag === null) return
            e.preventDefault()
            const at = toStage(e)
            if (at !== null) setDrag({ id: drag.id, ...at })
          }}
          onPointerUp={() => {
            const held = pending.current
            pending.current = null

            if (drag !== null) {
              place(drag.id, drag.x, drag.y)
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
              across={across}
              deep={deep}
              chosen={chosen.includes(fixture.id)}
              colour={colourOf(fixture, universes)}
              onGrab={(event) => {
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
            onClick={() => api.blackout(true).then(() => undefined, fail)}
          >
            <span className="cue-name">BLACKOUT</span>
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
        </details>
      )}
    </div>
  )
}

function Lamp({
  fixture,
  at,
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
