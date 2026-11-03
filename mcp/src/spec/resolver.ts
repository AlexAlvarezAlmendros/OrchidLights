/**
 * Nombres a identificadores, con la caché puesta donde hace falta.
 *
 * Los ids los reparte el motor —el hueco libre más bajo—, así que un documento
 * no puede escribirlos y el aplicador tiene que preguntarlos. Preguntarlos en
 * cada paso serían tres llamadas por escena; no preguntarlos nunca sería
 * resolver contra un proyecto que ya ha cambiado, porque este mismo lote acaba
 * de crear cosas.
 *
 * De ahí el trato: se cachea, y crear algo invalida.
 */

import type { Fixture, FixtureGroup, FunctionSummary, OrchidClient } from '../client.js'

export class Resolver {
  private fixtures: Map<string, Fixture> | undefined
  private functions: Map<string, FunctionSummary> | undefined
  private groups: Map<string, FixtureGroup> | undefined

  constructor(private readonly client: OrchidClient) {}

  /** Algo nuevo existe: lo que estuviera cacheado ya no es el proyecto. */
  invalidate() {
    this.fixtures = undefined
    this.functions = undefined
    this.groups = undefined
  }

  async fixture(name: string): Promise<Fixture> {
    this.fixtures ??= new Map((await this.client.fixtures()).map((f) => [f.name, f]))
    const found = this.fixtures.get(name)
    if (found === undefined) throw new Error(`no hay ninguna fixture llamada "${name}"`)
    return found
  }

  async fixtureIds(names: string[]): Promise<number[]> {
    const resolved = await Promise.all(names.map((name) => this.fixture(name)))
    return resolved.map((fixture) => fixture.id)
  }

  async fn(name: string): Promise<FunctionSummary> {
    this.functions ??= new Map((await this.client.functions()).map((f) => [f.name, f]))
    const found = this.functions.get(name)
    if (found === undefined) throw new Error(`no hay ninguna función llamada "${name}"`)
    return found
  }

  async functionId(name: string): Promise<number> {
    return (await this.fn(name)).id
  }

  async group(name: string): Promise<FixtureGroup> {
    this.groups ??= new Map((await this.client.fixtureGroups()).map((g) => [g.name, g]))
    const found = this.groups.get(name)
    if (found === undefined) throw new Error(`no hay ningún grupo llamado "${name}"`)
    return found
  }
}
