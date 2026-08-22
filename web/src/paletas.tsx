/**
 * Palettes: one value with a name, referenced from scenes.
 *
 * The indirection is the point -- retint «Corporativo» and every look that
 * carries it retints, which is why the manager edits VALUES and never scenes.
 * «Aplicar» resolves the palette onto chosen fixtures and holds the result on
 * the live desk, where the dump can freeze it: that is how a palette becomes
 * a scene when the operator wants one.
 */

import { useCallback, useEffect, useState } from 'react'
import { type FixtureState, type PaletteState, api } from './api'

const TYPES = [
  { value: 'Dimmer', label: 'Dimmer' },
  { value: 'Color', label: 'Color' },
  { value: 'Pan', label: 'Pan' },
  { value: 'Tilt', label: 'Tilt' },
  { value: 'PanTilt', label: 'Pan/Tilt' },
  { value: 'Position3D', label: 'Posición 3D' },
  { value: 'Shutter', label: 'Shutter' },
  { value: 'Gobo', label: 'Gobo' },
  { value: 'Zoom', label: 'Zoom' },
]

const FAN_TYPES = ['Flat', 'Linear', 'Sine', 'Square', 'Saw']
const FAN_LAYOUTS = [
  'XAscending',
  'XDescending',
  'XCentered',
  'YAscending',
  'YDescending',
  'YCentered',
]

/** How many numbers each type carries (Color carries one hex string). */
function slotsOf(type: string): number {
  if (type === 'PanTilt' || type === 'Shutter') return 2
  if (type === 'Position3D') return 3
  return 1
}

export function Palettes({
  fixtures,
  onError,
}: {
  fixtures: FixtureState[]
  onError: (message: string) => void
}) {
  const [palettes, setPalettes] = useState<PaletteState[]>([])
  const [type, setType] = useState('Color')
  const [name, setName] = useState('')
  const [open, setOpen] = useState<number | null>(null)

  const reload = useCallback(() => {
    api
      .palettes()
      .then((r) => setPalettes(r.palettes))
      .catch(() => setPalettes([]))
  }, [])

  useEffect(() => reload(), [reload])

  const run = (action: () => Promise<unknown>) =>
    action()
      .then(reload)
      .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))

  return (
    <details className="palettes">
      <summary>Palettes ({palettes.length})</summary>

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
          <input value={name} placeholder="Corporativo" onChange={(e) => setName(e.target.value)} />
        </label>
        <button
          type="button"
          disabled={name.trim() === ''}
          onClick={() =>
            run(() =>
              api
                .createPalette({
                  type,
                  name: name.trim(),
                  values: type === 'Color' ? ['#ffffff'] : new Array(slotsOf(type)).fill(0),
                })
                .then(() => setName('')),
            )
          }
        >
          Crear
        </button>
      </div>

      {palettes.length === 0 && (
        <p className="hint">Sin palettes: crea una y las escenas podrán referenciarla.</p>
      )}

      <ul className="channels">
        {palettes.map((palette) => (
          <li key={palette.id} className="palette-row">
            <div className="palette-head">
              <button
                type="button"
                className="linkish"
                aria-expanded={open === palette.id}
                onClick={() => setOpen(open === palette.id ? null : palette.id)}
              >
                {palette.name}
              </button>
              <span className="chip">{palette.type}</span>
              {palette.type === 'Color' && typeof palette.values[0] === 'string' && (
                <span className="palette-swatch" style={{ background: palette.values[0] }} />
              )}
              <span className="spacer" />
              <button
                type="button"
                aria-label={`Borrar ${palette.name}`}
                onClick={() => run(() => api.removePalette(palette.id))}
              >
                ✕
              </button>
            </div>

            {open === palette.id && (
              <PaletteEditor palette={palette} fixtures={fixtures} onRun={run} />
            )}
          </li>
        ))}
      </ul>
    </details>
  )
}

function PaletteEditor({
  palette,
  fixtures,
  onRun,
}: {
  palette: PaletteState
  fixtures: FixtureState[]
  onRun: (action: () => Promise<unknown>) => void
}) {
  const [chosen, setChosen] = useState<Set<number>>(new Set(fixtures.map((f) => f.id)))

  return (
    <div className="palette-editor">
      <div className="fields">
        {palette.type === 'Color' ? (
          <label className="field">
            <span>Valor</span>
            <input
              type="color"
              defaultValue={String(palette.values[0] ?? '#ffffff')}
              onBlur={(e) =>
                onRun(() => api.patchPalette(palette.id, { values: [e.target.value] }))
              }
            />
          </label>
        ) : (
          Array.from({ length: slotsOf(palette.type) }, (_, slot) => (
            // The slot is the identity: a PanTilt palette has exactly slots 0 and 1.
            // biome-ignore lint/suspicious/noArrayIndexKey: the index is the slot
            <label className="field" key={slot}>
              <span>Valor {slotsOf(palette.type) > 1 ? slot + 1 : ''}</span>
              <input
                type="number"
                defaultValue={Number(palette.values[slot] ?? 0)}
                onBlur={(e) => {
                  const next = Array.from({ length: slotsOf(palette.type) }, (_, i) =>
                    i === slot ? Number(e.target.value) : Number(palette.values[i] ?? 0),
                  )
                  onRun(() => api.patchPalette(palette.id, { values: next }))
                }}
              />
            </label>
          ))
        )}

        <label className="field">
          <span>Abanico</span>
          <select
            value={palette.fanning.type}
            onChange={(e) =>
              onRun(() => api.patchPalette(palette.id, { fanning: { type: e.target.value } }))
            }
          >
            {FAN_TYPES.map((t) => (
              <option key={t} value={t}>
                {t === 'Flat' ? 'Plano (sin abanico)' : t}
              </option>
            ))}
          </select>
        </label>

        {palette.fanning.type !== 'Flat' && (
          <>
            <label className="field">
              <span>Reparto</span>
              <select
                value={palette.fanning.layout}
                onChange={(e) =>
                  onRun(() => api.patchPalette(palette.id, { fanning: { layout: e.target.value } }))
                }
              >
                {FAN_LAYOUTS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Cantidad %</span>
              <input
                type="number"
                min={0}
                max={100}
                defaultValue={palette.fanning.amount}
                onBlur={(e) =>
                  onRun(() =>
                    api.patchPalette(palette.id, {
                      fanning: { amount: Number(e.target.value) },
                    }),
                  )
                }
              />
            </label>
            <div className="field">
              <span>Hasta</span>
              {palette.type === 'Color' ? (
                <input
                  type="color"
                  aria-label="Valor final del abanico"
                  defaultValue={String(palette.fanning.value ?? '#000000')}
                  onBlur={(e) =>
                    onRun(() =>
                      api.patchPalette(palette.id, { fanning: { value: e.target.value } }),
                    )
                  }
                />
              ) : (
                <input
                  type="number"
                  aria-label="Valor final del abanico"
                  defaultValue={Number(palette.fanning.value ?? 0)}
                  onBlur={(e) =>
                    onRun(() =>
                      api.patchPalette(palette.id, {
                        fanning: { value: Number(e.target.value) },
                      }),
                    )
                  }
                />
              )}
            </div>
          </>
        )}
      </div>

      {fixtures.length > 0 && (
        <div className="fields">
          <fieldset className="palette-targets" aria-label="Fixtures sobre los que aplicar">
            {fixtures.map((f) => (
              <label key={f.id} className="field row-field">
                <input
                  type="checkbox"
                  checked={chosen.has(f.id)}
                  onChange={(e) =>
                    setChosen((current) => {
                      const next = new Set(current)
                      if (e.target.checked) next.add(f.id)
                      else next.delete(f.id)
                      return next
                    })
                  }
                />
                <span>{f.name}</span>
              </label>
            ))}
          </fieldset>
          <button
            type="button"
            disabled={chosen.size === 0}
            title="Resuelve la palette sobre estos fixtures y la sujeta en la mesa viva; el volcado puede congelarla"
            onClick={() => onRun(() => api.applyPalette(palette.id, [...chosen]))}
          >
            Aplicar
          </button>
        </div>
      )}
    </div>
  )
}
