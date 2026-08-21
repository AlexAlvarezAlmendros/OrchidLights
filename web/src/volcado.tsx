/**
 * Dump: freeze what the desk is holding into a scene.
 *
 * The button wears the live count, because "what would I be recording" is the
 * question before pressing, not after. Values the Simple Desk holds on
 * unpatched addresses cannot enter a scene -- a scene speaks in (fixture,
 * channel) -- so they are counted and SAID, never silently dropped: a dump
 * that quietly shrinks is a look that comes back wrong next week.
 */

import { useEffect, useRef, useState } from 'react'
import { type FunctionState, api } from './api'

const GROUP_LABELS: Record<string, string> = {
  Intensity: 'Intensidad',
  Colour: 'Color',
  Gobo: 'Gobo',
  Speed: 'Velocidad',
  Pan: 'Pan',
  Tilt: 'Tilt',
  Shutter: 'Shutter',
  Prism: 'Prisma',
  Beam: 'Haz',
  Effect: 'Efecto',
  Maintenance: 'Mantenimiento',
}

export function DumpButton({
  count,
  bare,
  functions,
  onError,
  onDone,
}: {
  count: number
  bare: number
  functions: FunctionState[]
  onError: (message: string) => void
  onDone: (message: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [target, setTarget] = useState<'new' | number>('new')
  const [nonZeroOnly, setNonZeroOnly] = useState(true)
  const [groups, setGroups] = useState<string[]>([])
  const [available, setAvailable] = useState<string[]>([])
  const panel = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    api
      .dumpState()
      .then((state) => setAvailable(state.groups))
      .catch(() => setAvailable([]))
    const away = (event: PointerEvent) => {
      if (panel.current?.contains(event.target as Node) === true) return
      setOpen(false)
    }
    window.addEventListener('pointerdown', away)
    return () => window.removeEventListener('pointerdown', away)
  }, [open])

  const scenes = functions.filter((f) => f.type === 'Scene')

  const record = () => {
    api
      .dumpToScene({
        ...(target === 'new'
          ? name.trim() !== ''
            ? { name: name.trim() }
            : {}
          : { sceneId: target }),
        nonZeroOnly,
        ...(groups.length > 0 ? { groups } : {}),
      })
      .then((result) => {
        setOpen(false)
        setName('')
        onDone(`Volcado: ${result.written} valores a la escena #${result.scene}`)
      })
      .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
  }

  return (
    <div className="dump" ref={panel}>
      <button
        type="button"
        className="dump-badge num"
        disabled={count === 0}
        title={
          count === 0
            ? 'La mesa no sujeta nada que una escena pueda decir'
            : 'Volcar lo sujeto a una escena'
        }
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        ⭳ {count > 0 ? count : ''}
      </button>

      {open && (
        <div className="dump-panel">
          <p className="dump-lead">
            {count} valores listos para volcar
            {bare > 0 && (
              <>
                {' '}
                · <strong>{bare} quedan fuera</strong> (canales sin fixture: una escena no tiene
                palabras para ellos)
              </>
            )}
          </p>

          <label className="field">
            <span>Destino</span>
            <select
              value={target === 'new' ? 'new' : String(target)}
              onChange={(e) => setTarget(e.target.value === 'new' ? 'new' : Number(e.target.value))}
            >
              <option value="new">Escena nueva</option>
              {scenes.map((scene) => (
                <option key={scene.id} value={scene.id}>
                  Sobre «{scene.name}»
                </option>
              ))}
            </select>
          </label>

          {target === 'new' && (
            <label className="field">
              <span>Nombre</span>
              <input value={name} placeholder="Volcado" onChange={(e) => setName(e.target.value)} />
            </label>
          )}

          <label className="dump-check">
            <input
              type="checkbox"
              checked={nonZeroOnly}
              onChange={(e) => setNonZeroOnly(e.target.checked)}
            />
            Solo valores distintos de cero
          </label>

          {available.length > 1 && (
            <fieldset className="dump-groups">
              <legend>Tipos de canal (todos si no eliges)</legend>
              {available.map((group) => (
                <label key={group} className="dump-check">
                  <input
                    type="checkbox"
                    checked={groups.includes(group)}
                    onChange={(e) =>
                      setGroups((current) =>
                        e.target.checked ? [...current, group] : current.filter((g) => g !== group),
                      )
                    }
                  />
                  {GROUP_LABELS[group] ?? group}
                </label>
              ))}
            </fieldset>
          )}

          <button type="button" className="dump-go" onClick={record}>
            Volcar
          </button>
        </div>
      )}
    </div>
  )
}
