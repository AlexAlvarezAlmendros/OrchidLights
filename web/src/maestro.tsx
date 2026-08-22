/**
 * The Grand Master and the panic button, side by side in the show bar.
 *
 * Two different last resorts, and the difference matters mid-show:
 *
 *  - The GM scales (or caps) what is already happening -- the whole rig
 *    dimmed smoothly with one fader, nothing ends.
 *  - STOP ALL ends every running function, optionally fading it out first.
 *    Blackout, the third sibling, silences without ending anything.
 *
 * The GM honours the project's Visible flag: QLC+ lets a designer hide it,
 * and a desk that grows controls the project turned off is a desk that
 * behaves differently here than there.
 */

import { useEffect, useRef, useState } from 'react'
import { type GrandMasterState, api } from './api'
import { Slider } from './slider'

const FADES = [
  { ms: 0, label: 'Ahora' },
  { ms: 1000, label: '1 s' },
  { ms: 5000, label: '5 s' },
  { ms: 10000, label: '10 s' },
  { ms: 30000, label: '30 s' },
]

export function GrandMasterDock({
  state,
  learning,
  onState,
  onError,
}: {
  state: GrandMasterState | null
  /** The last external control that moved, for learning the GM's binding. */
  learning: { universe: number; channel: number; value: number } | null
  onState: (state: GrandMasterState) => void
  onError: (message: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [listening, setListening] = useState(false)
  const panel = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent) => {
      if (panel.current?.contains(event.target as Node) === true) return
      setOpen(false)
    }
    window.addEventListener('pointerdown', away)
    return () => window.removeEventListener('pointerdown', away)
  }, [open])

  const apply = (patch: Partial<GrandMasterState>) =>
    api
      .setGrandMaster(patch)
      .then(onState, (e: unknown) => onError(e instanceof Error ? e.message : String(e)))

  /* Bind to whatever arrives while listening -- the operator's hand is on the
     control, exactly like a widget's Aprender. BEFORE the early return below:
     every hook must run on every render, including the renders where the dock
     is hidden. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: apply is stable per render and listing it would re-arm on every state echo
  useEffect(() => {
    if (!listening || learning === null) return
    setListening(false)
    apply({ input: { universe: learning.universe, channel: learning.channel } })
  }, [listening, learning])

  if (state === null || state.visible === false) return null

  const percent = Math.round((state.value / 255) * 100)

  return (
    <div className="gm" ref={panel}>
      <button
        type="button"
        className="gm-badge num"
        title={`Grand Master · ${state.valueMode === 'Limit' ? 'limita' : 'reduce'} · ${
          state.channelMode === 'All' ? 'todos los canales' : 'intensidad'
        }`}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        data-active={state.value < 255}
      >
        GM {percent}%
      </button>

      {open && (
        <div className="gm-panel">
          <label className="field">
            <span className="field-head">
              Grand Master<span className="num">{percent}%</span>
            </span>
            <Slider
              min={0}
              max={255}
              value={state.value}
              aria-label="Grand Master"
              onChange={(e) => apply({ value: Number(e.target.value) })}
            />
          </label>

          <div className="gm-modes">
            <label className="field">
              <span>Valores</span>
              <select
                value={state.valueMode}
                onChange={(e) => apply({ valueMode: e.target.value })}
              >
                <option value="Reduce">Reducir (escala)</option>
                <option value="Limit">Limitar (techo)</option>
              </select>
            </label>
            <label className="field">
              <span>Canales</span>
              <select
                value={state.channelMode}
                onChange={(e) => apply({ channelMode: e.target.value })}
              >
                <option value="Intensity">Solo intensidad</option>
                <option value="All">Todos</option>
              </select>
            </label>
          </div>

          {/* The big fader on a real fader: the GM is a routing destination
              like any button, learned the same way -- move the control. */}
          <div className="gm-input">
            <span className="field-head">
              Control externo
              <span>
                {state.input
                  ? `U${state.input.universe} · canal ${state.input.channel}`
                  : 'sin asignar'}
              </span>
            </span>
            <div className="gm-input-buttons">
              <button
                type="button"
                aria-pressed={listening}
                onClick={() => setListening((on) => !on)}
              >
                {listening ? 'Esperando… mueve el control' : 'Aprender'}
              </button>
              <button
                type="button"
                disabled={state.input === null || state.input === undefined}
                onClick={() => apply({ input: null })}
              >
                Quitar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export function StopAll({
  running,
  onError,
}: {
  running: number
  onError: (message: string) => void
}) {
  const [open, setOpen] = useState(false)
  const menu = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent) => {
      if (menu.current?.contains(event.target as Node) === true) return
      setOpen(false)
    }
    window.addEventListener('pointerdown', away)
    return () => window.removeEventListener('pointerdown', away)
  }, [open])

  const stop = (fadeMs: number) => {
    setOpen(false)
    api.stopAll(fadeMs).catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
  }

  /* Disabled with nothing running, and saying why: a panic button that is
     always pressable teaches people to press it to "make sure", and then one
     night it ends the show they meant to keep. */
  return (
    <div className="stopall" ref={menu}>
      <button
        type="button"
        className="danger"
        disabled={running === 0}
        title={running === 0 ? 'No hay funciones en marcha' : 'Parar todas las funciones'}
        onClick={() => stop(0)}
      >
        STOP {running > 0 ? running : ''}
      </button>
      <button
        type="button"
        className="danger stopall-more"
        disabled={running === 0}
        aria-label="Parar con fundido"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        ▾
      </button>

      {open && (
        <div className="stopall-menu">
          {FADES.map((fade) => (
            <button key={fade.ms} type="button" onClick={() => stop(fade.ms)}>
              {fade.ms === 0 ? 'Parar ahora' : `Fundir ${fade.label} y parar`}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * The global metronome, in the show bar: BPM, a beat LED that blinks on the
 * ENGINE's beat (not a local timer -- that drifts against the chasers it
 * claims to count), and tap tempo. Chasers whose tempo is Beats advance on
 * this.
 */
export function BpmDock({ beatTick }: { beatTick: number }) {
  const [state, setState] = useState<{ source: string; bpm: number } | null>(null)
  const [lit, setLit] = useState(false)
  const taps = useRef<number[]>([])

  useEffect(() => {
    api
      .beat()
      .then(setState)
      .catch(() => setState(null))
  }, [])

  /* The LED: on for a flash after every engine beat. */
  useEffect(() => {
    if (beatTick === 0) return
    setLit(true)
    const off = setTimeout(() => setLit(false), 120)
    return () => clearTimeout(off)
  }, [beatTick])

  if (state === null) return null

  const running = state.source === 'internal'

  const write = (body: { source?: string; bpm?: number }) =>
    api
      .setBeat(body)
      .then(setState)
      .catch(() => undefined)

  const tap = () => {
    const now = performance.now()
    /* A pause longer than two seconds starts a new measurement: nobody taps
       a tempo that slow, they stopped tapping. */
    if (taps.current.length > 0 && now - (taps.current.at(-1) ?? 0) > 2000) {
      taps.current = []
    }
    taps.current.push(now)
    if (taps.current.length < 3) return
    taps.current = taps.current.slice(-5)
    const gaps = taps.current.slice(1).map((t, i) => t - (taps.current[i] ?? 0))
    const average = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length
    const bpm = Math.max(1, Math.min(500, Math.round(60_000 / average)))
    write({ source: 'internal', bpm })
  }

  return (
    <div
      className="bpm-dock"
      title="Metrónomo del motor: los chasers en tempo Beats avanzan con él"
    >
      <button
        type="button"
        aria-pressed={running}
        title={running ? 'Parar el metrónomo' : 'Arrancar el metrónomo'}
        onClick={() => write({ source: running ? 'none' : 'internal' })}
      >
        <span className="bpm-led" data-on={lit && running} aria-hidden="true" />
        BPM
      </button>
      <input
        type="number"
        min={1}
        max={500}
        value={state.bpm}
        aria-label="Pulsos por minuto"
        onChange={(e) => write({ bpm: Number(e.target.value) })}
      />
      <button type="button" title="Marca el tempo a golpes" onClick={tap}>
        TAP
      </button>
    </div>
  )
}
