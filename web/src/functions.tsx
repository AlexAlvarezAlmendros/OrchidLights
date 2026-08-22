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
  type AudioDevices,
  type FixtureDetail,
  type FixtureState,
  type FunctionBody,
  type FunctionState,
  type FunctionUsage,
  api,
} from './api'
import { Palettes } from './paletas'
import { ShowTimeline } from './show'
import { Slider } from './slider'

/** The seven EFX patterns the engine has. Fixed, unlike the RGB algorithms,
 *  which are scripts and are asked for at runtime. */
const EFX_ALGORITHMS = ['Circle', 'Eight', 'Line', 'Diamond', 'Square', 'SquareChoppy', 'Leaf']

const GEOMETRY_LABELS: Record<string, string> = {
  width: 'Ancho',
  height: 'Alto',
  xOffset: 'Centro X',
  yOffset: 'Centro Y',
  rotation: 'Rotación',
}

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
  shows,
  revision,
  onToggle,
  onChanged,
}: {
  functions: FunctionState[]
  fixtures: FixtureState[]
  running: Set<number>
  /** Where each running show has got to, by function id. The daemon's clock,
   *  not ours: a local timer drifts and keeps going after the show ends. */
  shows: Record<number, number>
  revision: number
  onToggle: (id: number) => void
  onChanged: () => void
}) {
  const [selected, setSelected] = useState<number | null>(null)
  const [type, setType] = useState('Scene')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [selecting, setSelecting] = useState(false)
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [batchName, setBatchName] = useState('')

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

  const wanted = search.trim().toLowerCase()
  const visible = functions.filter(
    (f) =>
      (typeFilter === '' || f.type === typeFilter) &&
      (wanted === '' || f.name.toLowerCase().includes(wanted)),
  )

  /* Type, then folder: the tree QLC+ 5 draws, flattened into headings. A
     folder is just the function's `path`; the root sorts first. */
  const byType = TYPES.map((t) => {
    const items = visible.filter((f) => f.type === t.value)
    const folders = [...new Set(items.map((f) => f.path ?? ''))].sort((a, b) => a.localeCompare(b))
    return {
      ...t,
      items,
      folders: folders.map((folder) => ({
        folder,
        items: items.filter((f) => (f.path ?? '') === folder),
      })),
    }
  }).filter((t) => t.items.length > 0)

  const current = functions.find((f) => f.id === selected) ?? null

  return (
    <section className="setup">
      {error && <p className="editor-error">{error}</p>}

      <div className="fields">
        <label className="field grow-field">
          <span>Buscar</span>
          <input
            value={search}
            placeholder="Nombre de función"
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Filtrar</span>
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="">Todas</option>
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          aria-pressed={selecting}
          onClick={() => {
            setSelecting((on) => !on)
            setChecked(new Set())
          }}
        >
          Selección
        </button>
      </div>

      {selecting && (
        <div className="fields batch-bar">
          <span className="chip num">{checked.size} elegidas</span>
          <label className="field grow-field">
            <span>Nombre base / carpeta</span>
            <input
              value={batchName}
              placeholder="Tema o Bolo/Sábado"
              onChange={(e) => setBatchName(e.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={checked.size === 0 || batchName.trim() === ''}
            title="«Tema» sobre 3 funciones da Tema 1, Tema 2, Tema 3"
            onClick={() => {
              const base = batchName.trim()
              const ids = functions.filter((f) => checked.has(f.id)).map((f) => f.id)
              run(async () => {
                let ordinal = 1
                for (const id of ids) {
                  await api.patchFunction(id, { name: `${base} ${ordinal}` })
                  ordinal++
                }
              }).catch(() => undefined)
            }}
          >
            Renombrar numerando
          </button>
          <button
            type="button"
            disabled={checked.size === 0}
            title="Crea un botón en la consola por cada función elegida, en un marco nuevo"
            onClick={() => {
              const ids = functions.filter((f) => checked.has(f.id)).map((f) => f.id)
              run(async () => {
                const frame = await api.addWidget({
                  type: 'frame',
                  caption: batchName.trim() || 'Botonera',
                  geometry: { x: 0, y: 0, width: 460, height: 220 },
                })
                let column = 0
                for (const id of ids) {
                  const fn = functions.find((f) => f.id === id)
                  await api.addWidget({
                    type: 'button',
                    parent: Number(frame.id),
                    caption: fn?.name ?? `#${id}`,
                    functionId: id,
                    geometry: {
                      x: (column % 4) * 110,
                      y: Math.floor(column / 4) * 70,
                      width: 100,
                      height: 60,
                    },
                  })
                  column++
                }
              }).catch(() => undefined)
            }}
          >
            Crear botonera
          </button>
          <button
            type="button"
            disabled={checked.size === 0}
            title="Mueve las elegidas a esa carpeta; vacío las saca a la raíz"
            onClick={() => {
              const folder = batchName.trim()
              const ids = [...checked]
              run(async () => {
                for (const id of ids) await api.patchFunction(id, { path: folder })
              }).catch(() => undefined)
            }}
          >
            Mover a carpeta
          </button>
        </div>
      )}

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

      <Palettes fixtures={fixtures} onError={setError} />

      {functions.length === 0 && <p className="hint">Este proyecto no tiene funciones.</p>}

      {byType.map((group) => (
        <div key={group.value} className="stack">
          <h3 className="group-title">
            {group.label} ({group.items.length})
          </h3>
          {group.folders.map(({ folder, items }) => (
            <div key={folder || '(raíz)'} className="stack">
              {folder !== '' && <h4 className="folder-title">📁 {folder}</h4>}
              <div className="table">
                {items.map((f) => (
                  <div className="table-row" key={f.id} data-selected={f.id === selected}>
                    {selecting && (
                      <input
                        type="checkbox"
                        aria-label={`Elegir ${f.name}`}
                        checked={checked.has(f.id)}
                        onChange={(e) =>
                          setChecked((current) => {
                            const next = new Set(current)
                            if (e.target.checked) next.add(f.id)
                            else next.delete(f.id)
                            return next
                          })
                        }
                      />
                    )}
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
        </div>
      ))}

      {visible.length === 0 && functions.length > 0 && (
        <p className="hint">Nada responde a ese filtro.</p>
      )}

      {current && (
        <FunctionEditor
          fn={current}
          functions={functions}
          fixtures={fixtures}
          revision={revision}
          elapsed={shows[current.id]}
          running={running.has(current.id)}
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
  elapsed,
  running,
  onRun,
  onClose,
}: {
  fn: FunctionState
  functions: FunctionState[]
  fixtures: FixtureState[]
  revision: number
  elapsed: number | undefined
  running: boolean
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

      <div className="fields">
        <label className="field grow-field">
          <span>Carpeta</span>
          <input
            defaultValue={fn.path ?? ''}
            placeholder="(raíz) — o Bolo/Sábado"
            onBlur={(e) => {
              const folder = e.target.value.trim()
              if (folder !== (fn.path ?? ''))
                apply(() => api.patchFunction(fn.id, { path: folder }))
            }}
          />
        </label>
        <label className="field">
          <span>Orden</span>
          <select
            value={fn.runOrder ?? 'loop'}
            onChange={(e) => apply(() => api.patchFunction(fn.id, { runOrder: e.target.value }))}
          >
            <option value="loop">Bucle</option>
            <option value="singleshot">Una vez</option>
            <option value="pingpong">Ping-pong</option>
            <option value="random">Aleatorio</option>
          </select>
        </label>
        <label className="field">
          <span>Dirección</span>
          <select
            value={fn.direction ?? 'forward'}
            onChange={(e) => apply(() => api.patchFunction(fn.id, { direction: e.target.value }))}
          >
            <option value="forward">Adelante</option>
            <option value="backward">Atrás</option>
          </select>
        </label>
        <label className="field">
          <span>Tempo</span>
          <select
            value={fn.tempoType ?? 'time'}
            onChange={(e) => apply(() => api.patchFunction(fn.id, { tempoType: e.target.value }))}
          >
            <option value="time">Tiempo (ms)</option>
            <option value="beats">Beats</option>
          </select>
        </label>
      </div>

      <Organization fn={fn} onApply={apply} />

      {body?.type === 'Scene' && (
        <>
          <SceneValues fn={fn} body={body} fixtures={fixtures} onApply={apply} />
          <ScenePalettes fn={fn} body={body} fixtures={fixtures} onApply={apply} />
          <ChannelTools fn={fn} body={body} fixtures={fixtures} onApply={apply} />
        </>
      )}
      {body?.type === 'Chaser' && (
        <ChaserSteps fn={fn} body={body} functions={functions} onApply={apply} />
      )}
      {body?.type === 'EFX' && <EfxBody fn={fn} body={body} fixtures={fixtures} onApply={apply} />}
      {body?.type === 'RGBMatrix' && <MatrixBody fn={fn} body={body} onApply={apply} />}
      {body?.type === 'Script' && <ScriptBody fn={fn} body={body} onApply={apply} />}
      {body?.type === 'Audio' && (
        <>
          <TextBody
            label="Archivo"
            value={body.source ?? ''}
            placeholder="/ruta/al/audio.wav"
            onApply={(source) => apply(() => api.setBody(fn.id, { source }))}
          />
          <label className="field">
            <span>Volumen</span>
            <Slider
              min={0}
              max={100}
              defaultValue={Math.round((body.volume ?? 1) * 100)}
              onPointerUp={(e) =>
                apply(() =>
                  api.setBody(fn.id, {
                    volume: Number((e.target as HTMLInputElement).value) / 100,
                  }),
                )
              }
            />
          </label>
          <AudioOutput fn={fn} body={body} onApply={apply} />
          <Waveform fn={fn} source={body.source ?? ''} />
        </>
      )}
      {body?.type === 'Video' && (
        <TextBody
          label="Archivo o URL"
          value={body.source ?? ''}
          placeholder="/ruta/al/video.mp4"
          onApply={(source) => apply(() => api.setBody(fn.id, { source }))}
        />
      )}
      {body?.type === 'Sequence' && (
        <SequenceSteps fn={fn} body={body} fixtures={fixtures} onApply={apply} />
      )}
      {body?.type === 'Collection' && (
        <Members fn={fn} body={body} functions={functions} onApply={apply} />
      )}
      {body?.type === 'Show' && (
        <ShowTimeline
          fn={fn}
          body={body}
          functions={functions}
          elapsed={elapsed}
          running={running}
          onRun={onRun}
          onReload={reloadBody}
        />
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

/**
 * A body that is one piece of text: a script's program, a media file's path.
 *
 * Committed on leaving the field rather than on every keystroke -- a script is
 * parsed by the engine on the way in, and validating half a line on each
 * character would report errors that are only true for a moment.
 */
function TextBody({
  label,
  value,
  rows,
  placeholder,
  onApply,
}: {
  label: string
  value: string
  rows?: number
  placeholder?: string
  onApply: (value: string) => void
}) {
  const [draft, setDraft] = useState(value)

  /* The box holds a draft until it is committed, so it has to be resynced when
     the value behind it changes: somebody else editing the same function, or
     this one being pointed at another.
   *
     No suppression here, unlike the effects that deliberately leave a
     dependency out -- `value` is the only one, and a comment claiming to
     silence a rule that never fires is a comment that stops meaning anything. */
  useEffect(() => setDraft(value), [value])

  const commit = () => draft !== value && onApply(draft)

  if (rows) {
    return (
      <label className="field">
        <span>{label}</span>
        <textarea
          rows={rows}
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
        />
      </label>
    )
  }

  return (
    <label className="field">
      <span>{label}</span>
      <input
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
      />
    </label>
  )
}

/** An EFX is a pattern, its geometry, and the heads that follow it. */
function EfxBody({
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
  const heads = body.heads ?? []
  const ids = body.fixtures ?? []

  const setGeometry = (key: string, value: number) =>
    onApply(() => api.setBody(fn.id, { geometry: { ...body.geometry, [key]: value } }))

  return (
    <>
      <label className="field">
        <span>Patrón</span>
        <select
          value={body.algorithm ?? ''}
          onChange={(e) => onApply(() => api.setBody(fn.id, { algorithm: e.target.value }))}
        >
          {EFX_ALGORITHMS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </label>

      <div className="fields">
        {(['width', 'height', 'xOffset', 'yOffset', 'rotation'] as const).map((key) => (
          <label className="field" key={key}>
            <span>{GEOMETRY_LABELS[key]}</span>
            <input
              type="number"
              min={0}
              max={key === 'rotation' ? 359 : 255}
              defaultValue={body.geometry?.[key] ?? 0}
              onBlur={(e) => {
                const value = Number(e.target.value)
                if (value !== (body.geometry?.[key] ?? 0)) setGeometry(key, value)
              }}
            />
          </label>
        ))}
      </div>

      <label className="field">
        <span>Propagación</span>
        <select
          value={body.propagation ?? 'Parallel'}
          onChange={(e) => onApply(() => api.setBody(fn.id, { propagation: e.target.value }))}
        >
          <option value="Parallel">Paralela (todas a la vez)</option>
          <option value="Serial">Serie (una tras otra)</option>
          <option value="Asymmetric">Asimétrica</option>
        </select>
      </label>

      <div className="field">
        <span>Cabezas ({heads.length})</span>
        {heads.length === 0 && <p className="hint">Este EFX no mueve ninguna cabeza.</p>}

        {heads.length > 1 && (
          <div className="fields">
            {/* Mass offsets: the wave in one press. Spread walks the circle
                in equal strides; random deals it. Either way the daemon gets
                the RESULT, so the file keeps what the operator saw. */}
            <button
              type="button"
              onClick={() =>
                onApply(() =>
                  api.setBody(fn.id, {
                    offsets: heads.map((head, index) => ({
                      fixture: head.fixture,
                      head: head.head,
                      offset: Math.round((index * 360) / heads.length) % 360,
                    })),
                  }),
                )
              }
            >
              Repartir offsets
            </button>
            <button
              type="button"
              onClick={() =>
                onApply(() =>
                  api.setBody(fn.id, {
                    offsets: heads.map((head) => ({
                      fixture: head.fixture,
                      head: head.head,
                      offset: Math.floor(Math.random() * 360),
                    })),
                  }),
                )
              }
            >
              Offsets aleatorios
            </button>
          </div>
        )}

        <ul className="channels">
          {heads.map((head) => (
            <li key={`${head.fixture}-${head.head}`}>
              <span className="grow">{head.name}</span>
              <input
                type="number"
                min={0}
                max={359}
                className="step-time num"
                title="Offset (grados)"
                aria-label={`Offset de ${head.name}`}
                defaultValue={head.offset ?? 0}
                onBlur={(e) => {
                  const offset = Number(e.target.value)
                  if (offset !== (head.offset ?? 0))
                    onApply(() =>
                      api.setBody(fn.id, {
                        offsets: [{ fixture: head.fixture, head: head.head, offset }],
                      }),
                    )
                }}
              />
              <label className="field row-field">
                <input
                  type="checkbox"
                  checked={head.reverse ?? false}
                  onChange={(e) =>
                    onApply(() =>
                      api.setBody(fn.id, {
                        offsets: [
                          { fixture: head.fixture, head: head.head, reverse: e.target.checked },
                        ],
                      }),
                    )
                  }
                />
                <span>inversa</span>
              </label>
              <select
                value={head.mode ?? 'Position'}
                aria-label={`Modo de ${head.name}`}
                onChange={(e) =>
                  onApply(() =>
                    api.setBody(fn.id, {
                      offsets: [{ fixture: head.fixture, head: head.head, mode: e.target.value }],
                    }),
                  )
                }
              >
                <option value="Position">Posición</option>
                <option value="Dimmer">Dimmer</option>
                <option value="RGB">RGB</option>
              </select>
              <button
                type="button"
                aria-label={`Quitar ${head.name}`}
                onClick={() =>
                  onApply(() =>
                    api.setBody(fn.id, { fixtures: ids.filter((id) => id !== head.fixture) }),
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
            aria-label="Añadir cabeza"
            onChange={(e) => {
              if (e.target.value === '') return
              onApply(() => api.setBody(fn.id, { fixtures: [...ids, Number(e.target.value)] }))
            }}
          >
            <option value="">Añadir fixture…</option>
            {fixtures
              .filter((f) => !ids.includes(f.id))
              .map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
          </select>
        </div>
        {/* Changing the set stops the function first: EFX walks its fixture
            list on the timer thread every 20 ms, so editing it live is a
            use-after-free. Both desktop editors stop before touching it. */}
        <p className="hint">Cambiar las cabezas para el efecto antes de tocarlas.</p>
      </div>
    </>
  )
}

/** An RGB matrix runs an algorithm across a fixture group. */
function MatrixBody({
  fn,
  body,
  onApply,
}: {
  fn: FunctionState
  body: FunctionBody
  onApply: (action: () => Promise<unknown>) => Promise<void>
}) {
  const [algorithms, setAlgorithms] = useState<string[]>([])
  const [groups, setGroups] = useState<{ id: number; name: string }[]>([])

  useEffect(() => {
    api
      .algorithms()
      .then((r) => setAlgorithms(r.algorithms))
      .catch(() => setAlgorithms([]))
    api
      .groups()
      .then(setGroups)
      .catch(() => setGroups([]))
  }, [])

  const colors = body.colors ?? []

  return (
    <>
      <label className="field">
        <span>Algoritmo ({algorithms.length})</span>
        <select
          value={body.algorithm ?? ''}
          onChange={(e) => onApply(() => api.setBody(fn.id, { algorithm: e.target.value }))}
        >
          <option value="">(ninguno)</option>
          {algorithms.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>Grupo</span>
        <select
          value={body.fixtureGroup ?? ''}
          onChange={(e) =>
            onApply(() => api.setBody(fn.id, { fixtureGroup: Number(e.target.value) }))
          }
        >
          <option value="">(ninguno — esta matriz no emite nada)</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </label>

      {/* How many colours the algorithm takes is the algorithm's business, so
          the pickers follow it rather than a fixed number. */}
      {colors.length > 0 && (
        <div className="fields">
          {colors.map((colour, index) => (
            // The position is the identity: an algorithm takes a fixed number
            // of colours, in order.
            // biome-ignore lint/suspicious/noArrayIndexKey: the index is the slot
            <label className="field" key={`color-${index}`}>
              <span>Color {index + 1}</span>
              <input
                type="color"
                defaultValue={colour || '#ffffff'}
                onBlur={(e) => {
                  const next = [...colors]
                  next[index] = e.target.value
                  onApply(() => api.setBody(fn.id, { colors: next }))
                }}
              />
            </label>
          ))}
        </div>
      )}

      <div className="fields">
        <label className="field">
          <span>Mezcla</span>
          <select
            value={body.blendMode ?? 'Normal'}
            onChange={(e) => onApply(() => api.setBody(fn.id, { blendMode: e.target.value }))}
          >
            <option value="Normal">Normal</option>
            <option value="Mask">Máscara</option>
            <option value="Additive">Aditiva</option>
            <option value="Subtractive">Sustractiva</option>
          </select>
        </label>
        <label className="field">
          <span>Controla</span>
          <select
            value={body.controlMode ?? 'RGB'}
            onChange={(e) => onApply(() => api.setBody(fn.id, { controlMode: e.target.value }))}
          >
            <option value="RGB">Color (RGB)</option>
            <option value="White">Blanco</option>
            <option value="Amber">Ámbar</option>
            <option value="UV">UV</option>
            <option value="Dimmer">Dimmer</option>
            <option value="Shutter">Shutter</option>
          </select>
        </label>
        <span className="spacer" />
        <button
          type="button"
          title="Congela la matriz en una escena + secuencia con los píxeles pintados"
          onClick={() => onApply(() => api.bakeMatrix(fn.id))}
        >
          Congelar en secuencia
        </button>
      </div>

      {body.text !== undefined && (
        <div className="fields">
          <label className="field grow-field">
            <span>Texto</span>
            <input
              defaultValue={body.text.content}
              onBlur={(e) =>
                onApply(() => api.setBody(fn.id, { text: { content: e.target.value } }))
              }
            />
          </label>
          <label className="field">
            <span>Animación</span>
            <select
              value={body.text.animation}
              onChange={(e) =>
                onApply(() => api.setBody(fn.id, { text: { animation: e.target.value } }))
              }
            >
              {(body.animations ?? []).map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {body.image !== undefined && (
        <div className="fields">
          <label className="field grow-field">
            <span>Imagen {body.image.file === '' ? '(ninguna)' : `· ${body.image.file}`}</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/gif,image/bmp,image/webp"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file === undefined) return
                onApply(async () => {
                  const uploaded = await api.uploadAsset(file)
                  await api.setBody(fn.id, { image: { file: uploaded.path } })
                })
              }}
            />
          </label>
          <label className="field">
            <span>Animación</span>
            <select
              value={body.image.animation}
              onChange={(e) =>
                onApply(() => api.setBody(fn.id, { image: { animation: e.target.value } }))
              }
            >
              {(body.animations ?? []).map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {(body.properties ?? []).length > 0 && (
        <div className="fields">
          {(body.properties ?? []).map((property) => (
            <div className="field" key={property.name}>
              <span>{property.label || property.name}</span>
              {property.type === 'list' ? (
                <select
                  value={property.value}
                  aria-label={property.label || property.name}
                  onChange={(e) =>
                    onApply(() =>
                      api.setBody(fn.id, { properties: { [property.name]: e.target.value } }),
                    )
                  }
                >
                  {(property.values ?? []).map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type={property.type === 'range' ? 'number' : 'text'}
                  aria-label={property.label || property.name}
                  min={property.min}
                  max={property.max}
                  defaultValue={property.value}
                  onBlur={(e) =>
                    onApply(() =>
                      api.setBody(fn.id, { properties: { [property.name]: e.target.value } }),
                    )
                  }
                />
              )}
            </div>
          ))}
        </div>
      )}
    </>
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
            <Slider
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

/**
 * A chaser is an ordered list of functions with times -- and every column the
 * reference editor has: per-step fades, hold, the note, the modes that decide
 * whether the chaser listens to them, reordering and a shuffle whose result
 * is a permutation the daemon persists exactly.
 */
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

  const move = (from: number, to: number) => {
    if (to < 0 || to >= steps.length) return
    const order = steps.map((_, i) => i)
    order[from] = to
    order[to] = from
    onApply(() => api.setStepsOrder(fn.id, order))
  }

  const shuffle = () => {
    /* Fisher-Yates over indices; the daemon receives the RESULT, so what the
       file keeps is exactly what the operator saw happen. */
    const order = steps.map((_, i) => i)
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[order[i], order[j]] = [order[j] as number, order[i] as number]
    }
    onApply(() => api.setStepsOrder(fn.id, order))
  }

  const mode = (key: 'fadeInMode' | 'fadeOutMode' | 'durationMode') => (
    <label className="field" key={key}>
      <span>
        {key === 'fadeInMode' ? 'Entrada' : key === 'fadeOutMode' ? 'Salida' : 'Duración'}
      </span>
      <select
        value={body[key] ?? 'common'}
        onChange={(e) => onApply(() => api.patchFunction(fn.id, { [key]: e.target.value }))}
      >
        <option value="common">Común</option>
        <option value="perstep">Por paso</option>
        {key === 'durationMode' && <option value="default">Por defecto</option>}
      </select>
    </label>
  )

  const perStepSpeeds = body.fadeInMode === 'perstep' || body.durationMode === 'perstep'

  return (
    <div className="field">
      <span>Pasos ({steps.length})</span>

      <div className="fields">
        {mode('fadeInMode')}
        {mode('fadeOutMode')}
        {mode('durationMode')}
        <span className="spacer" />
        <button type="button" disabled={steps.length < 2} onClick={shuffle}>
          Barajar
        </button>
      </div>

      {steps.length === 0 && <p className="hint">Este chaser no tiene pasos.</p>}

      <ul className="channels chaser-steps">
        {steps.map((step) => (
          <li key={step.index}>
            <span className="num">{step.index + 1}.</span>
            <span className="grow">{step.name}</span>
            <input
              className="step-note"
              defaultValue={step.note ?? ''}
              placeholder="nota"
              aria-label={`Nota del paso ${step.index + 1}`}
              onBlur={(e) => {
                const note = e.target.value.trim()
                if (note !== (step.note ?? ''))
                  onApply(() => api.patchChaserStep(fn.id, step.index, { note }))
              }}
            />
            {perStepSpeeds &&
              (['fadeIn', 'hold', 'fadeOut'] as const).map((key) => (
                <input
                  key={key}
                  type="number"
                  min={0}
                  className="step-time num"
                  defaultValue={step[key]}
                  title={
                    key === 'fadeIn'
                      ? 'Entrada (ms)'
                      : key === 'hold'
                        ? 'Espera (ms)'
                        : 'Salida (ms)'
                  }
                  aria-label={`${key} del paso ${step.index + 1}`}
                  onBlur={(e) => {
                    const value = Number(e.target.value)
                    if (value !== step[key])
                      onApply(() => api.patchChaserStep(fn.id, step.index, { [key]: value }))
                  }}
                />
              ))}
            <button
              type="button"
              disabled={step.index === 0}
              aria-label={`Subir paso ${step.index + 1}`}
              onClick={() => move(step.index, step.index - 1)}
            >
              ↑
            </button>
            <button
              type="button"
              disabled={step.index === steps.length - 1}
              aria-label={`Bajar paso ${step.index + 1}`}
              onClick={() => move(step.index, step.index + 1)}
            >
              ↓
            </button>
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

/**
 * A sequence for real: the same scene, one set of values per step. Each step
 * is added over the bound scene and edited channel by channel -- and the
 * values edited here are what the next run plays, which the smoke test reads
 * off the wire.
 */
function SequenceSteps({
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
  const steps = body.steps ?? []
  const [open, setOpen] = useState<number | null>(null)
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

  return (
    <div className="field">
      <span>
        Vinculada a <strong>{body.sceneName}</strong> · {steps.length} pasos
      </span>

      {steps.length === 0 && <p className="hint">Esta secuencia no tiene pasos todavía.</p>}

      <ul className="channels">
        {steps.map((step) => (
          <li key={step.index} className="sequence-step">
            <div className="sequence-step-row">
              <button
                type="button"
                className="linkish"
                aria-expanded={open === step.index}
                onClick={() => setOpen(open === step.index ? null : step.index)}
              >
                {step.index + 1}. {step.name} · {(step.values ?? []).length} valores
              </button>
              <span className="spacer" />
              <button
                type="button"
                aria-label={`Quitar paso ${step.index + 1}`}
                onClick={() => onApply(() => api.removeChaserStep(fn.id, step.index))}
              >
                ✕
              </button>
            </div>

            {open === step.index && (
              <div className="sequence-values">
                {(step.values ?? []).map((value) => (
                  <div key={`${value.fixture}-${value.channel}`} className="sequence-value">
                    <span>
                      #{value.fixture} · canal {value.channel + 1}
                    </span>
                    <Slider
                      min={0}
                      max={255}
                      defaultValue={value.value}
                      aria-label={`Valor del canal ${value.channel + 1}`}
                      onPointerUp={(e) =>
                        onApply(() =>
                          api.setSequenceStepValues(fn.id, step.index, [
                            {
                              fixture: value.fixture,
                              channel: value.channel,
                              value: Number((e.target as HTMLInputElement).value),
                            },
                          ]),
                        )
                      }
                    />
                    <span className="cue-time num">{value.value}</span>
                  </div>
                ))}

                <div className="channel-add">
                  <select
                    value={fixtureId ?? ''}
                    aria-label="Fixture"
                    onChange={(e) =>
                      setFixtureId(e.target.value === '' ? null : Number(e.target.value))
                    }
                  >
                    {fixtures.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                  <select
                    value=""
                    aria-label="Añadir canal al paso"
                    disabled={detail === null}
                    onChange={(e) => {
                      if (e.target.value === '' || fixtureId === null) return
                      onApply(() =>
                        api.setSequenceStepValues(fn.id, step.index, [
                          { fixture: fixtureId, channel: Number(e.target.value), value: 255 },
                        ]),
                      )
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
            )}
          </li>
        ))}
      </ul>

      {body.scene !== undefined && (
        <button
          type="button"
          onClick={() =>
            onApply(() => api.addChaserStep(fn.id, { function: body.scene as number }))
          }
        >
          + Añadir paso
        </button>
      )}
    </div>
  )
}

/**
 * Clone, usage and the autostart -- the function's place in the project, as
 * opposed to what it does.
 */
function Organization({
  fn,
  onApply,
}: {
  fn: FunctionState
  onApply: (action: () => Promise<unknown>) => Promise<void>
}) {
  const [usage, setUsage] = useState<FunctionUsage | null>(null)
  const [startup, setStartup] = useState<boolean | null>(null)

  useEffect(() => {
    setUsage(null)
    api
      .project()
      .then((p) => setStartup(p.startupFunction === fn.id))
      .catch(() => setStartup(null))
  }, [fn.id])

  return (
    <div className="fields organization">
      <button type="button" onClick={() => onApply(() => api.cloneFunction(fn.id))}>
        Clonar
      </button>

      {startup !== null && (
        <label className="field row-field">
          <input
            type="checkbox"
            checked={startup}
            onChange={(e) => {
              const on = e.target.checked
              setStartup(on)
              onApply(() => api.patchProject({ startupFunction: on ? fn.id : -1 }))
            }}
          />
          <span>Arrancar con el show</span>
        </label>
      )}

      <button
        type="button"
        onClick={() =>
          api
            .functionUsage(fn.id)
            .then(setUsage)
            .catch(() => setUsage(null))
        }
      >
        ¿Dónde se usa?
      </button>

      {usage !== null && (
        <p className="hint usage">
          {usage.functions.length === 0 && usage.widgets.length === 0 && !usage.startup
            ? 'Nada la usa: se puede borrar sin dejar huecos.'
            : [
                ...usage.functions.map((f) => `${f.type} «${f.name}»`),
                ...usage.widgets.map((w) => `${w.type} «${w.caption || '(sin título)'}»`),
                ...(usage.startup ? ['el arranque del show'] : []),
              ].join(' · ')}
        </p>
      )}
    </div>
  )
}

/**
 * The script editor: the engine's own tokenizer says WHICH lines it refuses,
 * and the command menu spares remembering the grammar. Checked on demand, not
 * per keystroke -- half a line is wrong only for a moment.
 */
function ScriptBody({
  fn,
  body,
  onApply,
}: {
  fn: FunctionState
  body: FunctionBody
  onApply: (action: () => Promise<unknown>) => Promise<void>
}) {
  const [draft, setDraft] = useState(body.data ?? '')
  const [errors, setErrors] = useState<number[] | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the id on purpose
  useEffect(() => {
    setDraft(body.data ?? '')
    setErrors(null)
  }, [fn.id])

  const COMMANDS = [
    'startfunction:<id>',
    'stopfunction:<id>',
    'wait:1000',
    'waitkey:SPACE',
    'setfixture:<id> ch:0 val:255',
    'blackout:on',
    'blackout:off',
    'random:<min>,<max>',
    'systemcommand:/ruta arg:valor',
  ]

  return (
    <div className="field">
      <span>Programa</span>
      <textarea
        rows={8}
        value={draft}
        placeholder={'wait:1000\nsetfixture:0 ch:0 val:255'}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== (body.data ?? '')) onApply(() => api.setBody(fn.id, { data: draft }))
        }}
      />
      <div className="fields">
        <select
          value=""
          aria-label="Insertar comando"
          onChange={(e) => {
            if (e.target.value === '') return
            setDraft((current) =>
              current === '' ? e.target.value : `${current}\n${e.target.value}`,
            )
          }}
        >
          <option value="">Insertar comando…</option>
          {COMMANDS.map((command) => (
            <option key={command} value={command}>
              {command}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() =>
            api
              .scriptCheck(draft)
              .then((result) => setErrors(result.errors))
              .catch(() => setErrors(null))
          }
        >
          Comprobar sintaxis
        </button>
        {errors !== null && (
          <span className="hint" data-warn={errors.length > 0}>
            {errors.length === 0
              ? 'Sin errores.'
              : `El motor rechaza ${errors.length === 1 ? 'la línea' : 'las líneas'} ${errors.join(', ')}.`}
          </span>
        )}
      </div>
    </div>
  )
}

/** The audio file's silhouette: peaks straight from the daemon's decoders. */
function Waveform({ fn, source }: { fn: FunctionState; source: string }) {
  const [wave, setWave] = useState<number[] | null>(null)

  useEffect(() => {
    setWave(null)
    if (source === '') return
    let live = true
    api
      .waveform(fn.id, 200)
      .then((result) => live && setWave(result.points))
      .catch(() => live && setWave(null))
    return () => {
      live = false
    }
  }, [fn.id, source])

  if (wave === null) return null

  return (
    <div className="waveform" aria-label="Forma de onda">
      {wave.map((peak, index) => (
        // The slot is the identity: 200 fixed buckets over the file.
        // biome-ignore lint/suspicious/noArrayIndexKey: the index is the bucket
        <span key={index} style={{ height: `${Math.max(2, peak)}%` }} />
      ))}
    </div>
  )
}

/**
 * The palettes a scene carries: resolved at start against the scene's
 * fixtures, so retinting the palette retints this look without touching it.
 */
function ScenePalettes({
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
  const [available, setAvailable] = useState<{ id: number; name: string; type: string }[]>([])

  useEffect(() => {
    api
      .palettes()
      .then((r) => setAvailable(r.palettes))
      .catch(() => setAvailable([]))
  }, [])

  const attached = body.palettes ?? []
  if (available.length === 0 && attached.length === 0) return null

  const put = (ids: number[]) =>
    onApply(() =>
      api.setBody(fn.id, {
        palettes: ids,
        /* The palettes resolve against fixtures; with none named, every
           fixture in the rig is the honest default for a palette-only look. */
        fixtures: [
          ...new Set([...(body.values ?? []).map((v) => v.fixture), ...fixtures.map((f) => f.id)]),
        ],
      }),
    )

  return (
    <div className="field">
      <span>Palettes de la escena ({attached.length})</span>
      <ul className="channels">
        {attached.map((palette) => (
          <li key={palette.id}>
            <span className="grow">{palette.name}</span>
            <button
              type="button"
              aria-label={`Quitar palette ${palette.name}`}
              onClick={() => put(attached.filter((p) => p.id !== palette.id).map((p) => p.id))}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      <div className="channel-add">
        <select
          value=""
          aria-label="Añadir palette"
          onChange={(e) => {
            if (e.target.value === '') return
            put([...attached.map((p) => p.id), Number(e.target.value)])
          }}
        >
          <option value="">Añadir palette…</option>
          {available
            .filter((p) => !attached.some((a) => a.id === p.id))
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.type})
              </option>
            ))}
        </select>
      </div>
    </div>
  )
}

/**
 * The channel tools: whole kinds of channel at once, through the fixture's
 * own definition. The gels come from the daemon's colour books, and applying
 * one writes the EXACT RGB the book names.
 */
function ChannelTools({
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
  const [books, setBooks] = useState<{ name: string; colors: { name: string; rgb: string }[] }[]>(
    [],
  )
  const [lastColor, setLastColor] = useState<string | null>(null)

  useEffect(() => {
    api
      .colorFilters()
      .then((r) => setBooks(r.filters))
      .catch(() => setBooks([]))
  }, [])

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

  const channelsOf = (groups: string[], nameHint?: RegExp) =>
    (detail?.channelList ?? []).filter(
      (c) => (c.group !== undefined && groups.includes(c.group)) || nameHint?.test(c.name) === true,
    )

  const applyAll = (entries: { channel: number; value: number }[]) => {
    if (fixtureId === null || entries.length === 0) return
    onApply(async () => {
      for (const entry of entries)
        await api.setSceneValue(fn.id, fixtureId, entry.channel, entry.value)
    })
  }

  /* RGB by channel NAME within the colour group: the definition names them
     Red/Green/Blue, and a gel is meaningless applied to a colour wheel. */
  const rgb = {
    r: (detail?.channelList ?? []).find((c) => /^red/i.test(c.name)),
    g: (detail?.channelList ?? []).find((c) => /^green/i.test(c.name)),
    b: (detail?.channelList ?? []).find((c) => /^blue/i.test(c.name)),
  }
  const applyColor = (hex: string) => {
    if (!rgb.r || !rgb.g || !rgb.b) return
    const value = Number.parseInt(hex.slice(1), 16)
    applyAll([
      { channel: rgb.r.index, value: (value >> 16) & 255 },
      { channel: rgb.g.index, value: (value >> 8) & 255 },
      { channel: rgb.b.index, value: value & 255 },
    ])
  }

  const intensity = channelsOf(['Intensity']).filter(
    (c) => !/^(red|green|blue|white|amber|uv)/i.test(c.name),
  )
  const pan = channelsOf(['Pan']).filter((c) => !/fine/i.test(c.name))
  const tilt = channelsOf(['Tilt']).filter((c) => !/fine/i.test(c.name))
  const shutter = channelsOf(['Shutter'])

  const others = fixtures.filter((f) => f.id !== fixtureId && f.model === detail?.model)

  return (
    <details className="channel-tools">
      <summary>Herramientas de canal</summary>

      <div className="fields">
        <label className="field">
          <span>Fixture</span>
          <select
            value={fixtureId ?? ''}
            onChange={(e) => setFixtureId(e.target.value === '' ? null : Number(e.target.value))}
          >
            {fixtures.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>

        {intensity.length > 0 && (
          <label className="field">
            <span>Intensidad</span>
            <Slider
              min={0}
              max={255}
              defaultValue={0}
              aria-label="Intensidad del fixture"
              onPointerUp={(e) =>
                applyAll(
                  intensity.map((c) => ({
                    channel: c.index,
                    value: Number((e.target as HTMLInputElement).value),
                  })),
                )
              }
            />
          </label>
        )}

        {rgb.r && rgb.g && rgb.b && (
          <label className="field">
            <span>Color</span>
            <input
              type="color"
              aria-label="Color del fixture"
              onBlur={(e) => {
                setLastColor(e.target.value)
                applyColor(e.target.value)
              }}
            />
          </label>
        )}

        {lastColor !== null && (
          <button
            type="button"
            title="Guarda este color como palette reutilizable"
            onClick={() =>
              onApply(() =>
                api.createPalette({
                  type: 'Color',
                  name: `Color ${lastColor}`,
                  values: [lastColor],
                }),
              )
            }
          >
            Guardar como palette
          </button>
        )}
      </div>

      {rgb.r && rgb.g && rgb.b && books.length > 0 && (
        <div className="fields">
          {books.map((book) => (
            <label className="field grow-field" key={book.name}>
              <span>Gelatinas · {book.name}</span>
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value !== '') applyColor(e.target.value)
                }}
              >
                <option value="">— elegir gel —</option>
                {book.colors.map((color) => (
                  <option key={`${color.name}${color.rgb}`} value={color.rgb}>
                    {color.name} ({color.rgb})
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}

      {(pan.length > 0 || tilt.length > 0) && (
        <div className="fields">
          {pan.length > 0 && (
            <label className="field">
              <span>Pan</span>
              <Slider
                min={0}
                max={255}
                defaultValue={128}
                aria-label="Pan"
                onPointerUp={(e) =>
                  applyAll(
                    pan.map((c) => ({
                      channel: c.index,
                      value: Number((e.target as HTMLInputElement).value),
                    })),
                  )
                }
              />
            </label>
          )}
          {tilt.length > 0 && (
            <label className="field">
              <span>Tilt</span>
              <Slider
                min={0}
                max={255}
                defaultValue={128}
                aria-label="Tilt"
                onPointerUp={(e) =>
                  applyAll(
                    tilt.map((c) => ({
                      channel: c.index,
                      value: Number((e.target as HTMLInputElement).value),
                    })),
                  )
                }
              />
            </label>
          )}
        </div>
      )}

      {shutter.length > 0 && (
        <div className="fields">
          <span className="field-head">Shutter</span>
          <button
            type="button"
            onClick={() => applyAll(shutter.map((c) => ({ channel: c.index, value: 255 })))}
          >
            Abierto
          </button>
          <button
            type="button"
            onClick={() => applyAll(shutter.map((c) => ({ channel: c.index, value: 0 })))}
          >
            Cerrado
          </button>
        </div>
      )}

      {others.length > 0 && (
        <div className="fields">
          <button
            type="button"
            title={`Copia los valores de este fixture en la escena a ${others.length} del mismo modelo`}
            onClick={() => {
              const mine = (body.values ?? []).filter((v) => v.fixture === fixtureId)
              if (mine.length === 0) return
              onApply(async () => {
                for (const twin of others) {
                  for (const value of mine)
                    await api.setSceneValue(fn.id, twin.id, value.channel, value.value)
                }
              })
            }}
          >
            Copiar a los {others.length} del mismo modelo
          </button>
        </div>
      )}
    </details>
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

/**
 * Which output an Audio function plays through, and whether it can play at all.
 *
 * The panel used to say, flatly, that audio never sounds. That was true of the
 * AppImage and false of every machine with a sound server, which is the worst
 * kind of message an interface can carry: one that tells somebody not to bother
 * trying something that works. Now the daemon is asked, and what it answers is
 * what gets shown.
 */
function AudioOutput({
  fn,
  body,
  onApply,
}: {
  fn: FunctionState
  body: FunctionBody
  onApply: (action: () => Promise<unknown>) => Promise<void>
}) {
  const [devices, setDevices] = useState<AudioDevices | null>(null)

  useEffect(() => {
    api
      .audioDevices()
      .then(setDevices)
      .catch(() => setDevices(null))
  }, [])

  if (devices === null) return null

  if (devices.canPlay === false) {
    return (
      <p className="hint">{devices.silentBecause ?? 'Este daemon no puede reproducir audio.'}</p>
    )
  }

  return (
    <>
      <label className="field">
        <span>Salida</span>
        <select
          value={body.device ?? ''}
          onChange={(e) => onApply(() => api.setBody(fn.id, { device: e.target.value }))}
        >
          {/* Empty means the system default, which is a real choice and not the
              absence of one: a show that says nothing follows the machine. */}
          <option value="">La que tenga el sistema</option>
          {devices.outputs.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>

      {/* A device named in a show built on another machine is not here, and the
          daemon refuses it -- but it is worth saying before somebody presses
          play rather than after. */}
      {body.device && !devices.outputs.includes(body.device) && (
        <p className="hint">
          Esta salida («{body.device}») no está en esta máquina, así que sonará por la que tenga el
          sistema.
        </p>
      )}
    </>
  )
}
