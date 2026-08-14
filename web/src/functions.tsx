/**
 * Functions: the ten types, their timings, and their bodies.
 *
 * A console fires functions; this is where they come from. The list is grouped
 * by type because that is how an operator thinks about a show -- the scenes,
 * then the chases built out of them.
 *
 * Bodies are editable for the three shapes that are lists of things: a scene's
 * values, a chaser's steps, a collection's members. The rest can be created,
 * named, timed and deleted, and say so rather than showing an empty editor
 * that would read as "this function is empty".
 */

import { useCallback, useEffect, useState } from 'react'
import {
  type FixtureDetail,
  type FixtureState,
  type FunctionBody,
  type FunctionState,
  api,
} from './api'

/** The ten types the engine can create, in the order a show gets built. */
const TYPES = [
  { value: 'Scene', label: 'Escena' },
  { value: 'Chaser', label: 'Chaser' },
  { value: 'Sequence', label: 'Secuencia' },
  { value: 'EFX', label: 'EFX' },
  { value: 'Collection', label: 'Colección' },
  { value: 'RGBMatrix', label: 'RGB Matrix' },
  { value: 'Script', label: 'Script' },
  { value: 'Show', label: 'Show' },
  { value: 'Audio', label: 'Audio' },
  { value: 'Video', label: 'Vídeo' },
]

export function Functions({
  functions,
  fixtures,
  running,
  revision,
  onToggle,
  onChanged,
}: {
  functions: FunctionState[]
  fixtures: FixtureState[]
  running: Set<number>
  revision: number
  onToggle: (id: number) => void
  onChanged: () => void
}) {
  const [selected, setSelected] = useState<number | null>(null)
  const [type, setType] = useState('Scene')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setError(null)
      try {
        await action()
        onChanged()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        throw e
      }
    },
    [onChanged],
  )

  const byType = TYPES.map((t) => ({
    ...t,
    items: functions.filter((f) => f.type === t.value),
  })).filter((t) => t.items.length > 0)

  const current = functions.find((f) => f.id === selected) ?? null

  return (
    <section className="setup">
      {error && <p className="editor-error">{error}</p>}

      <div className="card">
        <div className="fields">
          <label className="field">
            <span>Tipo</span>
            <select value={type} onChange={(e) => setType(e.target.value)}>
              {TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field grow-field">
            <span>Nombre</span>
            <input
              value={name}
              placeholder="Nueva función"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        </div>
        <button
          type="button"
          disabled={name.trim() === ''}
          onClick={() =>
            run(() =>
              api.createFunction(type, name.trim()).then((created) => {
                setName('')
                setSelected(created.id)
              }),
            ).catch(() => undefined)
          }
        >
          Crear
        </button>
      </div>

      {functions.length === 0 && <p className="hint">Este proyecto no tiene funciones.</p>}

      {byType.map((group) => (
        <div key={group.value} className="stack">
          <h3 className="group-title">
            {group.label} ({group.items.length})
          </h3>
          <div className="table">
            {group.items.map((f) => (
              <div className="table-row" key={f.id} data-selected={f.id === selected}>
                <button
                  type="button"
                  className="grow linkish left"
                  onClick={() => setSelected(f.id === selected ? null : f.id)}
                >
                  {f.name}
                </button>
                <span className="hint">
                  {f.fadeIn ?? 0} / {f.duration ?? 0} ms
                </span>
                <button
                  type="button"
                  aria-pressed={running.has(f.id)}
                  data-running={running.has(f.id)}
                  onClick={() => onToggle(f.id)}
                >
                  {running.has(f.id) ? '⏹' : '▶'}
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}

      {current && (
        <FunctionEditor
          fn={current}
          functions={functions}
          fixtures={fixtures}
          revision={revision}
          onRun={run}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  )
}

function FunctionEditor({
  fn,
  functions,
  fixtures,
  revision,
  onRun,
  onClose,
}: {
  fn: FunctionState
  functions: FunctionState[]
  fixtures: FixtureState[]
  revision: number
  onRun: (action: () => Promise<unknown>) => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState(fn.name)
  const [body, setBody] = useState<FunctionBody | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the id on purpose
  useEffect(() => setName(fn.name), [fn.id])

  // The body is fetched separately from the function list, which carries only
  // name, type and timings -- a scene's values are far too much to broadcast
  // to every client on every change.
  const reloadBody = useCallback(() => {
    api
      .functionBody(fn.id)
      .then(setBody)
      .catch(() => setBody(null))
  }, [fn.id])

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadBody is keyed on fn.id
  useEffect(() => {
    reloadBody()
  }, [fn.id, revision])

  const apply = (action: () => Promise<unknown>) =>
    onRun(action)
      .then(reloadBody)
      .catch(() => undefined)

  return (
    <article className="card">
      <header>
        <strong>{fn.name}</strong>
        <span className="chip">
          {fn.type} · #{fn.id}
        </span>
        <span className="spacer" />
        <button type="button" onClick={onClose} aria-label="Cerrar">
          ✕
        </button>
      </header>

      <label className="field">
        <span>Nombre</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name !== fn.name && apply(() => api.patchFunction(fn.id, { name }))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && name !== fn.name)
              apply(() => api.patchFunction(fn.id, { name }))
          }}
        />
      </label>

      <div className="fields">
        {(['fadeIn', 'fadeOut', 'duration'] as const).map((key) => (
          <label className="field" key={key}>
            <span>
              {key === 'fadeIn' ? 'Entrada' : key === 'fadeOut' ? 'Salida' : 'Duración'} (ms)
            </span>
            <input
              type="number"
              min={0}
              defaultValue={fn[key] ?? 0}
              onBlur={(e) => {
                const value = Number(e.target.value)
                if (value !== (fn[key] ?? 0))
                  apply(() => api.patchFunction(fn.id, { [key]: value }))
              }}
            />
          </label>
        ))}
      </div>

      {body?.type === 'Scene' && (
        <SceneValues fn={fn} body={body} fixtures={fixtures} onApply={apply} />
      )}
      {body?.type === 'Chaser' && (
        <ChaserSteps fn={fn} body={body} functions={functions} onApply={apply} />
      )}
      {body?.type === 'Collection' && (
        <Members fn={fn} body={body} functions={functions} onApply={apply} />
      )}
      {body?.note && <p className="hint">{body.note}</p>}

      <button
        type="button"
        className="danger"
        onClick={() => {
          /* The engine refuses while something still points at this function,
             and names what. Asking is better than a force that silently leaves
             chaser steps aiming at nothing. */
          onRun(() => api.removeFunction(fn.id))
            .then(onClose)
            .catch((e) => {
              const reason = e instanceof Error ? e.message : String(e)
              if (confirm(`${reason}\n\n¿Borrarla de todos modos?`)) {
                onRun(() => api.removeFunction(fn.id, true))
                  .then(onClose)
                  .catch(() => undefined)
              }
            })
        }}
      >
        Eliminar función
      </button>
    </article>
  )
}

/** A scene is fixture channels held at values. */
function SceneValues({
  fn,
  body,
  fixtures,
  onApply,
}: {
  fn: FunctionState
  body: FunctionBody
  fixtures: FixtureState[]
  onApply: (action: () => Promise<unknown>) => Promise<void>
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

  const values = body.values ?? []

  return (
    <div className="field">
      <span>Valores ({values.length})</span>

      {values.length === 0 && <p className="hint">Esta escena no mueve ningún canal.</p>}

      <ul className="channels">
        {values.map((value) => (
          <li key={`${value.fixture}-${value.channel}`}>
            <span>
              {value.fixtureName ?? `#${value.fixture}`} ·{' '}
              {value.channelName ?? `canal ${value.channel + 1}`}
            </span>
            <input
              type="range"
              min={0}
              max={255}
              defaultValue={value.value}
              aria-label={`${value.fixtureName} ${value.channelName}`}
              onPointerUp={(e) =>
                onApply(() =>
                  api.setSceneValue(
                    fn.id,
                    value.fixture,
                    value.channel,
                    Number((e.target as HTMLInputElement).value),
                  ),
                )
              }
            />
            <span className="cue-time">{value.value}</span>
          </li>
        ))}
      </ul>

      <div className="channel-add">
        <select
          value={fixtureId ?? ''}
          aria-label="Fixture"
          onChange={(e) => setFixtureId(e.target.value === '' ? null : Number(e.target.value))}
        >
          {fixtures.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        <select
          value=""
          aria-label="Añadir canal"
          disabled={detail === null}
          onChange={(e) => {
            if (e.target.value === '' || fixtureId === null) return
            onApply(() => api.setSceneValue(fn.id, fixtureId, Number(e.target.value), 255))
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

/** A chaser is an ordered list of functions with times. */
function ChaserSteps({
  fn,
  body,
  functions,
  onApply,
}: {
  fn: FunctionState
  body: FunctionBody
  functions: FunctionState[]
  onApply: (action: () => Promise<unknown>) => Promise<void>
}) {
  const steps = body.steps ?? []

  // A chaser that steps through itself is a loop the engine refuses, and
  // offering it here would only produce that refusal.
  const candidates = functions.filter((f) => f.id !== fn.id)

  return (
    <div className="field">
      <span>Pasos ({steps.length})</span>

      {steps.length === 0 && <p className="hint">Este chaser no tiene pasos.</p>}

      <ul className="channels">
        {steps.map((step) => (
          <li key={step.index}>
            <span>
              {step.index + 1}. {step.name}
            </span>
            <span className="cue-time">
              {step.fadeIn} / {step.hold} ms
            </span>
            <button
              type="button"
              aria-label={`Quitar paso ${step.index + 1}`}
              onClick={() => onApply(() => api.removeChaserStep(fn.id, step.index))}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>

      <div className="channel-add">
        <select
          value=""
          aria-label="Añadir paso"
          onChange={(e) => {
            if (e.target.value === '') return
            onApply(() =>
              api.addChaserStep(fn.id, { function: Number(e.target.value), hold: 1000 }),
            )
          }}
        >
          <option value="">Añadir paso…</option>
          {candidates.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}

/** A collection fires its members together. */
function Members({
  fn,
  body,
  functions,
  onApply,
}: {
  fn: FunctionState
  body: FunctionBody
  functions: FunctionState[]
  onApply: (action: () => Promise<unknown>) => Promise<void>
}) {
  const members = body.members ?? []
  const ids = members.map((m) => m.function)
  const candidates = functions.filter((f) => f.id !== fn.id && !ids.includes(f.id))

  return (
    <div className="field">
      <span>Miembros ({members.length})</span>

      {members.length === 0 && <p className="hint">Esta colección está vacía.</p>}

      <ul className="channels">
        {members.map((member) => (
          <li key={member.function}>
            <span>{member.name}</span>
            <button
              type="button"
              aria-label={`Quitar ${member.name}`}
              onClick={() =>
                onApply(() =>
                  api.setMembers(
                    fn.id,
                    ids.filter((id) => id !== member.function),
                  ),
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
          value=""
          aria-label="Añadir miembro"
          onChange={(e) => {
            if (e.target.value === '') return
            onApply(() => api.setMembers(fn.id, [...ids, Number(e.target.value)]))
          }}
        >
          <option value="">Añadir función…</option>
          {candidates.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}
