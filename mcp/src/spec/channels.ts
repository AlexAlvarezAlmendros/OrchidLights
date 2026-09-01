/**
 * Traducir entre «Dimmer» y «el canal 6».
 *
 * Un canal es un número distinto en cada modo —«Dimmer» es el 6 en uno y el 8
 * en otro—, y nadie debería recordarlo a oscuras. Un documento que dice
 * `channel: Dimmer` sobrevive a un cambio de modo y se lee; uno que dice
 * `channel: 6` no sobrevive a nada y no se lee.
 *
 * Pero el nombre solo sirve si es único dentro del modo: hay perfiles con dos
 * canales que se llaman igual, y ahí el número es lo único que no miente. Esta
 * clase decide cuál de los dos usar en cada caso, y no adivina nunca.
 */

import type { OrchidClient } from '../client.js'

export class ChannelNames {
  /** id de fixture → índice de canal → nombre */
  private readonly byIndex = new Map<number, Map<number, string>>()
  /** id de fixture → nombre → índice, solo con los nombres que aparecen una vez */
  private readonly byName = new Map<number, Map<string, number>>()

  private constructor(private readonly client: OrchidClient) {}

  static async of(client: OrchidClient, fixtureIds: Iterable<number>): Promise<ChannelNames> {
    const names = new ChannelNames(client)
    await Promise.all([...new Set(fixtureIds)].map((id) => names.load(id)))
    return names
  }

  private async load(id: number) {
    if (this.byIndex.has(id)) return

    let channels: { index: number; name: string }[] = []
    try {
      const fixture = await this.client.fixture(id)
      channels = fixture.channelList ?? []
    } catch {
      // Una fixture cuyo perfil no está en esta instalación no tiene canales
      // que nombrar. Se queda con números, que es lo honesto.
    }

    const indexed = new Map<number, string>()
    const counts = new Map<string, number>()
    for (const channel of channels) {
      indexed.set(channel.index, channel.name)
      counts.set(channel.name, (counts.get(channel.name) ?? 0) + 1)
    }

    const named = new Map<string, number>()
    for (const channel of channels) {
      if (counts.get(channel.name) === 1) named.set(channel.name, channel.index)
    }

    this.byIndex.set(id, indexed)
    this.byName.set(id, named)
  }

  /** Cómo escribir este canal en el documento: por nombre si se puede, si no por número. */
  write(fixtureId: number, index: number): string | number {
    const name = this.byIndex.get(fixtureId)?.get(index)
    if (name === undefined) return index
    // Solo por nombre si ese nombre vuelve a este mismo canal. Si no, el
    // documento diría algo que al aplicarlo apuntaría a otro sitio.
    return this.byName.get(fixtureId)?.get(name) === index ? name : index
  }

  /** Y de vuelta. `undefined` cuando el documento nombra un canal que esa fixture no tiene. */
  read(fixtureId: number, channel: string | number): number | undefined {
    if (typeof channel === 'number') {
      return this.byIndex.get(fixtureId)?.has(channel) === false && this.byIndex.has(fixtureId)
        ? undefined
        : channel
    }
    return this.byName.get(fixtureId)?.get(channel)
  }

  /** Los nombres que esta fixture sí tiene, para decirlo cuando el documento falla. */
  known(fixtureId: number): string[] {
    return [...(this.byName.get(fixtureId)?.keys() ?? [])]
  }
}
