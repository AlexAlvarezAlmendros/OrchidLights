/**
 * Photos of the room, floor plans and photos of lamps, made ready to send.
 *
 * A phone's photo is 12 MP and several megabytes; sent as is, it crosses the
 * venue's wifi as base64 and the model reads no more out of it than out of a
 * 2048-pixel copy. So images are scaled down here, in the browser, before
 * they go anywhere. A plan that is already small enough goes untouched:
 * re-encoding a line drawing as JPEG only blurs its labels.
 *
 * PDFs go as they are. Anthropic reads them natively; the OpenAI dialect does
 * not, and the composer says so instead of sending one into the void.
 */

export type MediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | 'application/pdf'

export interface Adjunto {
  nombre: string
  mediaType: MediaType
  /** Base64, no data: prefix. */
  datos: string
  /** A small data URL for the conversation, when the browser can draw one. */
  miniatura?: string
}

/** The longest side an image is sent at. */
export const LADO_MAXIMO = 2048

/** An image this light and this small is sent untouched. */
const LIGERA = 3 * 1024 * 1024

/** PDFs past this are refused here rather than by the provider, minutes later. */
export const PDF_MAXIMO = 20 * 1024 * 1024

const IMAGENES: MediaType[] = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

/** The size an image is sent at: proportions kept, nothing enlarged. */
export function medidas(ancho: number, alto: number, maximo = LADO_MAXIMO) {
  const escala = Math.min(1, maximo / Math.max(ancho, alto))
  return { ancho: Math.round(ancho * escala), alto: Math.round(alto * escala) }
}

export function base64(bytes: Uint8Array): string {
  /* In slices: String.fromCharCode over a few megabytes at once overflows the
     argument stack. */
  let texto = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    texto += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(texto)
}

async function blobBase64(blob: Blob): Promise<string> {
  return base64(new Uint8Array(await blob.arrayBuffer()))
}

function lienzo(ancho: number, alto: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = ancho
  canvas.height = alto
  return canvas
}

function aBlob(canvas: HTMLCanvasElement, tipo: string, calidad: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('No se pudo codificar la imagen'))),
      tipo,
      calidad,
    ),
  )
}

export async function prepararAdjunto(archivo: File): Promise<Adjunto> {
  if (archivo.type === 'application/pdf') {
    if (archivo.size > PDF_MAXIMO) {
      throw new Error(`«${archivo.name}» pesa más de ${PDF_MAXIMO / 1024 / 1024} MB`)
    }
    return { nombre: archivo.name, mediaType: 'application/pdf', datos: await blobBase64(archivo) }
  }

  if (!IMAGENES.includes(archivo.type as MediaType)) {
    throw new Error(`«${archivo.name}» no es una imagen ni un PDF`)
  }

  const imagen = await createImageBitmap(archivo)
  try {
    const destino = medidas(imagen.width, imagen.height)
    const cabe = destino.ancho === imagen.width && archivo.size <= LIGERA

    const mini = medidas(imagen.width, imagen.height, 160)
    const pequeña = lienzo(mini.ancho, mini.alto)
    pequeña.getContext('2d')?.drawImage(imagen, 0, 0, mini.ancho, mini.alto)
    const miniatura = pequeña.toDataURL('image/jpeg', 0.7)

    if (cabe) {
      return {
        nombre: archivo.name,
        mediaType: archivo.type as MediaType,
        datos: await blobBase64(archivo),
        miniatura,
      }
    }

    const grande = lienzo(destino.ancho, destino.alto)
    grande.getContext('2d')?.drawImage(imagen, 0, 0, destino.ancho, destino.alto)
    return {
      nombre: archivo.name,
      mediaType: 'image/jpeg',
      datos: await blobBase64(await aBlob(grande, 'image/jpeg', 0.88)),
      miniatura,
    }
  } finally {
    imagen.close()
  }
}
