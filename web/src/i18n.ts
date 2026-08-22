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
