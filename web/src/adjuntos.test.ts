/**
 * Attachments: the arithmetic of scaling and the encoding. Drawing on a canvas
 * is the browser's, and jsdom has none to test against.
 */

import { describe, expect, it } from 'vitest'
import { LADO_MAXIMO, base64, medidas } from './adjuntos'

describe('medidas', () => {
  it('scales the longest side down to the limit, keeping proportions', () => {
    expect(medidas(4032, 3024)).toEqual({ ancho: LADO_MAXIMO, alto: 1536 })
    expect(medidas(3024, 4032)).toEqual({ ancho: 1536, alto: LADO_MAXIMO })
  })

  it('never enlarges a small image', () => {
    expect(medidas(800, 600)).toEqual({ ancho: 800, alto: 600 })
  })

  it('takes another limit, for thumbnails', () => {
    expect(medidas(4000, 2000, 160)).toEqual({ ancho: 160, alto: 80 })
  })
})

describe('base64', () => {
  it('encodes like the browser does', () => {
    expect(base64(new TextEncoder().encode('OrchidLights'))).toBe(btoa('OrchidLights'))
  })

  it('survives buffers far bigger than one call can take', () => {
    /* Several of the 32 KB slices, with a ragged last one. */
    const bytes = new Uint8Array(200_003).map((_, i) => i % 251)
    const texto = base64(bytes)
    const vuelta = Uint8Array.from(atob(texto), (c) => c.charCodeAt(0))
    expect(vuelta).toEqual(bytes)
  })
})
