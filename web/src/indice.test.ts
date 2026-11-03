/**
 * The outline the assistant starts from: everything it needs to find its way,
 * nothing it can ask for later.
 */

import type { OrchidClient } from '@orchid/mcp/client'
import { describe, expect, it } from 'vitest'
import { outline } from './indice'

function cliente(vc: unknown = null): OrchidClient {
  return {
    project: async () => ({
      path: '/x/boda.qxw',
      name: 'boda.qxw',
      directory: '/x',
      modified: true,
      startupFunction: -1,
    }),
    fixtures: async () => [
      {
        id: 0,
        name: 'Wash IZQ',
        manufacturer: 'Shehds',
        model: 'Wash Zoom',
        mode: '12 Channel',
        universe: 1,
        address: 1,
        channels: 12,
      },
      { id: 1, name: 'Humo', universe: 1, address: 161, channels: 1, resolved: false },
    ],
    functions: async () => [
      { id: 10, name: 'BOSQUE', type: 'Collection', path: 'Looks', running: true },
      { id: 11, name: 'Paleta AZUL', type: 'Scene', path: 'Paletas' },
    ],
    universes: async () => [
      {
        id: 1,
        name: 'Capilla',
        outputs: [{ plugin: 'ArtNet', line: 'eth0' }],
        input: { plugin: 'MIDI', line: 'BCF', profile: 'Behringer BCF2000' },
      },
    ],
    plan: async () => ({
      grid: { width: 6, height: 6, depth: 11, units: 'meters' },
      background: false,
      pointOfView: 'front',
      fixtures: [
        {
          id: 0,
          name: 'Wash IZQ',
          universe: 1,
          address: 1,
          channels: 12,
          x: 1700,
          y: 4500,
          z: 1000,
          rotation: 180,
          invertTilt: true,
        },
      ],
    }),
    fixtureGroups: async () => [{ id: 0, name: 'Washes', fixtures: [0] }],
    get: async () => {
      if (vc === null) throw new Error('404')
      return vc
    },
  } as unknown as OrchidClient
}

describe('outline', () => {
  it('tells the patch, the stage, the groups and what is running', async () => {
    const text = await outline(cliente())

    expect(text).toContain('Proyecto «boda.qxw» · con cambios sin guardar')
    expect(text).toContain('Escenario: 6 × 11 × 6 meters (ancho × fondo × alto)')
    expect(text).toContain(
      '- 1 «Capilla» · salida ArtNet/eth0 · entrada MIDI/BCF (perfil Behringer BCF2000)',
    )
    expect(text).toContain(
      '- «Wash IZQ» · Shehds Wash Zoom · 12 Channel · 12 canales · U1 @1-12 · en x=1700 y=4500 z=1000 giro 180° colgado',
    )
    expect(text).toContain(
      '- «Humo» · genérico · 1 canales · U1 @161-161 · sin colocar · PERFIL NO ENCONTRADO',
    )
    expect(text).toContain('- «Washes»: Wash IZQ')
    expect(text).toContain('- Looks: BOSQUE [Collection, CORRIENDO]')
    expect(text).toContain('- Paletas: Paleta AZUL [Scene]')
    expect(text).toContain('Consola:\n- (vacía)')
  })

  it('draws the console as a tree, naming functions and leaving out what is default', async () => {
    const text = await outline(
      cliente({
        type: 'virtualconsole',
        children: [
          {
            type: 'soloframe',
            caption: 'COLOR',
            children: [
              {
                type: 'button',
                caption: 'AZUL',
                functionId: 11,
                action: 'Override',
                background: '#1e3a8a',
              },
              { type: 'button', caption: 'BOSQUE', functionId: 10, action: 'Toggle' },
              { type: 'button', caption: 'STOP ALL', functionId: 4294967295, action: 'StopAll' },
            ],
          },
        ],
      }),
    )

    expect(text).toContain(
      [
        '- [soloframe] «COLOR»',
        '  - [button] «AZUL» → Paleta AZUL (Override) #1e3a8a',
        '  - [button] «BOSQUE» → BOSQUE',
        '  - [button] «STOP ALL» (StopAll)',
      ].join('\n'),
    )
  })
})
