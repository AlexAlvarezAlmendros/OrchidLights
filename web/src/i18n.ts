/**
 * i18n, the infrastructure: one dictionary per language, Spanish as the
 * source of truth (the app is written in it), English as the first
 * translation. Coverage is incremental by design -- the chrome first, the
 * deep editors as they come up -- and a missing key falls back to Spanish,
 * never to a bare identifier: an operator mid-show reads words, not keys.
 *
 * The plan's decision 3: infrastructure plus es/en; the other nine languages
 * of the reference are content, not code.
 */

export type Lang = 'es' | 'en'

const KEY = 'orchid.lang'

export function currentLang(): Lang {
  const stored = localStorage.getItem(KEY)
  return stored === 'en' ? 'en' : 'es'
}

export function setLang(lang: Lang): void {
  localStorage.setItem(KEY, lang)
}

/** Spanish is the key itself: the app's own strings are the dictionary. */
const EN: Record<string, string> = {
  Consola: 'Console',
  Funciones: 'Functions',
  Patch: 'Patch',
  Mesa: 'Desk',
  Planta: 'Plan',
  Escenario: 'Stage',
  Remoto: 'Remote',
  'Acceso desde la red': 'Network access',
  'Código QR de acceso': 'Access QR code',
  'El motor no responde': 'The engine is not answering',
  'El motor escucha en toda la red, pero este equipo no tiene ninguna dirección de red ahora mismo.':
    'The engine listens on the whole network, but this machine has no network address right now.',
  'El motor solo escucha en este equipo': 'The engine only listens on this machine',
  'Para abrirlo a los móviles de la red, arranca el daemon con':
    'To open it to the phones on the network, start the daemon with',
  'La URL lleva la llave de esta mesa: compártela solo con quien deba tocarla.':
    'The URL carries the key to this desk: share it only with someone who should touch it.',
  Conectados: 'Connected',
  'Nadie más está conectado ahora mismo.': 'Nobody else is connected right now.',
  'desde las': 'since',
  'con llave': 'with the key',
  Desconectar: 'Disconnect',
  'Copiar URL': 'Copy URL',
  Copiada: 'Copied',
  Oscuro: 'Dark',
  Pase: 'Show',
  Ajustes: 'Settings',
  Idioma: 'Language',
  Escala: 'Scale',
  Tema: 'Theme',
  'Acerca de': 'About',
  Deshacer: 'Undo',
  Rehacer: 'Redo',
  Guardar: 'Save',
  Nuevo: 'New',
  'Abrir…': 'Open…',
  'Guardar como…': 'Save as…',
  'Importar de otro proyecto…': 'Import from another project…',
  Recientes: 'Recent',
  Abrir: 'Open',
  'Salir del kiosko': 'Leave kiosk',
}

export function t(text: string): string {
  if (currentLang() === 'es') return text
  return EN[text] ?? text
}
