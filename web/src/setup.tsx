/**
 * Patching, from the browser.
 *
 * Universes and their output patch first, then the fixtures in them, because
 * that is the order the work happens in: a fixture patched into a universe that
 * reaches nothing is a fixture that does nothing, and the project looks
 * perfectly healthy either way.
 *
 * Every refusal from the daemon is shown as it came. It knows things this page
 * does not -- that an address overlaps, that a universe still has fixtures in
 * it, that a mode does not exist -- and paraphrasing them here would only lose
 * the reason.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  type AudioDevices,
  type ChannelGroup,
  type FixtureGroup,
  type FixtureState,
  type GroupCell,
  type IoOptions,
  type UniverseMap,
  type UniverseState,
  api,
} from './api'

type Tab = 'universes' | 'fixtures' | 'groups' | 'channels' | 'audio'

export function Setup({
  revision,
  levels,
  onLevel,
  onChanged,
}: {
  revision: number
  /** Where each channels group's fader is, by group id. Empty until somebody
   *  moves one: a group reports the value it was saved with. */
  levels: Record<number, number>
  onLevel: (id: number, value: number) => void
  onChanged: () => void
}) {
  const [tab, setTab] = useState<Tab>('universes')
  const [universes, setUniverses] = useState<UniverseState[]>([])
  const [fixtures, setFixtures] = useState<FixtureState[]>([])
  const [groups, setGroups] = useState<FixtureGroup[]>([])
  const [channelGroups, setChannelGroups] = useState<ChannelGroup[]>([])
  const [io, setIo] = useState<IoOptions | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const [u, f, g, c] = await Promise.all([
      api.universes(),
      api.fixtures(),
      api.groups(),
      api.channelGroups(),
    ])
    setUniverses(u)
    setFixtures(f)
    setGroups(g)
    setChannelGroups(c)
    onChanged()
  }, [onChanged])

  /* `revision` is the dependency that matters: it changes when somebody else
     edited the show, and this screen has to look again. It is a value, not a
     value this effect reads, which is why the linter has to be told. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the trigger
  useEffect(() => {
    reload().catch((e) => setError(message(e)))
  }, [reload, revision])

  useEffect(() => {
    api
      .io()
      .then(setIo)
      .catch(() => setIo(null))
  }, [])

  // Every action funnels through here so a refusal always lands somewhere the
  // operator can read it, rather than in the browser console.
  const run = async (action: () => Promise<unknown>) => {
    setError(null)
    try {
      await action()
      await reload()
    } catch (e) {
      setError(message(e))
    }
  }

  return (
    <section className="setup">
      <nav className="tabs">
        <button
          type="button"
          aria-pressed={tab === 'universes'}
          onClick={() => setTab('universes')}
        >
          Universos
        </button>
        <button type="button" aria-pressed={tab === 'fixtures'} onClick={() => setTab('fixtures')}>
          Fixtures ({fixtures.length})
        </button>
        <button type="button" aria-pressed={tab === 'groups'} onClick={() => setTab('groups')}>
          Grupos ({groups.length})
        </button>
        <button type="button" aria-pressed={tab === 'channels'} onClick={() => setTab('channels')}>
          Canales ({channelGroups.length})
        </button>
        <button type="button" aria-pressed={tab === 'audio'} onClick={() => setTab('audio')}>
          Audio
        </button>
      </nav>

      {error && <p className="editor-error">{error}</p>}

      {tab === 'universes' && (
        <Universes universes={universes} io={io} fixtures={fixtures} onRun={run} />
      )}
      {tab === 'fixtures' && <Fixtures fixtures={fixtures} universes={universes} onRun={run} />}
      {tab === 'groups' && <Groups groups={groups} fixtures={fixtures} onRun={run} />}
      {tab === 'audio' && <Audio onRun={run} />}
      {tab === 'channels' && (
        <ChannelGroups
          groups={channelGroups}
          fixtures={fixtures}
          levels={levels}
          onLevel={onLevel}
          onRun={run}
        />
      )}
    </section>
  )
}

function Universes({
  universes,
  io,
  fixtures,
  onRun,
}: {
  universes: UniverseState[]
  io: IoOptions | null
  fixtures: FixtureState[]
  onRun: (action: () => Promise<unknown>) => Promise<void>
}) {
  return (
    <div className="stack">
      {io !== null && io.outputPlugins.length === 0 && (
        <p className="hint">
          El daemon no tiene ningún plugin de salida cargado, así que no hay nada a lo que conectar
          un universo. Arráncalo sin <code>--no-output</code>.
        </p>
      )}

      {universes.map((universe) => (
        <UniverseCard
          key={universe.id}
          universe={universe}
          io={io}
          fixtureCount={fixtures.filter((f) => f.universe === universe.id).length}
          onRun={onRun}
        />
      ))}

      <button type="button" onClick={() => onRun(() => api.addUniverse())}>
        + Añadir universo
      </button>

      {io !== null && <ProfileWorkshop io={io} onRun={onRun} />}
    </div>
  )
}

/**
 * The plugin's own knobs on a patch: ArtNet's target IP, OSC's ports, MIDI's
 * channel. Written key by key onto the running plugin and persisted with the
 * patch, so what is shown is what is configured.
 */
function PatchKnobs({
  universe,
  target,
  index,
  label,
  parameters,
  onRun,
}: {
  universe: number
  target: 'input' | 'output'
  index: number
  label: string
  parameters: Record<string, unknown> | undefined
  onRun: (action: () => Promise<unknown>) => Promise<void>
}) {
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')

  const entries = Object.entries(parameters ?? {})

  const write = (name: string, raw: string) => {
    /* Numbers travel as numbers: an OSC port sent as "7700" configures a
       different thing than 7700 in some plugins. */
    const parsed = raw.trim() !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : raw
    onRun(() => api.setPatchParameters(universe, { target, index, parameters: { [name]: parsed } }))
  }

  if (entries.length === 0 && key === '' && value === '') {
    /* Folded to a single affordance until somebody needs it. */
  }

  return (
    <details className="patch-knobs">
      <summary>Ajustes del plugin ({label})</summary>

      {entries.map(([name, current]) => (
        <label key={name} className="field">
          <span>{name}</span>
          <input
            defaultValue={String(current)}
            onBlur={(e) => String(current) !== e.target.value && write(name, e.target.value)}
          />
        </label>
      ))}

      <div className="fields">
        <label className="field">
          <span>Parámetro</span>
          <input value={key} placeholder="outputIP" onChange={(e) => setKey(e.target.value)} />
        </label>
        <label className="field">
          <span>Valor</span>
          <input value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        <button
          type="button"
          disabled={key.trim() === ''}
          onClick={() => {
            write(key.trim(), value)
            setKey('')
            setValue('')
          }}
        >
          Aplicar
        </button>
      </div>
    </details>
  )
}

/**
 * The input profile workshop: what each control on a wing IS, written to
 * .qxi files QLC+ itself would load. «Aprender» listens to the live feed and
 * fills in the next control the operator moves -- the whole reason profile
 * editors exist.
 */
function ProfileWorkshop({
  io,
  onRun,
}: {
  io: IoOptions
  onRun: (action: () => Promise<unknown>) => Promise<void>
}) {
  const [chosenProfile, setChosenProfile] = useState('')
  const [detail, setDetail] = useState<{
    editable: boolean
    channels: { channel: number; name: string; type: string }[]
  } | null>(null)
  const [manufacturer, setManufacturer] = useState('')
  const [model, setModel] = useState('')
  const [channel, setChannel] = useState('')
  const [channelName, setChannelName] = useState('')
  const [channelType, setChannelType] = useState('Button')
  const [learning, setLearning] = useState(false)

  const reload = useCallback((name: string) => {
    if (name === '') {
      setDetail(null)
      return
    }
    api
      .inputProfile(name)
      .then((r) => setDetail({ editable: r.editable, channels: r.channels }))
      .catch(() => setDetail(null))
  }, [])

  useEffect(() => reload(chosenProfile), [chosenProfile, reload])

  /* Learning: the next control the operator touches names the channel. The
     live feed already broadcasts every input event for exactly this reason. */
  useEffect(() => {
    if (!learning) return
    const heard = (event: Event) => {
      const detailEvent = event as CustomEvent<{ channel: number }>
      setChannel(String(detailEvent.detail.channel))
      setLearning(false)
    }
    window.addEventListener('orchid-input', heard)
    return () => window.removeEventListener('orchid-input', heard)
  }, [learning])

  return (
    <details className="card">
      <summary>Perfiles de entrada</summary>

      <div className="fields">
        <label className="field">
          <span>Perfil</span>
          <select value={chosenProfile} onChange={(e) => setChosenProfile(e.target.value)}>
            <option value="">(elige uno)</option>
            {io.inputProfiles.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Nuevo: fabricante</span>
          <input value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} />
        </label>
        <label className="field">
          <span>Modelo</span>
          <input value={model} onChange={(e) => setModel(e.target.value)} />
        </label>
        <button
          type="button"
          disabled={manufacturer.trim() === '' || model.trim() === ''}
          onClick={() =>
            onRun(() =>
              api
                .createInputProfile({
                  manufacturer: manufacturer.trim(),
                  model: model.trim(),
                })
                .then((made) => {
                  setManufacturer('')
                  setModel('')
                  setChosenProfile(made.name)
                }),
            )
          }
        >
          Crear
        </button>
      </div>

      {detail !== null && (
        <>
          {!detail.editable && (
            <p className="hint">
              Este perfil viene con la instalación: se puede consultar, no tocar. Crea uno nuevo
              para tu ala.
            </p>
          )}

          {detail.channels.length === 0 && <p className="hint">Sin canales todavía.</p>}
          <ul className="channels">
            {detail.channels.map((c) => (
              <li key={c.channel}>
                <span>
                  {c.channel}: {c.name} <span className="chip">{c.type}</span>
                </span>
                {detail.editable && (
                  <button
                    type="button"
                    aria-label={`Quitar el canal ${c.channel}`}
                    onClick={() =>
                      onRun(() => api.removeProfileChannel(chosenProfile, c.channel)).then(() =>
                        reload(chosenProfile),
                      )
                    }
                  >
                    ✕
                  </button>
                )}
              </li>
            ))}
          </ul>

          {detail.editable && (
            <div className="fields">
              <label className="field">
                <span>Canal</span>
                <input
                  type="number"
                  min={0}
                  value={channel}
                  onChange={(e) => setChannel(e.target.value)}
                />
              </label>
              <button
                type="button"
                aria-pressed={learning}
                title="Mueve un control del ala y su canal se escribe solo"
                onClick={() => setLearning((current) => !current)}
              >
                {learning ? 'Escuchando…' : 'Aprender'}
              </button>
              <label className="field">
                <span>Nombre</span>
                <input
                  value={channelName}
                  placeholder="Fader 1"
                  onChange={(e) => setChannelName(e.target.value)}
                />
              </label>
              <label className="field">
                <span>Tipo</span>
                <select value={channelType} onChange={(e) => setChannelType(e.target.value)}>
                  {[
                    'Button',
                    'Slider',
                    'Knob',
                    'Encoder',
                    'Next Page',
                    'Previous Page',
                    'Page Set',
                  ].map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={channel === '' || channelName.trim() === ''}
                onClick={() =>
                  onRun(() =>
                    api.setProfileChannel(chosenProfile, Number(channel), {
                      name: channelName.trim(),
                      type: channelType,
                    }),
                  ).then(() => {
                    setChannel('')
                    setChannelName('')
                    reload(chosenProfile)
                  })
                }
              >
                Guardar canal
              </button>
            </div>
          )}
        </>
      )}
    </details>
  )
}

function UniverseCard({
  universe,
  io,
  fixtureCount,
  onRun,
}: {
  universe: UniverseState
  io: IoOptions | null
  fixtureCount: number
  onRun: (action: () => Promise<unknown>) => Promise<void>
}) {
  const [name, setName] = useState(universe.name)
  const [map, setMap] = useState<UniverseMap | null>(null)

  useEffect(() => setName(universe.name), [universe.name])

  // "plugin\u0000line" as the select's value: a line name is only unique inside
  // its plugin, and two plugins offering "Output 1" is the normal case.
  const lineValue = (patch?: { plugin: string; output: string }) =>
    patch ? `${patch.plugin}\u0000${patch.output}` : ''

  /* One select per existing patch, plus an empty one to add the next line: a
     universe can feed ArtNet for the rig and a recorder at the same time. */
  const outputSlots = [...universe.outputs.map(lineValue), '']

  return (
    <article className="card" data-warn={!universe.patched}>
      <header>
        <span className="chip">U{universe.id}</span>
        <input
          className="grow"
          value={name}
          aria-label={`Nombre del universo ${universe.id}`}
          onChange={(e) => setName(e.target.value)}
          onBlur={() =>
            name !== universe.name && onRun(() => api.patchUniverse(universe.id, { name }))
          }
          onKeyDown={(e) => {
            if (e.key === 'Enter' && name !== universe.name) {
              onRun(() => api.patchUniverse(universe.id, { name }))
            }
          }}
        />
        <button
          type="button"
          className="danger"
          onClick={() => onRun(() => api.removeUniverse(universe.id))}
        >
          Eliminar
        </button>
      </header>

      {outputSlots.map((value, index) => (
        // The slot is the identity: patch index N of this universe.
        // biome-ignore lint/suspicious/noArrayIndexKey: the index is the patch slot
        <label className="field" key={index}>
          <span>{index === 0 ? 'Salida' : `Salida ${index + 1}`}</span>
          <select
            value={value}
            onChange={(e) => {
              const [plugin = '', line = ''] = e.target.value.split('\u0000')
              onRun(() => api.patchUniverse(universe.id, { output: { plugin, line, index } }))
            }}
          >
            <option value="">
              {index === 0 ? '(ninguna — este universo no llega a nada)' : '(añadir otra línea…)'}
            </option>
            {(io?.outputPlugins ?? []).map((plugin) =>
              plugin.lines.map((line) => (
                <option key={`${plugin.name}/${line}`} value={`${plugin.name}\u0000${line}`}>
                  {plugin.name} · {line}
                </option>
              )),
            )}
          </select>
        </label>
      ))}

      {universe.outputs.map((patch, index) => (
        <PatchKnobs
          key={`${patch.plugin}/${patch.output}`}
          universe={universe.id}
          target="output"
          index={index}
          label={`${patch.plugin} · ${patch.output}`}
          parameters={patch.parameters}
          onRun={onRun}
        />
      ))}

      <label className="field">
        <span>Entrada</span>
        <select
          value={universe.input ? `${universe.input.plugin}\u0000${universe.input.line}` : ''}
          onChange={(e) => {
            const [plugin = '', line = ''] = e.target.value.split('\u0000')
            onRun(() => api.patchUniverse(universe.id, { input: { plugin, line } }))
          }}
        >
          <option value="">(ninguna — nada externo mueve este universo)</option>
          {(io?.inputPlugins ?? []).map((plugin) =>
            plugin.lines.map((line) => (
              <option key={`${plugin.name}/${line}`} value={`${plugin.name}\u0000${line}`}>
                {plugin.name} · {line}
              </option>
            )),
          )}
        </select>
      </label>

      {universe.input && (
        <PatchKnobs
          universe={universe.id}
          target="input"
          index={0}
          label={`${universe.input.plugin} · ${universe.input.line}`}
          parameters={universe.input.parameters}
          onRun={onRun}
        />
      )}

      {universe.input && (io?.inputProfiles.length ?? 0) > 0 && (
        <label className="field">
          <span>Perfil de entrada</span>
          <select
            value={universe.input.profile === 'None' ? '' : universe.input.profile}
            onChange={(e) =>
              onRun(() =>
                api.patchUniverse(universe.id, {
                  input: {
                    plugin: universe.input?.plugin ?? '',
                    line: universe.input?.line ?? '',
                    profile: e.target.value,
                  },
                }),
              )
            }
          >
            <option value="">(ninguno)</option>
            {(io?.inputProfiles ?? []).map((profile) => (
              <option key={profile} value={profile}>
                {profile}
              </option>
            ))}
          </select>
        </label>
      )}

      {universe.input && (
        <label className="field">
          <span>Feedback</span>
          <select
            value={
              universe.feedback ? `${universe.feedback.plugin}\u0000${universe.feedback.line}` : ''
            }
            onChange={(e) => {
              const [plugin = '', line = ''] = e.target.value.split('\u0000')
              onRun(() => api.patchUniverse(universe.id, { feedback: { plugin, line } }))
            }}
          >
            <option value="">(ninguno — los LED del control no se enteran)</option>
            {(io?.outputPlugins ?? []).map((plugin) =>
              plugin.lines.map((line) => (
                <option key={`${plugin.name}/${line}`} value={`${plugin.name}\u0000${line}`}>
                  {plugin.name} · {line}
                </option>
              )),
            )}
          </select>
        </label>
      )}

      <label className="field row-field">
        <input
          type="checkbox"
          checked={universe.passthrough}
          onChange={(e) =>
            onRun(() => api.patchUniverse(universe.id, { passthrough: e.target.checked }))
          }
        />
        <span>Passthrough (lo que entra sale, ignorando la mesa)</span>
      </label>

      <p className="hint">
        {fixtureCount} fixtures ·{' '}
        <button
          type="button"
          className="linkish"
          onClick={() =>
            api
              .universeMap(universe.id)
              .then(setMap)
              .catch(() => setMap(null))
          }
        >
          ver los 512 canales
        </button>
      </p>

      {map && <ChannelMap map={map} />}
    </article>
  )
}

/**
 * The 512 channels and who holds them.
 *
 * The view that makes a clash obvious before it becomes a light that will not
 * respond -- two fixtures on the same address is the classic one, and on a rig
 * it presents as one of them mirroring the other.
 */
function ChannelMap({ map }: { map: UniverseMap }) {
  const owner = new Array<{ name: string; index: number } | null>(512).fill(null)

  map.fixtures.forEach((fixture, index) => {
    for (let i = 0; i < fixture.channels; i++) {
      const channel = fixture.address - 1 + i
      if (channel >= 0 && channel < 512) owner[channel] = { name: fixture.name, index }
    }
  })

  return (
    <>
      <p className="hint">
        {map.used} canales usados, {map.free} libres.
      </p>
      <div className="channelmap">
        {owner.map((held, channel) => (
          <span
            // Position is the identity here: it is a fixed grid of 512 slots.
            // biome-ignore lint/suspicious/noArrayIndexKey: the index is the channel
            key={channel}
            data-held={held !== null}
            data-tone={held ? held.index % 6 : undefined}
            title={held ? `${channel + 1}: ${held.name}` : `${channel + 1}: libre`}
          />
        ))}
      </div>
    </>
  )
}

function Fixtures({
  fixtures,
  universes,
  onRun,
}: {
  fixtures: FixtureState[]
  universes: UniverseState[]
  onRun: (action: () => Promise<unknown>) => Promise<void>
}) {
  return (
    <div className="stack">
      <AddFixture universes={universes} onRun={onRun} />
      <PanelWizard universes={universes} onRun={onRun} />

      {fixtures.length === 0 && <p className="hint">Este proyecto no tiene fixtures.</p>}

      <div className="table">
        {fixtures.map((fixture) => (
          <FixtureRow key={fixture.id} fixture={fixture} universes={universes} onRun={onRun} />
        ))}
      </div>

      {fixtures.length > 0 && (
        <UniverseView fixtures={fixtures} universes={universes} onRun={onRun} />
      )}
      <AddressTool />
      {fixtures.length > 0 && <RigSummary fixtures={fixtures} />}
    </div>
  )
}

/**
 * The RGB panel wizard: one fixture per row, a group wired the way the LEDs
 * are. The snake is the part worth a machine: wiring that doubles back on
 * every other row is how real panels ship, and laying that out by hand in
 * the group grid is sixty error-prone clicks.
 */
function PanelWizard({
  universes,
  onRun,
}: {
  universes: UniverseState[]
  onRun: (action: () => Promise<unknown>) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [universe, setUniverse] = useState(1)
  const [address, setAddress] = useState(1)
  const [rows, setRows] = useState(4)
  const [columns, setColumns] = useState(4)
  const [components, setComponents] = useState('RGB')
  const [direction, setDirection] = useState('horizontal')
  const [startCorner, setStartCorner] = useState('topleft')
  const [displacement, setDisplacement] = useState('snake')

  const channelsPerCell = components === 'RGBW' ? 4 : 3

  return (
    <details className="card">
      <summary>Asistente de panel RGB</summary>

      <div className="fields">
        <label className="field grow-field">
          <span>Nombre</span>
          <input value={name} placeholder="Muro LED" onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>Universo</span>
          <select value={universe} onChange={(e) => setUniverse(Number(e.target.value))}>
            {universes.map((u) => (
              <option key={u.id} value={u.id}>
                U{u.id}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Dirección</span>
          <input
            type="number"
            min={1}
            max={512}
            value={address}
            onChange={(e) => setAddress(Number(e.target.value))}
          />
        </label>
      </div>

      <div className="fields">
        <label className="field">
          <span>Filas</span>
          <input
            type="number"
            min={1}
            max={64}
            value={rows}
            onChange={(e) => setRows(Number(e.target.value))}
          />
        </label>
        <label className="field">
          <span>Columnas</span>
          <input
            type="number"
            min={1}
            max={64}
            value={columns}
            onChange={(e) => setColumns(Number(e.target.value))}
          />
        </label>
        <label className="field">
          <span>Componentes</span>
          <select value={components} onChange={(e) => setComponents(e.target.value)}>
            {['RGB', 'BGR', 'BRG', 'GBR', 'GRB', 'RBG', 'RGBW'].map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Sentido</span>
          <select value={direction} onChange={(e) => setDirection(e.target.value)}>
            <option value="horizontal">Horizontal</option>
            <option value="vertical">Vertical</option>
          </select>
        </label>
        <label className="field">
          <span>Esquina inicial</span>
          <select value={startCorner} onChange={(e) => setStartCorner(e.target.value)}>
            <option value="topleft">Arriba izquierda</option>
            <option value="topright">Arriba derecha</option>
            <option value="bottomleft">Abajo izquierda</option>
            <option value="bottomright">Abajo derecha</option>
          </select>
        </label>
        <label className="field">
          <span>Cableado</span>
          <select value={displacement} onChange={(e) => setDisplacement(e.target.value)}>
            <option value="snake">Serpiente (vuelve en cada fila)</option>
            <option value="zigzag">Zigzag (todas iguales)</option>
          </select>
        </label>
      </div>

      <p className="hint">
        {rows} × {columns} celdas · {rows * columns * channelsPerCell} canales · una fixture por{' '}
        {direction === 'horizontal' ? 'fila' : 'columna'}; si una fila no cabe, salta al siguiente
        universo (creándolo si hace falta).
      </p>

      <button
        type="button"
        disabled={name.trim() === ''}
        onClick={() =>
          onRun(() =>
            api.addRgbPanel({
              name: name.trim(),
              universe,
              address,
              rows,
              columns,
              components,
              direction,
              startCorner,
              displacement,
            }),
          ).then(() => setName(''))
        }
      >
        Crear panel
      </button>
    </details>
  )
}

/**
 * Swap the model under a patched lamp, carrying the show across.
 *
 * Scenes, sequences, EFX, groups, the plan and the console's sliders all
 * follow; channels are matched semantically (red stays red even when the new
 * lamp keeps it on another channel). The engine's own remapper does the work
 * -- this form only chooses the replacement.
 */
function RemapForm({
  fixture,
  onRun,
  onDone,
}: {
  fixture: FixtureState
  onRun: (action: () => Promise<unknown>) => Promise<void>
  onDone: () => void
}) {
  const [manufacturers, setManufacturers] = useState<string[]>([])
  const [manufacturer, setManufacturer] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [model, setModel] = useState('')
  const [modes, setModes] = useState<{ name: string; channels: number }[]>([])
  const [mode, setMode] = useState('')
  const [address, setAddress] = useState(fixture.address)

  useEffect(() => {
    api
      .manufacturers('')
      .then((r) => setManufacturers(r.manufacturers))
      .catch(() => setManufacturers([]))
  }, [])

  useEffect(() => {
    setModels([])
    setModel('')
    if (!manufacturer) return
    let live = true
    api
      .models(manufacturer)
      .then((r) => live && setModels(r.models))
      .catch(() => live && setModels([]))
    return () => {
      live = false
    }
  }, [manufacturer])

  useEffect(() => {
    setModes([])
    setMode('')
    if (!manufacturer || !model) return
    let live = true
    api
      .modes(manufacturer, model)
      .then((r) => {
        if (!live) return
        setModes(r.modes)
        setMode(r.modes[0]?.name ?? '')
      })
      .catch(() => live && setModes([]))
    return () => {
      live = false
    }
  }, [manufacturer, model])

  return (
    <div className="remap-form">
      <p className="hint">
        Sustituir «{fixture.name}» por otro modelo: escenas, EFX, grupos y sliders siguen al nuevo,
        con los canales emparejados por lo que hacen.
      </p>
      <div className="fields">
        <label className="field">
          <span>Fabricante</span>
          <select value={manufacturer} onChange={(e) => setManufacturer(e.target.value)}>
            <option value="">(elige)</option>
            {manufacturers.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Modelo</span>
          <select value={model} onChange={(e) => setModel(e.target.value)} disabled={!manufacturer}>
            <option value="">(elige)</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Modo</span>
          <select value={mode} onChange={(e) => setMode(e.target.value)} disabled={!model}>
            {modes.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name} · {m.channels} canales
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Dirección</span>
          <input
            type="number"
            min={1}
            max={512}
            value={address}
            onChange={(e) => setAddress(Number(e.target.value))}
          />
        </label>
        <button
          type="button"
          disabled={!manufacturer || !model || !mode}
          onClick={() =>
            onRun(() => api.remapFixture(fixture.id, { manufacturer, model, mode, address })).then(
              onDone,
            )
          }
        >
          Sustituir
        </button>
      </div>
    </div>
  )
}

/**
 * The universe, cell by cell: 512 channels with who sits on each.
 *
 * Also the honest way to move a fixture -- pick it up, put it down on a free
 * run, and the daemon refuses the drop if it would land on somebody. QLC+
 * calls this the Universe View; cut and paste here is literally changing the
 * address, so that is what the gesture does.
 */
function UniverseView({
  fixtures,
  universes,
  onRun,
}: {
  fixtures: FixtureState[]
  universes: UniverseState[]
  onRun: (action: () => Promise<unknown>) => Promise<void>
}) {
  const [universe, setUniverse] = useState(1)
  const [moving, setMoving] = useState<number | null>(null)

  const local = fixtures.filter((f) => f.universe === universe)
  const byCell = new Map<number, FixtureState>()
  for (const fixture of local) {
    for (let c = fixture.address - 1; c < fixture.address - 1 + fixture.channels; c++) {
      byCell.set(c, fixture)
    }
  }
  const used = byCell.size

  /* A colour per fixture, stable across renders: the id decides the hue. */
  const hueOf = (id: number) => (id * 47) % 360

  const drop = (cell: number) => {
    if (moving === null) return
    const id = moving
    setMoving(null)
    onRun(() => api.patchFixture(id, { universe, address: cell + 1 }))
  }

  return (
    <details className="card universe-view">
      <summary>Vista de universo</summary>

      <div className="fields">
        <label className="field">
          <span>Universo</span>
          <select value={universe} onChange={(e) => setUniverse(Number(e.target.value))}>
            {universes.map((u) => (
              <option key={u.id} value={u.id}>
                U{u.id}
              </option>
            ))}
          </select>
        </label>
        <p className="hint">
          {used} ocupados · {512 - used} libres.
          {moving !== null
            ? ` Moviendo «${fixtures.find((f) => f.id === moving)?.name}»: pulsa una celda libre.`
            : ' Pulsa una fixture para recogerla y una celda libre para soltarla.'}
        </p>
      </div>

      <div className="uview-grid">
        {Array.from({ length: 512 }, (_, cell) => {
          const owner = byCell.get(cell)
          return (
            <button
              /* The cell IS the channel; 512 fixed positions. */
              // biome-ignore lint/suspicious/noArrayIndexKey: the index is the channel
              key={cell}
              type="button"
              className="uview-cell"
              data-held={owner !== undefined && owner.id === moving}
              title={
                owner
                  ? `${cell + 1} · ${owner.name} (${owner.address}–${owner.address + owner.channels - 1})`
                  : `${cell + 1} libre`
              }
              style={
                owner
                  ? { background: `hsl(${hueOf(owner.id)} 60% ${owner.id === moving ? 60 : 40}%)` }
                  : undefined
              }
              onClick={() => {
                if (owner === undefined) drop(cell)
                else setMoving(moving === owner.id ? null : owner.id)
              }}
            >
              {cell % 32 === 0 ? cell + 1 : ''}
            </button>
          )
        })}
      </div>
    </details>
  )
}

/**
 * The DIP switch calculator, both ways: type an address and read the
 * switches, or click switches and read the address. The common convention
 * (all switches off = address 1) is a toggle, because half the amps on a rig
 * follow it and the other half do not.
 */
function AddressTool() {
  const [address, setAddress] = useState(1)
  const [plusOne, setPlusOne] = useState(true)

  const value = plusOne ? address - 1 : address
  const clamp = (next: number) => Math.min(512, Math.max(plusOne ? 1 : 0, next))

  return (
    <details className="card">
      <summary>Calculadora DIP</summary>

      <div className="fields">
        <label className="field">
          <span>Dirección</span>
          <input
            type="number"
            min={1}
            max={512}
            value={address}
            onChange={(e) => setAddress(clamp(Number(e.target.value)))}
          />
        </label>
        <label className="field row-field">
          <input type="checkbox" checked={plusOne} onChange={(e) => setPlusOne(e.target.checked)} />
          <span>Todo apagado = dirección 1 (DIP = dirección − 1)</span>
        </label>
      </div>

      <fieldset className="dip-bank">
        <legend className="visually-hidden">Interruptores DIP</legend>
        {Array.from({ length: 10 }, (_, i) => {
          const on = (value & (1 << i)) !== 0
          return (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: the index is the switch
              key={i}
              type="button"
              className="dip-switch"
              aria-pressed={on}
              aria-label={`DIP ${i + 1} (${1 << i})`}
              onClick={() => setAddress(clamp(address + (on ? -(1 << i) : 1 << i)))}
            >
              <span className="dip-lever" data-on={on} />
              <span className="dip-label">{i + 1}</span>
            </button>
          )
        })}
      </fieldset>
    </details>
  )
}

/**
 * What the rig weighs and draws, fixture by fixture and in total -- the two
 * numbers a rigger and a generator hire actually ask for. Printable: the
 * print stylesheet keeps only this card.
 */
function RigSummary({ fixtures }: { fixtures: FixtureState[] }) {
  const weight = fixtures.reduce((sum, f) => sum + (f.physical?.weight ?? 0), 0)
  const power = fixtures.reduce((sum, f) => sum + (f.physical?.power ?? 0), 0)
  const channels = fixtures.reduce((sum, f) => sum + f.channels, 0)
  const blanks = fixtures.filter((f) => f.physical === undefined).length

  return (
    <details className="card print-area">
      <summary>Resumen del rig</summary>

      <table className="summary-table">
        <thead>
          <tr>
            <th>Fixture</th>
            <th>Modo</th>
            <th>U</th>
            <th>Dirección</th>
            <th>Canales</th>
            <th>Peso</th>
            <th>Potencia</th>
          </tr>
        </thead>
        <tbody>
          {fixtures.map((f) => (
            <tr key={f.id}>
              <td>{f.name}</td>
              <td>{f.mode ?? '—'}</td>
              <td>{f.universe}</td>
              <td>
                {f.address}–{f.address + f.channels - 1}
              </td>
              <td>{f.channels}</td>
              <td>{f.physical?.weight !== undefined ? `${f.physical.weight} kg` : '—'}</td>
              <td>{f.physical?.power !== undefined ? `${f.physical.power} W` : '—'}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>{fixtures.length} fixtures</td>
            <td />
            <td />
            <td />
            <td>{channels}</td>
            <td>{weight > 0 ? `${Math.round(weight * 10) / 10} kg` : '—'}</td>
            <td>{power > 0 ? `${power} W` : '—'}</td>
          </tr>
        </tfoot>
      </table>

      {/* Missing data said plainly: a total that quietly skips half the rig
          reads as a lighter, thriftier rig than the one on the truck. */}
      {blanks > 0 && (
        <p className="hint">
          {blanks} de {fixtures.length} sin datos físicos en su definición: los totales son un
          mínimo, no el rig.
        </p>
      )}

      <button type="button" onClick={() => window.print()}>
        Imprimir
      </button>
    </details>
  )
}

function FixtureRow({
  fixture,
  universes,
  onRun,
}: {
  fixture: FixtureState
  universes: UniverseState[]
  onRun: (action: () => Promise<unknown>) => Promise<void>
}) {
  const [name, setName] = useState(fixture.name)
  const [address, setAddress] = useState(String(fixture.address))
  const [curves, setCurves] = useState(false)
  const [remapping, setRemapping] = useState(false)

  useEffect(() => {
    setName(fixture.name)
    setAddress(String(fixture.address))
  }, [fixture.name, fixture.address])

  const last = fixture.address + fixture.channels - 1

  return (
    <>
      <div className="table-row" data-warn={!fixture.resolved}>
        <input
          className="grow"
          value={name}
          aria-label="Nombre"
          onChange={(e) => setName(e.target.value)}
          onBlur={() =>
            name !== fixture.name && onRun(() => api.patchFixture(fixture.id, { name }))
          }
        />

        <select
          aria-label="Universo"
          value={fixture.universe}
          onChange={(e) =>
            onRun(() => api.patchFixture(fixture.id, { universe: Number(e.target.value) }))
          }
        >
          {universes.map((u) => (
            <option key={u.id} value={u.id}>
              U{u.id}
            </option>
          ))}
        </select>

        <input
          className="narrow"
          type="number"
          min={1}
          max={512}
          value={address}
          aria-label="Dirección"
          onChange={(e) => setAddress(e.target.value)}
          onBlur={() =>
            Number(address) !== fixture.address &&
            onRun(() => api.patchFixture(fixture.id, { address: Number(address) }))
          }
        />

        <span className="hint">
          {fixture.address}–{last}
          {fixture.mode ? ` · ${fixture.mode}` : ''}
          {/* A fixture whose definition could not be resolved still loads, backed
            by a generic dimmer. Saying so is the difference between a patch
            that looks right and one that is right. */}
          {fixture.resolved ? '' : ' · sin definición'}
        </span>

        <button
          type="button"
          aria-label={`Duplicar ${fixture.name}`}
          title="Duplicar: misma definición, primer hueco que la acoge"
          disabled={!fixture.resolved}
          onClick={() => onRun(() => api.cloneFixture(fixture.id))}
        >
          ⧉
        </button>

        <button
          type="button"
          aria-pressed={remapping}
          aria-label={`Sustituir ${fixture.name}`}
          title="Sustituir por otro modelo llevándose el show"
          onClick={() => setRemapping((open) => !open)}
        >
          ⇄
        </button>

        {/* A lamp behaving oddly is explained by a modifier more often than by
          anything else in the patch, so the count is on the row: without it
          the only way to notice one is to open every fixture in turn. */}
        <button
          type="button"
          aria-pressed={curves}
          aria-label={`Curvas de ${fixture.name}`}
          title="Modificadores de canal"
          onClick={() => setCurves((open) => !open)}
        >
          ∿{fixture.modifiers ? ` ${fixture.modifiers}` : ''}
        </button>

        <button
          type="button"
          className="danger"
          aria-label={`Eliminar ${fixture.name}`}
          onClick={() => onRun(() => api.removeFixture(fixture.id))}
        >
          ✕
        </button>
      </div>

      {curves && <Modifiers fixture={fixture} onRun={onRun} />}
      {remapping && (
        <RemapForm fixture={fixture} onRun={onRun} onDone={() => setRemapping(false)} />
      )}
    </>
  )
}

/**
 * The curve each channel's values pass through on the way out.
 *
 * "Invert" turns a fader upside down, "Always Full" pins a channel open,
 * "Exponential Deep" bends a dimmer to match a lamp that does not fade in a
 * straight line. It is part of the patch, not of any cue, which is why it is
 * edited on the fixture.
 *
 * The curve is drawn rather than only named. "Exponential Medium" and
 * "Exponential Deep" are both plausible and only one of them is what the lamp
 * needs; the shape is the only thing that says which.
 */
function Modifiers({
  fixture,
  onRun,
}: {
  fixture: FixtureState
  onRun: (action: () => Promise<unknown>) => Promise<void>
}) {
  const [channels, setChannels] = useState<
    { index: number; name: string; group?: string; modifier?: string }[]
  >([])
  const [templates, setTemplates] = useState<string[]>([])
  const [curves, setCurves] = useState<Record<string, number[]>>({})
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    const detail = await api.fixture(fixture.id)
    setChannels(detail.channelList)
    setLoading(false)
  }, [fixture.id])

  useEffect(() => {
    reload().catch(() => setLoading(false))
    api
      .modifiers()
      .then((m) => setTemplates(m.modifiers))
      .catch(() => setTemplates([]))
  }, [reload])

  // Fetch each curve once, the first time something is drawn with it.
  useEffect(() => {
    for (const channel of channels) {
      const name = channel.modifier
      if (name === undefined || curves[name] !== undefined) continue
      api
        .modifierCurve(name)
        .then((c) => setCurves((current) => ({ ...current, [name]: c.curve })))
        .catch(() => undefined)
    }
  }, [channels, curves])

  const apply = (index: number, name: string) => {
    /* The whole map every time, because that is the contract: a channel not
       named loses its curve. Building it from what is on screen keeps the
       other channels where they are. */
    const wanted: Record<string, string> = {}
    for (const channel of channels) {
      const value = channel.index === index ? name : (channel.modifier ?? '')
      if (value !== '') wanted[String(channel.index)] = value
    }

    return onRun(async () => {
      await api.setModifiers(fixture.id, wanted)
      await reload()
    })
  }

  if (loading) return <p className="hint">Leyendo canales…</p>

  return (
    <div className="modifiers">
      <p className="hint">
        La curva por la que pasa cada canal al salir. Es parte del patch, no de una escena: afecta a
        todo lo que mueva ese canal.
      </p>

      <ul className="channels">
        {channels.map((channel) => (
          <li key={channel.index}>
            <span>
              {channel.index + 1}. {channel.name}
              {channel.group ? <small>{channel.group}</small> : null}
            </span>

            {channel.modifier && <Curve points={curves[channel.modifier]} />}

            <select
              value={channel.modifier ?? ''}
              aria-label={`Modificador del canal ${channel.index + 1}`}
              onChange={(e) => apply(channel.index, e.target.value)}
            >
              <option value="">Sin modificador</option>
              {templates.map((template) => (
                <option key={template} value={template}>
                  {template}
                </option>
              ))}
            </select>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** A modifier's 256 values, drawn. Nothing at all until the curve arrives,
 *  rather than a straight line that would read as "no modifier". */
function Curve({ points }: { points: number[] | undefined }) {
  if (points === undefined) return <span className="curve-loading" />

  const path = points.map((value, i) => `${(i / 255) * 100},${100 - (value / 255) * 100}`).join(' ')

  return (
    <svg className="curve" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={path} />
    </svg>
  )
}

/** Manufacturer, then model, then mode: the three steps an operator takes. */
function AddFixture({
  universes,
  onRun,
}: {
  universes: UniverseState[]
  onRun: (action: () => Promise<unknown>) => Promise<void>
}) {
  const [search, setSearch] = useState('')
  const [manufacturers, setManufacturers] = useState<string[]>([])
  const [manufacturer, setManufacturer] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [model, setModel] = useState('')
  const [modes, setModes] = useState<{ name: string; channels: number }[]>([])
  const [mode, setMode] = useState('')
  const [universe, setUniverse] = useState(1)
  const [address, setAddress] = useState(1)
  const [quantity, setQuantity] = useState(1)
  const [gap, setGap] = useState(0)

  useEffect(() => {
    let live = true
    api
      .manufacturers(search)
      .then((r) => live && setManufacturers(r.manufacturers))
      .catch(() => live && setManufacturers([]))
    return () => {
      live = false
    }
  }, [search])

  useEffect(() => {
    setModels([])
    setModel('')
    setModes([])
    setMode('')
    if (!manufacturer) return

    let live = true
    api
      .models(manufacturer)
      .then((r) => live && setModels(r.models))
      .catch(() => live && setModels([]))
    return () => {
      live = false
    }
  }, [manufacturer])

  useEffect(() => {
    setModes([])
    setMode('')
    if (!manufacturer || !model) return

    let live = true
    api
      .modes(manufacturer, model)
      .then((r) => {
        if (!live) return
        setModes(r.modes)
        setMode(r.modes[0]?.name ?? '')
      })
      .catch(() => live && setModes([]))
    return () => {
      live = false
    }
  }, [manufacturer, model])

  const channels = modes.find((m) => m.name === mode)?.channels ?? 0
  const ready = manufacturer !== '' && model !== '' && mode !== ''

  return (
    <details className="card">
      <summary>Añadir fixtures</summary>

      <label className="field">
        <span>Fabricante ({manufacturers.length})</span>
        <input
          value={search}
          placeholder="Buscar…"
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Buscar fabricante"
        />
      </label>

      <label className="field">
        <span className="visually-hidden">Fabricante</span>
        <select value={manufacturer} onChange={(e) => setManufacturer(e.target.value)}>
          <option value="">(elige un fabricante)</option>
          {manufacturers.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>Modelo</span>
        <select value={model} onChange={(e) => setModel(e.target.value)} disabled={!manufacturer}>
          <option value="">(elige un modelo)</option>
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>Modo</span>
        <select value={mode} onChange={(e) => setMode(e.target.value)} disabled={!model}>
          {modes.map((m) => (
            <option key={m.name} value={m.name}>
              {m.name} · {m.channels} canales
            </option>
          ))}
        </select>
      </label>

      <div className="fields">
        <label className="field">
          <span>Universo</span>
          <select value={universe} onChange={(e) => setUniverse(Number(e.target.value))}>
            {universes.map((u) => (
              <option key={u.id} value={u.id}>
                U{u.id}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Dirección</span>
          <input
            type="number"
            min={1}
            max={512}
            value={address}
            onChange={(e) => setAddress(Number(e.target.value))}
          />
        </label>

        <label className="field">
          <span>Cantidad</span>
          <input
            type="number"
            min={1}
            max={64}
            value={quantity}
            onChange={(e) => setQuantity(Number(e.target.value))}
          />
        </label>

        <label className="field">
          <span>Hueco</span>
          <input
            type="number"
            min={0}
            max={64}
            value={gap}
            title="Canales libres entre fixture y fixture"
            onChange={(e) => setGap(Number(e.target.value))}
          />
        </label>
      </div>

      {channels > 0 && (
        <p className="hint">
          {quantity} × {channels} canales{gap > 0 ? ` con ${gap} de hueco` : ''}, de {address} a{' '}
          {address + quantity * channels + Math.max(0, quantity - 1) * gap - 1}.
        </p>
      )}

      <button
        type="button"
        disabled={!ready}
        onClick={() =>
          onRun(() =>
            api.addFixtures({ manufacturer, model, mode, universe, address, quantity, gap }),
          )
        }
      >
        Añadir
      </button>
    </details>
  )
}

/**
 * Fixture groups: what an RGB matrix runs across, and what an operator selects
 * by instead of one lamp at a time.
 *
 * The order inside a group is not decoration. For a matrix of pixel bars it is
 * what decides which way an effect runs across the rig, so adding a fixture
 * appends rather than re-laying the whole group.
 */
function Groups({
  groups,
  fixtures,
  onRun,
}: {
  groups: FixtureGroup[]
  fixtures: FixtureState[]
  onRun: (action: () => Promise<unknown>) => Promise<void>
}) {
  const [name, setName] = useState('')

  return (
    <div className="stack">
      <div className="card">
        <label className="field">
          <span>Nuevo grupo</span>
          <input value={name} placeholder="Nombre" onChange={(e) => setName(e.target.value)} />
        </label>
        <button
          type="button"
          disabled={name.trim() === ''}
          onClick={() => onRun(() => api.addGroup(name.trim(), [])).then(() => setName(''))}
        >
          Crear grupo
        </button>
      </div>

      {groups.length === 0 && <p className="hint">Este proyecto no tiene grupos.</p>}

      {groups.map((group) => (
        <GroupCard key={group.id} group={group} fixtures={fixtures} onRun={onRun} />
      ))}
    </div>
  )
}

function GroupCard({
  group,
  fixtures,
  onRun,
}: {
  group: FixtureGroup
  fixtures: FixtureState[]
  onRun: (action: () => Promise<unknown>) => Promise<void>
}) {
  const [name, setName] = useState(group.name)

  useEffect(() => setName(group.name), [group.name])

  const nameOf = (id: number) => fixtures.find((f) => f.id === id)?.name ?? `#${id}`

  return (
    <article className="card">
      <header>
        <input
          className="grow"
          value={name}
          aria-label={`Nombre del grupo ${group.id}`}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name !== group.name && onRun(() => api.patchGroup(group.id, { name }))}
        />
        <button
          type="button"
          className="danger"
          onClick={() => onRun(() => api.removeGroup(group.id))}
        >
          Eliminar
        </button>
      </header>

      {group.fixtures.length === 0 && <p className="hint">Vacío.</p>}

      <ul className="channels">
        {group.fixtures.map((id, index) => (
          <li key={id}>
            <span>
              {index + 1}. {nameOf(id)}
            </span>
            <button
              type="button"
              aria-label={`Quitar ${nameOf(id)}`}
              onClick={() =>
                onRun(() =>
                  api.patchGroup(group.id, {
                    fixtures: group.fixtures.filter((x) => x !== id),
                  }),
                )
              }
            >
              ✕
            </button>
          </li>
        ))}
      </ul>

      {group.fixtures.length > 0 && <GroupGrid group={group} fixtures={fixtures} onRun={onRun} />}

      <div className="channel-add">
        <select
          value=""
          aria-label="Añadir fixture al grupo"
          onChange={(e) => {
            if (e.target.value === '') return
            onRun(() =>
              api.patchGroup(group.id, {
                fixtures: [...group.fixtures, Number(e.target.value)],
              }),
            )
          }}
        >
          <option value="">Añadir fixture…</option>
          {fixtures
            .filter((f) => !group.fixtures.includes(f.id))
            .map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
        </select>
      </div>
    </article>
  )
}

/**
 * The group as the 2D grid it really is.
 *
 * Which head sits in which cell is what decides which way an RGB matrix runs
 * across the rig, so the grid is edited whole: every cell is a select over
 * the members' heads, and the turns are the daemon's -- the same arithmetic
 * QLC+ 5 applies, proven against the saved file.
 */
function GroupGrid({
  group,
  fixtures,
  onRun,
}: {
  group: FixtureGroup
  fixtures: FixtureState[]
  onRun: (action: () => Promise<unknown>) => Promise<void>
}) {
  const width = group.size?.width ?? 1
  const height = group.size?.height ?? 1
  const cells = group.cells ?? []

  const members = group.fixtures
    .map((id) => fixtures.find((f) => f.id === id))
    .filter((f): f is FixtureState => f !== undefined)

  const options: { value: string; label: string }[] = []
  for (const member of members) {
    const heads = member.heads ?? 1
    for (let head = 0; head < heads; head++) {
      options.push({
        value: `${member.id}:${head}`,
        label: heads > 1 ? `${member.name} · c${head + 1}` : member.name,
      })
    }
  }

  const at = (x: number, y: number) => cells.find((c) => c.x === x && c.y === y)

  const resize = (w: number, h: number) => {
    if (w < 1 || h < 1 || w > 64 || h > 64) return
    onRun(() =>
      api.patchGroup(group.id, {
        size: { width: w, height: h },
        /* Whatever no longer fits is dropped -- visibly, since the grid is
           the screen the operator is looking at. */
        cells: cells.filter((c) => c.x < w && c.y < h),
      }),
    )
  }

  const place = (x: number, y: number, value: string) => {
    const kept = cells.filter(
      (c) => !(c.x === x && c.y === y) && `${c.fixture}:${c.head}` !== value,
    )
    const next: GroupCell[] =
      value === ''
        ? kept
        : [
            ...kept,
            {
              x,
              y,
              fixture: Number(value.split(':')[0]),
              head: Number(value.split(':')[1]),
            },
          ]
    onRun(() => api.patchGroup(group.id, { size: { width, height }, cells: next }))
  }

  const turn = (op: string) => onRun(() => api.transformGroup(group.id, op))

  return (
    <div className="group-grid">
      <div className="fields">
        <label className="field">
          <span>Ancho</span>
          <input
            type="number"
            min={1}
            max={64}
            value={width}
            aria-label={`Ancho de la rejilla de ${group.name}`}
            onChange={(e) => resize(Number(e.target.value), height)}
          />
        </label>
        <label className="field">
          <span>Alto</span>
          <input
            type="number"
            min={1}
            max={64}
            value={height}
            aria-label={`Alto de la rejilla de ${group.name}`}
            onChange={(e) => resize(width, Number(e.target.value))}
          />
        </label>
        <div className="field">
          <span>Girar</span>
          <div className="grid-turns">
            <button
              type="button"
              title="Girar 90° a la izquierda"
              onClick={() => turn('rotate270')}
            >
              ⟲
            </button>
            <button type="button" title="Girar 90° a la derecha" onClick={() => turn('rotate90')}>
              ⟳
            </button>
            <button type="button" title="Girar 180°" onClick={() => turn('rotate180')}>
              180°
            </button>
            <button type="button" title="Espejar horizontal" onClick={() => turn('flipH')}>
              ↔
            </button>
            <button type="button" title="Espejar vertical" onClick={() => turn('flipV')}>
              ↕
            </button>
          </div>
        </div>
      </div>

      <div className="grid-cells" style={{ gridTemplateColumns: `repeat(${width}, 1fr)` }}>
        {Array.from({ length: width * height }, (_, i) => {
          const x = i % width
          const y = Math.floor(i / width)
          const cell = at(x, y)
          return (
            <select
              /* The cell IS the coordinate. */
              // biome-ignore lint/suspicious/noArrayIndexKey: the index is the cell
              key={i}
              className="grid-cell"
              value={cell ? `${cell.fixture}:${cell.head}` : ''}
              aria-label={`Celda ${x + 1},${y + 1} de ${group.name}`}
              onChange={(e) => place(x, y, e.target.value)}
            >
              <option value="">·</option>
              {options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Channels groups: one fader over a handful of channels picked by hand.
 *
 * They live on the patch screen because that is what they are -- part of the
 * document, like the fixtures they name, rather than part of the console. But
 * they are also live, so the fader here moves light. That is deliberate: a
 * group whose fader could only be built and not moved would be a group nobody
 * could check they had built right.
 */
function ChannelGroups({
  groups,
  fixtures,
  levels,
  onLevel,
  onRun,
}: {
  groups: ChannelGroup[]
  fixtures: FixtureState[]
  levels: Record<number, number>
  onLevel: (id: number, value: number) => void
  onRun: (action: () => Promise<unknown>) => Promise<void>
}) {
  const [name, setName] = useState('')

  return (
    <div className="stack">
      <p className="hint">
        Un grupo de canales junta canales sueltos (el dímer de una, el estrobo de otra) bajo un
        único fader. No es lo mismo que un grupo de fixtures, que junta fixtures enteras para que un
        efecto corra por ellas.
      </p>

      <div className="card">
        <label className="field">
          <span>Nuevo grupo de canales</span>
          <input value={name} placeholder="Nombre" onChange={(e) => setName(e.target.value)} />
        </label>
        <ChannelPicker
          fixtures={fixtures}
          label="Crear con este canal…"
          disabled={name.trim() === ''}
          onPick={(fixture, channel) =>
            onRun(() => api.addChannelGroup(name.trim(), [{ fixture, channel }])).then(() =>
              setName(''),
            )
          }
        />
      </div>

      {groups.length === 0 && <p className="hint">Este proyecto no tiene grupos de canales.</p>}

      {groups.map((group) => (
        <ChannelGroupCard
          key={group.id}
          group={group}
          fixtures={fixtures}
          value={levels[group.id] ?? group.value}
          onLevel={onLevel}
          onRun={onRun}
        />
      ))}
    </div>
  )
}

function ChannelGroupCard({
  group,
  fixtures,
  value,
  onLevel,
  onRun,
}: {
  group: ChannelGroup
  fixtures: FixtureState[]
  value: number
  onLevel: (id: number, value: number) => void
  onRun: (action: () => Promise<unknown>) => Promise<void>
}) {
  const [name, setName] = useState(group.name)

  useEffect(() => setName(group.name), [group.name])

  const without = (fixture: number, channel: number) =>
    group.channels
      .filter((c) => !(c.fixture === fixture && c.channel === channel))
      .map((c) => ({ fixture: c.fixture, channel: c.channel }))

  return (
    <article className="card">
      <header>
        <input
          className="grow"
          value={name}
          aria-label={`Nombre del grupo de canales ${group.id}`}
          onChange={(e) => setName(e.target.value)}
          onBlur={() =>
            name !== group.name && onRun(() => api.patchChannelGroup(group.id, { name }))
          }
        />
        <button
          type="button"
          className="danger"
          onClick={() => onRun(() => api.removeChannelGroup(group.id))}
        >
          Eliminar
        </button>
      </header>

      {/* The fader, right here. A group is not worth much if it cannot be
          tried on the rig the moment it is built. */}
      <div className="group-fader">
        <input
          type="range"
          min={0}
          max={255}
          value={value}
          disabled={!group.controllable}
          aria-label={`Nivel de ${group.name}`}
          onChange={(e) => onLevel(group.id, Number(e.target.value))}
        />
        <span className="fader-value">{Math.round((value / 255) * 100)}%</span>
      </div>

      {!group.controllable && (
        <p className="hint">
          Ninguno de sus canales existe ya, así que el fader no movería nada. Está desactivado a
          propósito.
        </p>
      )}

      <ul className="channels">
        {group.channels.map((channel) => (
          <li key={`${channel.fixture}:${channel.channel}`}>
            <span>
              {channel.missing ? (
                <em>fixture #{channel.fixture} (ya no existe)</em>
              ) : (
                <>
                  {channel.fixtureName} · {channel.name ?? `canal ${channel.channel + 1}`}
                  <small> DMX {(channel.address ?? 0) + 1}</small>
                </>
              )}
            </span>
            <button
              type="button"
              aria-label={`Quitar canal ${channel.channel + 1} de ${channel.fixtureName ?? channel.fixture}`}
              /* The last one cannot go: a group with no channels is refused by
                 the daemon, and offering a button that always fails is worse
                 than not offering it. */
              disabled={group.channels.length === 1}
              title={
                group.channels.length === 1
                  ? 'Un grupo necesita al menos un canal; elimina el grupo entero'
                  : undefined
              }
              onClick={() =>
                onRun(() =>
                  api.patchChannelGroup(group.id, {
                    channels: without(channel.fixture, channel.channel),
                  }),
                )
              }
            >
              ✕
            </button>
          </li>
        ))}
      </ul>

      <ChannelPicker
        fixtures={fixtures}
        label="Añadir canal…"
        taken={group.channels.map((c) => `${c.fixture}:${c.channel}`)}
        onPick={(fixture, channel) =>
          onRun(() =>
            api.patchChannelGroup(group.id, {
              channels: [
                ...group.channels.map((c) => ({ fixture: c.fixture, channel: c.channel })),
                { fixture, channel },
              ],
            }),
          )
        }
      />
    </article>
  )
}

/**
 * Pick one channel of one fixture, by name.
 *
 * Two steps rather than one long list, because a rig of thirty movers is nine
 * hundred channels. The channel names come from the fixture definition, so what
 * the operator picks is "Gobo Index", not "channel 6".
 */
function ChannelPicker({
  fixtures,
  label,
  taken = [],
  disabled = false,
  onPick,
}: {
  fixtures: FixtureState[]
  label: string
  taken?: string[]
  disabled?: boolean
  onPick: (fixture: number, channel: number) => void
}) {
  const [fixture, setFixture] = useState<number | null>(null)
  const [channels, setChannels] = useState<{ index: number; name: string; group?: string }[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (fixture === null) {
      setChannels([])
      return
    }

    let live = true
    setLoading(true)
    api
      .fixture(fixture)
      .then((detail) => live && setChannels(detail.channelList))
      .catch(() => live && setChannels([]))
      .finally(() => live && setLoading(false))

    return () => {
      live = false
    }
  }, [fixture])

  return (
    <div className="channel-add">
      <select
        value={fixture ?? ''}
        disabled={disabled}
        aria-label="Fixture"
        onChange={(e) => setFixture(e.target.value === '' ? null : Number(e.target.value))}
      >
        <option value="">{label}</option>
        {fixtures.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>

      {fixture !== null && (
        <select
          value=""
          disabled={loading || channels.length === 0}
          aria-label="Canal"
          onChange={(e) => {
            if (e.target.value === '') return
            onPick(fixture, Number(e.target.value))
            setFixture(null)
          }}
        >
          <option value="">{loading ? 'Leyendo canales…' : 'Canal…'}</option>
          {channels
            .filter((c) => !taken.includes(`${fixture}:${c.index}`))
            .map((c) => (
              <option key={c.index} value={c.index}>
                {c.index + 1}. {c.name}
                {c.group ? ` (${c.group})` : ''}
              </option>
            ))}
        </select>
      )}
    </div>
  )
}

/**
 * What this machine can do with sound.
 *
 * A machine setting rather than a project one, which is why it sits with the
 * universes and the plugins: the chosen input is written to QSettings and
 * outlives whatever show is loaded.
 *
 * Both halves are here because both fail the same way. An audio triggers widget
 * listening to the wrong socket looks exactly like one that does not work -- on
 * the machine this was built on the system default is a headphone jack with
 * nothing in it -- and an Audio function with no output to play through looks
 * exactly like one that has not been started.
 */
function Audio({ onRun }: { onRun: (action: () => Promise<unknown>) => Promise<void> }) {
  const [devices, setDevices] = useState<AudioDevices | null>(null)

  const reload = useCallback(() => {
    api
      .audioDevices()
      .then(setDevices)
      .catch(() => setDevices(null))
  }, [])

  useEffect(() => reload(), [reload])

  if (devices === null) return <p className="hint">Leyendo los dispositivos…</p>

  return (
    <div className="stack">
      <article className="card">
        <header>
          <strong>Entrada</strong>
          <span className="spacer" />
          <span className="chip">{devices.capturing ? 'escuchando' : 'en reposo'}</span>
        </header>

        <p className="hint">
          Por dónde escucha el widget de audio triggers. El micrófono no se abre hasta que alguien
          lo enciende en la consola.
        </p>

        {devices.inputs.length === 0 ? (
          <p className="hint">Esta máquina no tiene ninguna entrada de audio.</p>
        ) : (
          <label className="field">
            <span>Dispositivo</span>
            <select
              value={devices.selected}
              onChange={(e) => onRun(() => api.selectAudioInput(e.target.value).then(setDevices))}
            >
              {devices.inputs.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}

        {devices.unavailable && <p className="editor-error">{devices.unavailable}</p>}
      </article>

      <article className="card">
        <header>
          <strong>Salida</strong>
          <span className="spacer" />
          <span className="chip">{devices.canPlay ? 'puede sonar' : 'no puede sonar'}</span>
        </header>

        {devices.canPlay ? (
          <>
            <p className="hint">
              Cada función de audio elige la suya en su editor; sin elegir, suena por la del
              sistema.
            </p>
            <ul className="channels">
              {devices.outputs.map((name) => (
                <li key={name}>
                  <span>{name}</span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="hint">{devices.silentBecause}</p>
        )}

        <p className="hint">
          Formatos que sabe leer:{' '}
          {devices.formats.length > 0 ? devices.formats.join(' ') : 'ninguno'}
        </p>
      </article>
    </div>
  )
}

function message(e: unknown) {
  return e instanceof Error ? e.message : String(e)
}
