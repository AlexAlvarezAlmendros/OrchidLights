/**
 * Editing a widget from the browser.
 *
 * The panel only offers what the widget in front of you actually has. A label
 * has a caption and nothing else; a button has a function and an action; a
 * fader has a mode and, in level mode, the channels it drives. Offering every
 * field for every type would let an operator set things that quietly do
 * nothing, which is the failure this whole layer is built to avoid.
 *
 * Geometry is deliberately absent. QLC+ places widgets at absolute pixels;
 * OrchidLights reflows them into rows, and the order is edited by dragging in
 * "Ordenar". Exposing x and y here would be editing a coordinate system the
 * operator never sees.
 */

import { useEffect, useRef, useState } from 'react'
import {
  type FixtureDetail,
  type FixtureState,
  type FunctionState,
  type WidgetPatch,
  api,
} from './api'
import type { VcWidget } from './layout'
import { keySequenceOf } from './teclas'

const ACTIONS = [
  { value: 'Toggle', label: 'Alternar' },
  { value: 'Flash', label: 'Flash' },
  { value: 'Blackout', label: 'Blackout' },
  { value: 'StopAll', label: 'Parar todo' },
]

const SLIDER_MODES = [
  { value: 'Level', label: 'Nivel (canales)' },
  { value: 'Playback', label: 'Playback (función)' },
  { value: 'Submaster', label: 'Submaster' },
  { value: 'GrandMaster', label: 'Grand Master' },
  { value: 'Adjust', label: 'Ajuste (atributo de función)' },
]

const CLOCK_TYPES = [
  { value: 'Clock', label: 'Hora' },
  { value: 'Stopwatch', label: 'Cronómetro' },
  { value: 'Countdown', label: 'Cuenta atrás' },
]

export function WidgetEditor({
  widget,
  functions,
  fixtures,
  learning,
  onApply,
  onDelete,
  onClose,
}: {
  widget: VcWidget
  functions: FunctionState[]
  fixtures: FixtureState[]
  /** The last external control the daemon saw, so a binding can be learned by
   *  pressing the thing rather than typed as two numbers nobody knows. */
  learning: { universe: number; channel: number; value: number } | null
  onApply: (patch: WidgetPatch) => Promise<void>
  onDelete: () => Promise<void>
  onClose: () => void
}) {
  const [caption, setCaption] = useState(widget.caption ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const panel = useRef<HTMLElement>(null)

  /* Reset when the panel is pointed at a *different* widget, keyed on the id
     rather than the object.
   *
   * Every edit re-reads the console, so the widget object is new each time even
   * when nothing about it changed. Keying on the object would therefore reset
   * the box mid-sentence, every time any edit landed -- including one this
   * panel made itself. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the id on purpose
  useEffect(() => {
    setCaption(widget.caption ?? '')
    setError(null)

    /* On a phone the panel is below the console, so choosing a widget opens
       something off the bottom of the screen. Tapping a button and having
       nothing visibly happen is the single most common way an interface
       teaches somebody that it is broken. */
    if (window.matchMedia('(max-width: 699px)').matches) {
      panel.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [widget.id])

  const apply = async (patch: WidgetPatch) => {
    setBusy(true)
    setError(null)
    try {
      await onApply(patch)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const isSlider = widget.type === 'slider'
  const isButton = widget.type === 'button'
  const isCueList = widget.type === 'cuelist'
  const isClock = widget.type === 'clock'
  const isFrame = widget.type === 'frame' || widget.type === 'soloframe'
  const isPad = widget.type === 'xypad'
  const chasers = functions.filter((f) => f.type === 'Chaser')

  return (
    <aside className="editor" ref={panel} aria-label={`Editar ${widget.caption || widget.type}`}>
      <header>
        <strong>{widget.caption || widget.type}</strong>
        <span className="chip">
          {widget.type} · #{widget.id}
        </span>
        <span className="spacer" />
        <button type="button" onClick={onClose} aria-label="Cerrar">
          ✕
        </button>
      </header>

      {error && <p className="editor-error">{error}</p>}

      <label className="field">
        <span>Nombre</span>
        {/* On Enter as well as on leaving the field: on a phone the keyboard's
            "done" is the natural end of typing, and losing a name to a tap
            somewhere else is the kind of small betrayal that stops people
            trusting an editor. */}
        <input
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          onBlur={() => caption !== (widget.caption ?? '') && apply({ caption })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && caption !== (widget.caption ?? '')) apply({ caption })
          }}
          disabled={busy}
        />
      </label>

      {isButton && (
        <>
          <FunctionPicker
            label="Función"
            options={functions}
            value={widget.functionId}
            onChange={(functionId) => apply({ functionId })}
            disabled={busy}
          />
          <label className="field">
            <span>Al pulsar</span>
            <select
              value={widget.action ?? 'Toggle'}
              onChange={(e) => apply({ action: e.target.value })}
              disabled={busy}
            >
              {ACTIONS.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>

          {widget.action === 'Flash' && (
            <div className="fields">
              <label className="field row-field">
                <input
                  type="checkbox"
                  checked={widget.flashOverride ?? false}
                  disabled={busy}
                  onChange={(e) => apply({ flashOverride: e.target.checked })}
                />
                <span>Pisa lo que corre (override)</span>
              </label>
              <label className="field row-field">
                <input
                  type="checkbox"
                  checked={widget.flashForceLTP ?? false}
                  disabled={busy}
                  onChange={(e) => apply({ flashForceLTP: e.target.checked })}
                />
                <span>Forzar LTP</span>
              </label>
            </div>
          )}

          <div className="fields">
            <label className="field row-field">
              <input
                type="checkbox"
                checked={widget.startupIntensity?.enabled ?? false}
                disabled={busy}
                onChange={(e) =>
                  apply({
                    startupIntensity: {
                      enabled: e.target.checked,
                      value: widget.startupIntensity?.value ?? 100,
                    },
                  })
                }
              />
              <span>Intensidad de arranque</span>
            </label>
            {widget.startupIntensity?.enabled === true && (
              <label className="field">
                <span>%</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  defaultValue={widget.startupIntensity?.value ?? 100}
                  disabled={busy}
                  onBlur={(e) =>
                    apply({
                      startupIntensity: { enabled: true, value: Number(e.target.value) },
                    })
                  }
                />
              </label>
            )}
          </div>
        </>
      )}

      {isCueList && (
        <FunctionPicker
          label="Chaser"
          options={chasers}
          value={widget.chaserId}
          onChange={(chaserId) => apply({ chaserId })}
          disabled={busy}
          {...(chasers.length === 0 ? { empty: 'El proyecto no tiene ningún chaser' } : {})}
        />
      )}

      {isSlider && (
        <>
          <label className="field">
            <span>Modo</span>
            <select
              value={capitalise(widget.sliderMode ?? 'Level')}
              onChange={(e) => apply({ sliderMode: e.target.value })}
              disabled={busy}
            >
              {SLIDER_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>

          {widget.sliderMode === 'playback' && (
            <FunctionPicker
              label="Función"
              options={functions}
              value={widget.functionId}
              onChange={(functionId) => apply({ functionId })}
              disabled={busy}
            />
          )}

          {widget.sliderMode === 'level' && (
            <LevelChannels
              channels={widget.levelChannels ?? []}
              fixtures={fixtures}
              onChange={(levelChannels) => apply({ levelChannels })}
              disabled={busy}
            />
          )}

          {widget.sliderMode === 'adjust' && (
            <FunctionPicker
              label="Función a ajustar"
              options={functions}
              value={widget.adjust?.function}
              onChange={(functionId) =>
                apply({
                  adjust: functionId === null ? null : { function: functionId, attribute: 0 },
                })
              }
              disabled={busy}
            />
          )}

          {widget.sliderMode === 'grandmaster' && (
            <p className="hint">
              Este fader ES el Grand Master: moverlo aquí mueve el de la barra, y al revés.
            </p>
          )}
        </>
      )}

      {isClock && (
        <>
          <ClockAgenda widget={widget} functions={functions} busy={busy} onApply={apply} />
          <label className="field">
            <span>Tipo</span>
            <select
              value={capitalise(widget.clockType ?? 'Clock')}
              onChange={(e) => apply({ clockType: e.target.value })}
              disabled={busy}
            >
              {CLOCK_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>

          {widget.clockType !== 'clock' && (
            <label className="field">
              <span>Tiempo</span>
              <input
                type="time"
                step={1}
                value={secondsToTime(widget.clockTime ?? 0)}
                onChange={(e) => apply({ clockTime: timeToSeconds(e.target.value) })}
                disabled={busy}
              />
            </label>
          )}
        </>
      )}

      <Appearance widget={widget} busy={busy} onApply={apply} />
      {isFrame && (
        <div className="fields">
          <label className="field">
            <span>Páginas</span>
            <input
              type="number"
              min={0}
              max={64}
              defaultValue={widget.pages ?? 0}
              disabled={busy}
              onBlur={(e) => {
                const pages = Number(e.target.value)
                if (pages !== (widget.pages ?? 0)) apply({ pages })
              }}
            />
          </label>
          {(widget.pages ?? 0) > 1 && (
            <>
              <label className="field row-field">
                <input
                  type="checkbox"
                  checked={widget.pagesLoop ?? false}
                  disabled={busy}
                  onChange={(e) => apply({ pagesLoop: e.target.checked })}
                />
                <span>Las páginas dan la vuelta</span>
              </label>
              <PageInputLearner busy={busy} learning={learning} onApply={apply} />
            </>
          )}
        </div>
      )}

      {isFrame &&
        (widget.pages ?? 0) > 1 &&
        Array.from({ length: widget.pages ?? 0 }, (_, index) => (
          // The page number is the identity: a fixed list, in order.
          // biome-ignore lint/suspicious/noArrayIndexKey: the index is the page
          <label className="field" key={index}>
            <span>Nombre de la página {index + 1}</span>
            <input
              defaultValue={widget.pageShortcuts?.find((sc) => sc.page === index)?.name ?? ''}
              placeholder={`${index + 1}`}
              disabled={busy}
              onBlur={(e) => {
                const next = Array.from({ length: widget.pages ?? 0 }, (_, page) => ({
                  page,
                  name:
                    page === index
                      ? e.target.value.trim()
                      : (widget.pageShortcuts?.find((sc) => sc.page === page)?.name ?? ''),
                })).filter((entry) => entry.name !== '')
                apply({ pageShortcuts: next })
              }}
            />
          </label>
        ))}

      {isCueList && (
        <label className="field">
          <span>Fader lateral</span>
          <select
            value={widget.sideFaderMode ?? 'None'}
            disabled={busy}
            onChange={(e) => apply({ sideFaderMode: e.target.value })}
          >
            <option value="None">Ninguno</option>
            <option value="Crossfade">Crossfade</option>
            <option value="Steps">Pasos</option>
          </select>
        </label>
      )}

      {isPad && (
        <div className="fields">
          <button
            type="button"
            disabled={busy}
            title="Guarda la posición actual del pad como preset"
            onClick={() => {
              const name = `Posición ${(widget.padPresets?.length ?? 0) + 1}`
              apply({
                padPresets: [
                  ...(widget.padPresets ?? []).map((p) => ({
                    type: p.type,
                    name: p.name,
                    ...(p.x !== undefined ? { x: p.x, y: p.y ?? 0 } : {}),
                    ...(p.function !== undefined ? { function: p.function } : {}),
                  })),
                  { type: 'Position', name, x: widget.padX ?? 0.5, y: widget.padY ?? 0.5 },
                ],
              })
            }}
          >
            Guardar posición como preset
          </button>
          {(widget.padPresets?.length ?? 0) > 0 && (
            <button type="button" disabled={busy} onClick={() => apply({ padPresets: [] })}>
              Vaciar presets
            </button>
          )}
        </div>
      )}

      <ExternalInput widget={widget} busy={busy} onApply={apply} learning={learning} />

      <button
        type="button"
        className="danger"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          onDelete().finally(() => setBusy(false))
        }}
      >
        Eliminar widget
      </button>
    </aside>
  )
}

function FunctionPicker({
  label,
  options,
  value,
  onChange,
  disabled,
  empty,
}: {
  label: string
  options: FunctionState[]
  value: number | undefined
  onChange: (id: number | null) => void
  disabled: boolean
  empty?: string
}) {
  // The no-function sentinel is UINT_MAX in the file, and a widget that carries
  // it is unbound rather than pointing at function 4294967295.
  const bound = value !== undefined && value < 0xffffffff ? String(value) : ''

  if (empty) {
    return (
      <div className="field">
        <span>{label}</span>
        <em className="hint">{empty}</em>
      </div>
    )
  }

  return (
    <label className="field">
      <span>{label}</span>
      <select
        value={bound}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        disabled={disabled}
      >
        <option value="">(ninguna)</option>
        {options.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
    </label>
  )
}

/**
 * The channels a level fader drives.
 *
 * Channels are picked by name, not by number: "Dimmer" on a Hero Wash is
 * channel 6 in one mode and channel 8 in another, and an operator patching in
 * the dark should not have to remember which.
 */
function LevelChannels({
  channels,
  fixtures,
  onChange,
  disabled,
}: {
  channels: { fixture: number; channel: number }[]
  fixtures: FixtureState[]
  onChange: (channels: { fixture: number; channel: number }[]) => void
  disabled: boolean
}) {
  const [fixtureId, setFixtureId] = useState<number | null>(fixtures[0]?.id ?? null)
  const [detail, setDetail] = useState<FixtureDetail | null>(null)

  useEffect(() => {
    if (fixtureId === null) return
    let live = true
    api
      .fixture(fixtureId)
      .then((d) => live && setDetail(d))
      .catch(() => live && setDetail(null))
    return () => {
      live = false
    }
  }, [fixtureId])

  const nameOf = (id: number) => fixtures.find((f) => f.id === id)?.name ?? `#${id}`

  return (
    <div className="field">
      <span>Canales</span>

      {channels.length === 0 && <em className="hint">Ninguno: este fader no mueve nada.</em>}

      <ul className="channels">
        {channels.map((c) => (
          <li key={`${c.fixture}-${c.channel}`}>
            <span>
              {nameOf(c.fixture)} · canal {c.channel + 1}
            </span>
            <button
              type="button"
              aria-label="Quitar canal"
              disabled={disabled}
              onClick={() =>
                onChange(
                  channels.filter((x) => !(x.fixture === c.fixture && x.channel === c.channel)),
                )
              }
            >
              ✕
            </button>
          </li>
        ))}
      </ul>

      <div className="channel-add">
        <select
          value={fixtureId ?? ''}
          onChange={(e) => setFixtureId(e.target.value === '' ? null : Number(e.target.value))}
          disabled={disabled}
          aria-label="Fixture"
        >
          {fixtures.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>

        <select
          disabled={disabled || detail === null}
          value=""
          aria-label="Añadir canal"
          onChange={(e) => {
            if (e.target.value === '' || fixtureId === null) return
            const channel = Number(e.target.value)
            if (channels.some((c) => c.fixture === fixtureId && c.channel === channel)) return
            onChange([...channels, { fixture: fixtureId, channel }])
          }}
        >
          <option value="">Añadir canal…</option>
          {(detail?.channelList ?? []).map((c) => (
            <option key={c.index} value={c.index}>
              {c.index + 1}. {c.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}

function capitalise(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function secondsToTime(total: number) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`
}

function timeToSeconds(value: string) {
  const [h = '0', m = '0', s = '0'] = value.split(':')
  return Number(h) * 3600 + Number(m) * 60 + Number(s)
}

/**
 * How a widget looks.
 *
 * Cosmetic on a desk is not decoration: a colour bank where every button is
 * grey is a colour bank nobody can use in the dark, and the operator chose
 * those colours for a reason. The font travels back as the file holds it --
 * QFont::toString(), sixteen fields -- with only the family and size edited, so
 * the fourteen nobody touches survive.
 */
function Appearance({
  widget,
  busy,
  onApply,
}: {
  widget: VcWidget
  busy: boolean
  onApply: (patch: WidgetPatch) => Promise<void>
}) {
  const family = widget.fontFamily ?? ''
  const size = widget.fontSize ?? 12

  return (
    <details className="appearance">
      <summary>Apariencia</summary>

      <div className="fields">
        <label className="field">
          <span>Fondo</span>
          <input
            type="color"
            value={widget.background ?? '#1a1c22'}
            disabled={busy}
            onChange={(e) => onApply({ background: e.target.value })}
          />
        </label>

        <label className="field">
          <span>Texto</span>
          <input
            type="color"
            value={widget.foreground ?? '#f2f3f5'}
            disabled={busy}
            onChange={(e) => onApply({ foreground: e.target.value })}
          />
        </label>
      </div>

      <div className="fields">
        <label className="field grow-field">
          <span>Tipografía</span>
          <input
            defaultValue={family}
            placeholder="Por defecto"
            disabled={busy}
            onBlur={(e) => {
              const next = e.target.value.trim()
              if (next === family) return
              onApply({ font: next === '' ? null : `${next},${size}` })
            }}
          />
        </label>

        <label className="field">
          <span>Cuerpo</span>
          <input
            type="number"
            min={6}
            max={72}
            value={size}
            disabled={busy || family === ''}
            onChange={(e) => onApply({ font: `${family},${e.target.value}` })}
          />
        </label>
      </div>

      <label className="field">
        <span>Marco</span>
        <select
          value={widget.frameStyle ?? 'None'}
          disabled={busy}
          onChange={(e) => onApply({ frameStyle: e.target.value })}
        >
          <option value="None">Sin marco</option>
          <option value="Sunken">Hundido</option>
          <option value="Raised">Elevado</option>
        </select>
      </label>

      {/* Back to the desk's own colours, which is not the same as picking a
          grey that happens to match it: QLC+ writes "Default" and every theme
          then renders it in its own way. */}
      <button
        type="button"
        disabled={busy}
        onClick={() => onApply({ background: null, foreground: null, font: null })}
      >
        Volver a lo de por defecto
      </button>
    </details>
  )
}

/**
 * The clock's weekly agenda. Each line is a function, a start time, an
 * optional stop, and the days it applies to -- and the whole list travels to
 * the daemon at once, where the SCHEDULER lives: these fire with every
 * browser closed, which is the point of an alarm.
 */
function ClockAgenda({
  widget,
  functions,
  busy,
  onApply,
}: {
  widget: VcWidget
  functions: FunctionState[]
  busy: boolean
  onApply: (patch: WidgetPatch) => Promise<void>
}) {
  const DAYS = ['L', 'M', 'X', 'J', 'V', 'S', 'D']
  const schedules = widget.schedules ?? []
  const [draft, setDraft] = useState<{ function: number; start: string } | null>(null)

  const put = (next: { function: number; start: string; stop?: string; weekFlags: number }[]) =>
    onApply({ schedules: next })

  return (
    <div className="field">
      <span>Agenda ({schedules.length})</span>
      {schedules.length === 0 && (
        <p className="hint">Sin programaciones. Las que añadas suenan aunque no haya navegador.</p>
      )}

      <ul className="channels">
        {schedules.map((entry, index) => {
          const fn = functions.find((f) => f.id === entry.function)
          return (
            <li key={`${entry.function}-${entry.start}`} className="agenda-row">
              <span className="grow">
                {fn?.name ?? `#${entry.function}`} · {entry.start}
                {entry.stop !== undefined ? ` → ${entry.stop}` : ''}
              </span>
              <span className="agenda-days">
                {DAYS.map((day, bit) => (
                  <button
                    key={day}
                    type="button"
                    className="agenda-day"
                    aria-pressed={
                      (entry.weekFlags & 0x7f) === 0 || (entry.weekFlags & (1 << bit)) !== 0
                    }
                    title={(entry.weekFlags & 0x7f) === 0 ? 'Todos los días' : undefined}
                    disabled={busy}
                    onClick={() => {
                      const next = schedules.map((s, i) =>
                        i === index ? { ...s, weekFlags: s.weekFlags ^ (1 << bit) } : s,
                      )
                      put(next)
                    }}
                  >
                    {day}
                  </button>
                ))}
              </span>
              <button
                type="button"
                aria-label={`Quitar programación de ${entry.start}`}
                disabled={busy}
                onClick={() => put(schedules.filter((_, i) => i !== index))}
              >
                ✕
              </button>
            </li>
          )
        })}
      </ul>

      <div className="channel-add">
        <select
          value={draft?.function ?? ''}
          aria-label="Función a programar"
          disabled={busy}
          onChange={(e) =>
            setDraft(
              e.target.value === ''
                ? null
                : { function: Number(e.target.value), start: draft?.start ?? '20:00:00' },
            )
          }
        >
          <option value="">— función —</option>
          {functions.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        <input
          type="time"
          step={1}
          aria-label="Hora de inicio"
          value={draft?.start ?? '20:00:00'}
          disabled={busy || draft === null}
          onChange={(e) =>
            draft !== null && setDraft({ ...draft, start: `${e.target.value}:00`.slice(0, 8) })
          }
        />
        <button
          type="button"
          disabled={busy || draft === null}
          onClick={() => {
            if (draft === null) return
            put([...schedules, { ...draft, weekFlags: 0 }])
            setDraft(null)
          }}
        >
          Programar
        </button>
      </div>
    </div>
  )
}

/**
 * The external control bound to this widget: a MIDI note, an OSC message, a
 * fader on a wing.
 *
 * Learned by pressing the thing. Nobody knows that their fader is channel 47 of
 * input universe 1, and a form asking for two numbers is a form nobody can fill
 * in -- so the panel watches for the next control that moves and offers it.
 */
function ExternalInput({
  widget,
  busy,
  learning,
  onApply,
}: {
  widget: VcWidget
  busy: boolean
  learning: { universe: number; channel: number; value: number } | null
  onApply: (patch: WidgetPatch) => Promise<void>
}) {
  const [listening, setListening] = useState(false)
  const bound = widget.input

  /* Bind to whatever arrives while listening. Applied here rather than on a
     second press: the operator's hand is on the control, and asking them to
     come back to the screen to confirm is asking them to lose it. */
  useEffect(() => {
    if (!listening || learning === null) return
    setListening(false)
    onApply({ input: { universe: learning.universe, channel: learning.channel } })
  }, [listening, learning, onApply])

  return (
    <details className="external-input">
      <summary>Control externo</summary>

      {bound ? (
        <p className="hint">
          Universo de entrada {bound.universe}, canal {bound.channel}.
        </p>
      ) : (
        <p className="hint">Sin asignar.</p>
      )}

      <div className="fields">
        <button
          type="button"
          aria-pressed={listening}
          disabled={busy}
          onClick={() => setListening((on) => !on)}
        >
          {listening ? 'Esperando… mueve el control' : 'Aprender'}
        </button>

        <button
          type="button"
          disabled={busy || bound === undefined}
          onClick={() => onApply({ input: null })}
        >
          Quitar
        </button>
      </div>

      {bound && widget.type === 'button' && (
        <div className="fields">
          {/* What the control's LED gets in each state -- MIDI wings light
              their buttons from these two numbers. */}
          <label className="field">
            <span>LED apagado</span>
            <input
              type="number"
              min={0}
              max={255}
              defaultValue={bound.lower ?? 0}
              onBlur={(e) => {
                const raw = Number(e.target.value)
                onApply({
                  input: {
                    universe: bound.universe,
                    channel: bound.channel,
                    lower: Number.isNaN(raw) || raw === 0 ? null : Math.min(255, Math.max(0, raw)),
                  },
                })
              }}
            />
          </label>
          <label className="field">
            <span>LED encendido</span>
            <input
              type="number"
              min={0}
              max={255}
              defaultValue={bound.upper ?? 255}
              onBlur={(e) => {
                const raw = Number(e.target.value)
                onApply({
                  input: {
                    universe: bound.universe,
                    channel: bound.channel,
                    upper:
                      Number.isNaN(raw) || raw === 255 ? null : Math.min(255, Math.max(0, raw)),
                  },
                })
              }}
            />
          </label>
        </div>
      )}

      {/* An input universe with nothing patched into it never reports
          anything, and a button that waits forever looks broken rather than
          unpatched. */}
      {listening && (
        <p className="hint">
          Si no llega nada, comprueba que hay una entrada parcheada en Patch → Universos.
        </p>
      )}

      {widget.type === 'button' && <KeyBinding widget={widget} busy={busy} onApply={onApply} />}
    </details>
  )
}

/**
 * The controls that turn a frame's pages, learned by moving them -- the same
 * gesture as a widget's own binding, one learner per direction.
 */
function PageInputLearner({
  busy,
  learning,
  onApply,
}: {
  busy: boolean
  learning: { universe: number; channel: number; value: number } | null
  onApply: (patch: WidgetPatch) => Promise<void>
}) {
  const [listening, setListening] = useState<'next' | 'prev' | null>(null)

  useEffect(() => {
    if (listening === null || learning === null) return
    const direction = listening
    setListening(null)
    onApply({
      pageInputs: {
        [direction]: { universe: learning.universe, channel: learning.channel },
      },
    })
  }, [listening, learning, onApply])

  return (
    <>
      <button
        type="button"
        aria-pressed={listening === 'next'}
        disabled={busy}
        onClick={() => setListening(listening === 'next' ? null : 'next')}
      >
        {listening === 'next' ? 'Esperando…' : 'Aprender pasar página'}
      </button>
      <button
        type="button"
        aria-pressed={listening === 'prev'}
        disabled={busy}
        onClick={() => setListening(listening === 'prev' ? null : 'prev')}
      >
        {listening === 'prev' ? 'Esperando…' : 'Aprender página atrás'}
      </button>
    </>
  )
}

/**
 * The keyboard shortcut, captured rather than typed/**
 * The keyboard shortcut, captured rather than typed: press the key you mean.
 * Stored as QKeySequence text so the .qxw stays legible to QLC+ itself.
 */
function KeyBinding({
  widget,
  busy,
  onApply,
}: {
  widget: VcWidget
  busy: boolean
  onApply: (patch: WidgetPatch) => Promise<void>
}) {
  const [capturing, setCapturing] = useState(false)

  useEffect(() => {
    if (!capturing) return
    const grab = (event: KeyboardEvent) => {
      const sequence = keySequenceOf(event)
      if (sequence === null) return
      event.preventDefault()
      event.stopPropagation()
      setCapturing(false)
      onApply({ key: sequence })
    }
    /* Capture phase, so the app's own runtime bindings never see the press
       that was meant to DEFINE one. */
    window.addEventListener('keydown', grab, true)
    return () => window.removeEventListener('keydown', grab, true)
  }, [capturing, onApply])

  return (
    <div className="fields">
      <label className="field">
        <span>Tecla</span>
        <output>{widget.key ?? 'Sin asignar'}</output>
      </label>
      <button
        type="button"
        aria-pressed={capturing}
        disabled={busy}
        onClick={() => setCapturing((on) => !on)}
      >
        {capturing ? 'Pulsa la tecla…' : 'Capturar'}
      </button>
      <button
        type="button"
        disabled={busy || widget.key === undefined}
        onClick={() => onApply({ key: null })}
      >
        Quitar
      </button>
    </div>
  )
}
