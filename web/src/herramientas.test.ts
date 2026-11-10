/**
 * The tools, with the desk and the document engine stood in for.
 *
 * The engine has its own tests in mcp/ and the daemon its smoke tests; what is
 * tested here is what the tools add on top: the input check that stands in
 * for the API's (gone with eager streaming), applying again while frames wait
 * for their children, finding a widget wherever it sits, and a test light
 * that leaves the room as it found it.
 */

import type { ApplyReport } from '@orchid/mcp/spec/apply'
import { SpecError, applySpec } from '@orchid/mcp/spec/apply'
import { exportSpec } from '@orchid/mcp/spec/export'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type Contexto, HERRAMIENTAS, cuenta, ejecutar, validar } from './herramientas'

vi.mock('@orchid/mcp/spec/apply', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@orchid/mcp/spec/apply')>()),
  applySpec: vi.fn(),
}))
vi.mock('@orchid/mcp/spec/export', () => ({ exportSpec: vi.fn() }))

const aplicarSpec = vi.mocked(applySpec)
const exportar = vi.mocked(exportSpec)

function informe(acciones: ApplyReport['actions']): ApplyReport {
  return {
    dryRun: false,
    actions: acciones,
    created: acciones.filter((a) => a.kind === 'create').length,
    updated: acciones.filter((a) => a.kind === 'update').length,
    deleted: 0,
    undoSteps: 1,
    undoOverflowed: false,
  }
}

function cliente(overrides: Record<string, unknown> = {}) {
  return {
    get: vi.fn(),
    post: vi.fn(async () => ({})),
    functions: vi.fn(async () => []),
    fixtures: vi.fn(async () => []),
    dmx: vi.fn(),
    io: vi.fn(),
    ...overrides,
  } as unknown as Contexto['client']
}

function contexto(client = cliente()): Contexto {
  return { client, signal: new AbortController().signal, cache: {} }
}

const DOC = { documento: { orchidlights: 1, functions: [] } }

beforeEach(() => vi.resetAllMocks())

describe('validar', () => {
  const esquema = {
    type: 'object' as const,
    properties: {
      nombre: { type: 'string' as const },
      segundos: { type: 'number' as const, minimum: 0.5, maximum: 10 },
      universo: { type: 'integer' as const, minimum: 1 },
      modo: { type: 'string' as const, enum: ['a', 'b'] },
    },
    required: ['nombre'],
  }

  it('lets a fitting input through, extra keys included', () => {
    expect(validar(esquema, { nombre: 'x', segundos: 3, otra: true })).toBeNull()
  })

  it.each([
    [null, /tiene que ser un objeto/],
    [[], /tiene que ser un objeto/],
    [{}, /falta entrada\.nombre/],
    [{ nombre: 1 }, /nombre tiene que ser texto/],
    [{ nombre: 'x', segundos: 30 }, /no puede ser mayor que 10/],
    [{ nombre: 'x', universo: 1.5 }, /tiene que ser un entero/],
    [{ nombre: 'x', universo: 0 }, /no puede ser menor que 1/],
    [{ nombre: 'x', modo: 'c' }, /es uno de: a, b/],
  ])('refuses %j', (valor, motivo) => {
    expect(validar(esquema, valor)).toMatch(motivo)
  })

  it('refuses a document without its version', () => {
    const aplicar = HERRAMIENTAS.find((h) => h.nombre === 'aplicar')
    expect(validar(aplicar?.esquema ?? esquema, { documento: { functions: [] } })).toMatch(
      /falta entrada\.documento\.orchidlights/,
    )
  })
})

describe('aplicar', () => {
  it('applies again while a new frame waits for its children, then stops', async () => {
    aplicarSpec
      .mockResolvedValueOnce(
        informe([
          {
            section: 'console',
            kind: 'create',
            name: '/LOOKS',
            detail: 'frame; sus 2 hijos, al volver a aplicar',
          },
        ]),
      )
      .mockResolvedValueOnce(
        informe([
          { section: 'console', kind: 'create', name: '/LOOKS/AZUL' },
          { section: 'console', kind: 'create', name: '/LOOKS/ROJO' },
        ]),
      )
    const c = contexto()
    c.cache.spec = { orchidlights: 1 }

    const r = await ejecutar(HERRAMIENTAS, 'aplicar', DOC, c)

    expect(aplicarSpec).toHaveBeenCalledTimes(2)
    expect(r.error).toBe(false)
    expect(r.cambios?.created).toBe(3)
    expect(r.cambios?.undoSteps).toBe(2)
    expect(r.resumen).toBe('Ha aplicado +3 widgets')
    // What was read before no longer describes the desk.
    expect(c.cache.spec).toBeUndefined()
  })

  it('stops after a few passes when a document never settles', async () => {
    aplicarSpec.mockResolvedValue(
      informe([
        {
          section: 'console',
          kind: 'create',
          name: '/X',
          detail: 'frame; sus 1 hijos, al volver a aplicar',
        },
      ]),
    )
    await ejecutar(HERRAMIENTAS, 'aplicar', DOC, contexto())
    expect(aplicarSpec).toHaveBeenCalledTimes(4)
  })

  it('says a document that changes nothing', async () => {
    aplicarSpec.mockResolvedValue(informe([]))
    const r = await ejecutar(HERRAMIENTAS, 'aplicar', DOC, contexto())
    expect(r.texto).toMatch(/ya está así/)
    expect(r.cambios).toBeUndefined()
  })

  it('hands back every problem of a refused document, as an error', async () => {
    aplicarSpec.mockRejectedValue(
      new SpecError(['fixtures: «Par 9» no existe', 'functions: nombre repetido']),
    )
    const r = await ejecutar(HERRAMIENTAS, 'aplicar', DOC, contexto())

    expect(r.error).toBe(true)
    expect(r.texto).toMatch(/no se ha tocado nada/)
    expect(r.texto).toMatch(/Par 9/)
    expect(r.texto).toMatch(/nombre repetido/)
    expect(r.resumen).toBe('2 problemas en el documento')
  })
})

describe('cuenta', () => {
  it('counts things, not the actions the engine split them into', () => {
    const r = {
      dryRun: false,
      actions: [
        { section: 'fixtures', kind: 'create' as const, name: 'Sala IA' },
        { section: 'functions', kind: 'create' as const, name: 'Prueba' },
        { section: 'functions', kind: 'create' as const, name: 'Prueba', detail: 'tiempos' },
        { section: 'functions', kind: 'create' as const, name: 'Prueba', detail: '1 valores' },
        { section: 'functions', kind: 'update' as const, name: 'Prueba', detail: 'valores' },
        { section: 'functions', kind: 'update' as const, name: 'Otra' },
        { section: 'console', kind: 'update' as const, name: '/LOOKS/AZUL' },
        { section: 'console', kind: 'update' as const, name: '/LOOKS/ROJO' },
      ],
      created: 4,
      updated: 4,
      deleted: 0,
      undoSteps: 1,
      undoOverflowed: false,
    }
    expect(cuenta(r)).toBe('+1 fixture, +1 función, ~1 función, ~2 widgets')
  })
})

describe('proponer', () => {
  it('rehearses without writing', async () => {
    aplicarSpec.mockResolvedValue(informe([{ section: 'functions', kind: 'create', name: 'Azul' }]))
    const r = await ejecutar(HERRAMIENTAS, 'proponer', DOC, contexto())

    expect(aplicarSpec).toHaveBeenCalledWith(expect.anything(), DOC.documento, { dryRun: true })
    expect(r.texto).toMatch(/\+ functions: Azul/)
  })
})

describe('ver', () => {
  it('finds a widget inside its frames, with the frames that hold it', async () => {
    exportar.mockResolvedValue({
      orchidlights: 1,
      console: {
        widgets: [
          {
            type: 'frame',
            caption: 'Boda',
            children: [
              {
                type: 'soloframe',
                caption: 'COLOR',
                children: [{ type: 'button', caption: 'AZUL' }],
              },
            ],
          },
        ],
      },
    })
    const r = await ejecutar(HERRAMIENTAS, 'ver', { nombre: 'AZUL' }, contexto())

    expect(JSON.parse(r.texto)).toEqual({
      widgets: [{ dentroDe: ['Boda', 'COLOR'], type: 'button', caption: 'AZUL' }],
    })
  })

  it('suggests names that look alike when nothing matches', async () => {
    exportar.mockResolvedValue({
      orchidlights: 1,
      functions: [
        { name: 'Paleta AZUL', type: 'Scene' },
        { name: 'Paleta ROJO', type: 'Scene' },
      ],
    })
    const r = await ejecutar(HERRAMIENTAS, 'ver', { nombre: 'azul' }, contexto())
    expect(r.texto).toMatch(/Parecidos: Paleta AZUL/)
  })

  it('exports once per turn, not once per look', async () => {
    exportar.mockResolvedValue({ orchidlights: 1 })
    const c = contexto()
    await ejecutar(HERRAMIENTAS, 'ver', { nombre: 'a' }, c)
    await ejecutar(HERRAMIENTAS, 'ver', { nombre: 'b' }, c)
    expect(exportar).toHaveBeenCalledTimes(1)
  })
})

describe('probar', () => {
  const lectura = {
    universe: 1,
    blackout: false,
    values: [],
    active: [{ channel: 6, value: 255, fixture: 0, fixtureName: 'Par 1', channelName: 'Dimmer' }],
  }

  it('lights the cue, reads what came out, and puts it out again', async () => {
    const client = cliente({
      functions: vi.fn(async () => [{ id: 7, name: 'Azul', type: 'Scene', running: false }]),
      fixtures: vi.fn(async () => [{ id: 0, name: 'Par 1', universe: 1, address: 1, channels: 7 }]),
      dmx: vi.fn(async () => lectura),
    })
    const r = await ejecutar(
      HERRAMIENTAS,
      'probar',
      { funcion: 'Azul', segundos: 0.5 },
      contexto(client),
    )

    expect(r.texto).toMatch(/U1 6 = 255 · Par 1 · Dimmer/)
    expect(client.post).toHaveBeenCalledWith('/functions/7/start')
    expect(client.post).toHaveBeenCalledWith('/functions/7/stop')
  })

  it('leaves running what was already running', async () => {
    const client = cliente({
      functions: vi.fn(async () => [{ id: 7, name: 'Azul', type: 'Scene', running: true }]),
      fixtures: vi.fn(async () => [{ id: 0, name: 'Par 1', universe: 1, address: 1, channels: 7 }]),
      dmx: vi.fn(async () => lectura),
    })
    await ejecutar(HERRAMIENTAS, 'probar', { funcion: 'Azul', segundos: 0.5 }, contexto(client))

    expect(client.post).not.toHaveBeenCalled()
  })
})
