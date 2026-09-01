/**
 * Dónde está la mesa y con qué llave se entra.
 *
 * La carcasa de escritorio pide el 9998 y se conforma con cualquier puerto
 * libre si ese está ocupado, así que un registro de MCP que lo llevara escrito
 * —`ORCHID_URL=http://127.0.0.1:9998`— funcionaría hasta el día que no. Por eso
 * la carcasa deja escrito dónde acabó, y esto lo lee: el comando que se registra
 * una vez sirve para siempre.
 *
 * El orden es el de siempre: lo que se pide a mano gana, después lo que dejó
 * quien arrancó la mesa, y al final el sitio por defecto.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Donde el daemon guarda su token y la carcasa deja su URL. */
export function userDirectory(): string {
  return join(homedir(), '.orchidlights')
}

function readLine(path: string): string | undefined {
  try {
    const text = readFileSync(path, 'utf8').trim()
    return text.length > 0 ? text : undefined
  } catch {
    // No estar no es un fallo: en loopback no hace falta token, y sin carcasa
    // no hay fichero de URL.
    return undefined
  }
}

export const DEFAULT_URL = 'http://127.0.0.1:9998'

/**
 * La URL base de la mesa.
 *
 * `$ORCHID_URL`, luego `~/.orchidlights/desktop-url` —lo que dejó la carcasa al
 * arrancar el daemon—, y si no, donde el daemon escucha por defecto.
 */
export function deskUrl(): string {
  // Vacía cuenta como ausente. `??` solo cede ante null, así que un
  // `ORCHID_URL=` en el entorno -- que es como se pide "usa el de siempre" --
  // se convertía en la URL base, y las peticiones salían a "/api/v1" como si
  // fuera una ruta relativa. Sin navegador detrás eso no es nada.
  return process.env.ORCHID_URL || readLine(join(userDirectory(), 'desktop-url')) || DEFAULT_URL
}

/**
 * El token, si hay.
 *
 * En loopback el daemon no pide nada, así que no encontrarlo es el caso normal
 * y no se avisa de ello. Fuera de loopback lo exige, y entonces el error que da
 * dice qué falta.
 */
export function deskToken(): string | undefined {
  return process.env.ORCHID_TOKEN || readLine(join(userDirectory(), 'api-token'))
}

/** Las opciones con las que se construye un cliente, ya resueltas. */
export function deskOptions(): { baseUrl: string; token?: string } {
  const token = deskToken()
  return token === undefined ? { baseUrl: deskUrl() } : { baseUrl: deskUrl(), token }
}
