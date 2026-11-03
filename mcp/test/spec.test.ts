/**
 * El planificador, contra una mesa de mentira.
 *
 * Lo que se prueba aquí es lo que no se ve corriendo el smoke test: que un
 * documento malo se rechace ENTERO antes de tocar nada, y que uno bueno no
 * proponga trabajo que no hay. Las dos cosas son fáciles de romper sin que se
 * note, porque un plan de más se aplica sin dar error y un plan de menos deja
 * el proyecto a medias y tampoco lo da.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { OrchidClient } from '../src/client.js'
import { SpecError, planApply } from '../src/spec/apply.js'
import { ChannelNames } from '../src/spec/channels.js'
import type { ShowSpec } from '../src/spec/types.js'

/** Una mesa con lo justo, servida desde un objeto. */
function desk(overrides: Record<string, unknown> = {}): OrchidClient {
  const answers: Record<string, unknown> = {
    '/fixtures': [
      {
        id: 0,
        name: 'Cabeza L',
        manufacturer: 'Martin',
        model: 'MAC Aura',
        mode: 'Standard',
        universe: 1,
        address: 1,
        channels: 14,
      },
    ],
    '/fixtures/0': {
      id: 0,
      name: 'Cabeza L',
      channelList: [
        { index: 0, name: 'Pan' },
        { index: 1, name: 'Tilt' },
        { index: 6, name: 'Dimmer' },
        { index: 7, name: 'Dimmer' },
      ],
    },
    '/functions': [{ id: 3, name: 'Azul', type: 'Scene', fadeIn: 0, fadeOut: 0, duration: 0 }],
    '/functions/3/body': { values: [] },
    '/universes': [{ id: 1, name: 'Universe 1' }],
    '/fixture-groups': [],
    '/plan': {
      grid: { width: 5, height: 3, depth: 5, units: 'meters' },
      background: false,
      pointOfView: 'top',
      fixtures: [],
    },
    '/project': { path: '', name: '', directory: '', modified: false, startupFunction: -1 },
    '/io': {
      outputPlugins: [{ name: 'ArtNet', lines: ['eth0'] }],
      inputPlugins: [{ name: 'MIDI', lines: ['BCF2000'] }],
      inputProfiles: ['Behringer BCF2000'],
    },
    '/library/Martin/MAC%20Aura': {
      manufacturer: 'Martin',
      model: 'MAC Aura',
      modes: [{ name: 'Standard', channels: 14 }],
    },
    ...overrides,
  }

  const client = new OrchidClient({ baseUrl: 'http://mesa.de.mentira' })
  // Interceptado en request(): todo lo tipado de arriba pasa por aquí, así que
  // el código bajo prueba es el de verdad y no una copia.
  Object.defineProperty(client, 'request', {
    value: async (_method: string, path: string) => {
      if (path in answers) return answers[path]
      const error = new Error(`404 ${path}`)
      throw error
    },
  })
  return client
}

const base: ShowSpec = { orchidlights: 1 }

describe('el plan rechaza el documento entero antes de tocar nada', () => {
  it('un nombre repetido, porque no dice a cuál se refiere', async () => {
    const { problems } = await planApply(desk(), {
      ...base,
      functions: [
        { name: 'Azul', type: 'Scene' },
        { name: 'Azul', type: 'Chaser' },
      ],
    })
    expect(problems).toContain('functions: "Azul" aparece dos veces')
  })

  it('una fixture que ningún sitio va a crear', async () => {
    const { problems, actions } = await planApply(desk(), {
      ...base,
      functions: [
        { name: 'Nueva', type: 'Scene', values: [{ fixture: 'Fantasma', channel: 0, value: 255 }] },
      ],
    })
    expect(problems.join()).toContain('"Fantasma", que no existe')
    // Y ni una acción: se rechaza entero, no a medias.
    expect(actions).toEqual([])
  })

  it('pero acepta lo que este mismo documento crea después', async () => {
    const { problems } = await planApply(desk(), {
      ...base,
      fixtures: [
        {
          name: 'Nueva',
          manufacturer: 'Martin',
          model: 'MAC Aura',
          mode: 'Standard',
          universe: 1,
          address: 100,
        },
      ],
      functions: [
        { name: 'Escena', type: 'Scene', values: [{ fixture: 'Nueva', channel: 0, value: 255 }] },
      ],
    })
    expect(problems).toEqual([])
  })

  it('un plugin que esta máquina no tiene, diciendo cuáles hay', async () => {
    const { problems } = await planApply(desk(), {
      ...base,
      universes: [{ name: 'Universe 1', output: { plugin: 'Art-Net', line: 'eth0' } }],
    })
    expect(problems.join()).toContain('no tiene el plugin "Art-Net"')
    expect(problems.join()).toContain('ArtNet')
  })

  it('una línea que ese plugin no tiene', async () => {
    const { problems } = await planApply(desk(), {
      ...base,
      universes: [{ name: 'Universe 1', output: { plugin: 'ArtNet', line: 'eth9' } }],
    })
    expect(problems.join()).toContain('no tiene la línea "eth9"')
  })

  it('un perfil que no está en la librería, antes de patchear nada', async () => {
    const { problems } = await planApply(desk(), {
      ...base,
      fixtures: [
        {
          name: 'Rara',
          manufacturer: 'Acme',
          model: 'Nada',
          mode: 'X',
          universe: 1,
          address: 200,
        },
      ],
    })
    expect(problems.join()).toContain('"Acme/Nada"')
  })

  it('un modo que ese perfil no tiene, diciendo los que sí', async () => {
    const { problems } = await planApply(desk(), {
      ...base,
      fixtures: [
        {
          name: 'Otra',
          manufacturer: 'Martin',
          model: 'MAC Aura',
          mode: 'Mode 1',
          universe: 1,
          address: 200,
        },
      ],
    })
    expect(problems.join()).toContain('no tiene el modo "Mode 1"')
    expect(problems.join()).toContain('Standard')
  })

  it('un dímer genérico cuyo modo no dice cuántos canales tiene', async () => {
    const { problems } = await planApply(desk(), {
      ...base,
      fixtures: [
        {
          name: 'Dimmer',
          manufacturer: 'Generic',
          model: 'Generic',
          mode: 'Normal',
          universe: 1,
          address: 300,
        },
      ],
    })
    expect(problems.join()).toContain('cuántos canales tiene')
  })

  it('cambiar el tipo de una función, que sería borrarla', async () => {
    const { problems } = await planApply(desk(), {
      ...base,
      functions: [{ name: 'Azul', type: 'Chaser' }],
    })
    expect(problems.join()).toContain('es Scene en el proyecto y Chaser en el documento')
  })

  it('una versión del formato que esto no entiende', async () => {
    const { problems } = await planApply(desk(), { orchidlights: 99 })
    expect(problems.join()).toContain('entiende 1')
  })
})

describe('el plan no propone trabajo que no hay', () => {
  it('un documento que describe lo que ya hay no tiene acciones', async () => {
    const { actions, problems } = await planApply(desk(), {
      ...base,
      universes: [{ name: 'Universe 1' }],
      stage: { width: 5, height: 3, depth: 5, units: 'meters' },
      fixtures: [
        {
          name: 'Cabeza L',
          manufacturer: 'Martin',
          model: 'MAC Aura',
          mode: 'Standard',
          universe: 1,
          address: 1,
        },
      ],
      functions: [{ name: 'Azul', type: 'Scene', values: [] }],
    })
    expect(problems).toEqual([])
    expect(actions).toEqual([])
  })

  it('mover una fixture de dirección es un update, no un remap', async () => {
    const { actions } = await planApply(desk(), {
      ...base,
      fixtures: [
        {
          name: 'Cabeza L',
          manufacturer: 'Martin',
          model: 'MAC Aura',
          mode: 'Standard',
          universe: 1,
          address: 20,
        },
      ],
    })
    expect(actions).toHaveLength(1)
    expect(actions[0]?.kind).toBe('update')
    expect(actions[0]?.detail).toContain('U1@20')
    expect(actions[0]?.detail).not.toContain('remap')
  })

  it('cambiar de modo sí es un remap, porque cambia qué significa cada canal', async () => {
    const { actions } = await planApply(
      desk({
        '/library/Martin/MAC%20Aura': {
          manufacturer: 'Martin',
          model: 'MAC Aura',
          modes: [
            { name: 'Standard', channels: 14 },
            { name: 'Extended', channels: 25 },
          ],
        },
      }),
      {
        ...base,
        fixtures: [
          {
            name: 'Cabeza L',
            manufacturer: 'Martin',
            model: 'MAC Aura',
            mode: 'Extended',
            universe: 1,
            address: 1,
          },
        ],
      },
    )
    expect(actions[0]?.detail).toContain('remap')
  })
})

describe('lo que el documento no menciona sobrevive', () => {
  const empty: ShowSpec = { ...base, fixtures: [], functions: [] }

  it('sin prune no se borra nada', async () => {
    const { actions } = await planApply(desk(), empty)
    expect(actions.filter((action) => action.kind === 'delete')).toEqual([])
  })

  it('con prune se borra lo que sobra, y se dice qué', async () => {
    const { actions } = await planApply(desk(), empty, { prune: true })
    const deleted = actions.filter((action) => action.kind === 'delete').map((a) => a.name)
    expect(deleted).toContain('Cabeza L')
    expect(deleted).toContain('Azul')
  })

  it('una sección ausente no borra nada aunque haya prune', async () => {
    const { actions } = await planApply(desk(), { ...base, fixtures: [] }, { prune: true })
    const deleted = actions.filter((action) => action.kind === 'delete').map((a) => a.name)
    expect(deleted).toContain('Cabeza L')
    // functions no aparece en el documento, así que la función sigue ahí.
    expect(deleted).not.toContain('Azul')
  })
})

describe('los canales se dicen por nombre cuando el nombre no miente', () => {
  it('un nombre único va y vuelve', async () => {
    const names = await ChannelNames.of(desk(), [0])
    expect(names.write(0, 0)).toBe('Pan')
    expect(names.read(0, 'Pan')).toBe(0)
  })

  it('un nombre repetido se escribe con el número', async () => {
    const names = await ChannelNames.of(desk(), [0])
    // El perfil tiene dos canales llamados "Dimmer": decirlo por nombre
    // apuntaría a uno de los dos y nadie sabría a cuál.
    expect(names.write(0, 6)).toBe(6)
    expect(names.write(0, 7)).toBe(7)
    expect(names.read(0, 'Dimmer')).toBeUndefined()
  })

  it('un nombre que la fixture no tiene se dice, no se adivina', async () => {
    const names = await ChannelNames.of(desk(), [0])
    expect(names.read(0, 'Zoom')).toBeUndefined()
    expect(names.known(0)).toEqual(['Pan', 'Tilt'])
  })
})

describe('las diferencias fantasma no llegan al plan', () => {
  it('la rejilla de un grupo no cambia por el orden de las claves', async () => {
    // El daemon serializa alfabéticamente: {"height":1,"width":4}. El documento
    // se escribe como se lee: {width: 4, height: 1}. Son la misma rejilla.
    const { actions } = await planApply(
      desk({
        '/fixture-groups': [
          { id: 0, name: 'Frontales', size: { height: 1, width: 4 }, fixtures: [0] },
        ],
      }),
      {
        ...base,
        fixtureGroups: [
          { name: 'Frontales', fixtures: ['Cabeza L'], size: { width: 4, height: 1 } },
        ],
      },
    )
    expect(actions).toEqual([])
  })

  it('pero el orden de los pasos de un chaser sí cuenta', async () => {
    const two = {
      '/functions': [
        { id: 3, name: 'A', type: 'Scene' },
        { id: 4, name: 'B', type: 'Scene' },
        { id: 5, name: 'Ch', type: 'Chaser' },
      ],
      '/functions/5/body': {
        steps: [
          { function: 3, fadeIn: 0, hold: 0, fadeOut: 0 },
          { function: 4, fadeIn: 0, hold: 0, fadeOut: 0 },
        ],
      },
      '/functions/3/body': { values: [] },
      '/functions/4/body': { values: [] },
    }
    const { actions } = await planApply(desk(two), {
      ...base,
      functions: [{ name: 'Ch', type: 'Chaser', steps: [{ function: 'B' }, { function: 'A' }] }],
    })
    expect(actions.map((a) => a.detail)).toContain('2 pasos')
  })
})

describe('SpecError', () => {
  it('con un problema, lo dice tal cual', () => {
    expect(new SpecError(['una cosa']).message).toBe('una cosa')
  })

  it('con varios, los cuenta y los enumera', () => {
    const error = new SpecError(['una', 'otra'])
    expect(error.message).toContain('2 problemas')
    expect(error.message).toContain('· una')
  })
})

describe('dónde está la mesa', () => {
  const saved = { url: process.env.ORCHID_URL, home: process.env.HOME }
  afterEach(() => {
    process.env.ORCHID_URL = saved.url
    process.env.HOME = saved.home
  })

  it('una variable vacía es una variable ausente', async () => {
    // `ORCHID_URL=` es como se pide "usa el de siempre" desde un shell, y con
    // `??` se colaba como URL base: las peticiones salían a "/api/v1" tal cual.
    process.env.ORCHID_URL = ''
    process.env.HOME = '/tmp/orchid-test-no-home'
    const { deskUrl, DEFAULT_URL } = await import('../src/config.js')
    expect(deskUrl()).toBe(DEFAULT_URL)
  })

  it('y una con valor gana a todo lo demás', async () => {
    process.env.ORCHID_URL = 'http://mesa.local:1234'
    const { deskUrl } = await import('../src/config.js')
    expect(deskUrl()).toBe('http://mesa.local:1234')
  })
})
