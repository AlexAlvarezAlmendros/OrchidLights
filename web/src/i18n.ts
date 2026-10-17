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
  Mover: 'Move',
  Girar: 'Rotate',
  Quitar: 'Remove',
  Colocar: 'Place',
  'Añadir…': 'Add…',
  'Mover el elemento elegido (G)': 'Move the chosen element (G)',
  'Girar el elemento elegido (R)': 'Rotate the chosen element (R)',
  'Quitar del escenario (Supr) — la fixture sigue en el patch':
    'Remove from the stage (Del) — the fixture stays in the patch',
  'Fixture que añadir al escenario': 'Fixture to add to the stage',
  'Clic en un elemento para elegirlo; Ctrl+Z deshace · Ctrl: imán · F: encuadrar':
    'Click an element to choose it; Ctrl+Z undoes · Ctrl: snap · F: frame',
  'moviendo (R: girar)': 'moving (R: rotate)',
  'girando (G: mover)': 'rotating (G: move)',
  'Toca una lámpara para elegirla; en el suelo, apuntan todas las móviles':
    'Tap a lamp to choose it; tap the floor to aim every mover',
  Listo: 'Done',
  Editar: 'Edit',
  Remoto: 'Remote',
  'Acceso desde la red': 'Network access',
  'Código QR de acceso': 'Access QR code',
  'El motor no responde': 'The engine is not answering',
  'El motor escucha en toda la red, pero este equipo no tiene ninguna dirección de red ahora mismo.':
    'The engine listens on the whole network, but this machine has no network address right now.',
  'El motor solo escucha en este equipo': 'The engine only listens on this machine',
  'Para abrirlo a los móviles de la red, arranca el daemon con':
    'To open it to the phones on the network, start the daemon with',
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
  // Paired devices (remote screen)
  Dispositivos: 'Devices',
  'Los dispositivos se emparejan desde el equipo de la mesa, con su llave maestra.':
    "Devices are paired from the desk's own machine, with its master key.",
  Operar: 'Operate',
  Diseñar: 'Design',
  'Llave maestra': 'Master key',
  'Sin llave': 'No key',
  'El motor solo escucha en este equipo: el móvil no llegará hasta arrancarlo con':
    'The engine only listens on this machine: the phone will not reach it until it is started with',
  'Su llave:': 'Its key:',
  'Esta llave solo se enseña ahora: escanéala desde el móvil antes de cerrar.':
    'This key is shown only now: scan it from the phone before closing.',
  Hecho: 'Done',
  Nombre: 'Name',
  'Truss izquierdo': 'Left truss',
  Rol: 'Role',
  Emparejar: 'Pair',
  'Operar: la consola y la mesa simple, bajo la máscara. No edita nada.':
    'Operate: the console and the simple desk, under the mask. Edits nothing.',
  'Diseñar: toda la mesa salvo el disco, el apagado, la máscara y los dispositivos.':
    'Design: the whole desk except the disk, shutdown, the mask and the devices.',
  'El motor solo escucha en este equipo: arráncalo con --listen-all para que lleguen los móviles.':
    'The engine only listens on this machine: start it with --listen-all so phones can reach it.',
  'Ningún dispositivo emparejado todavía.': 'No devices paired yet.',
  'visto a las': 'seen at',
  'sin estrenar': 'never used',
  conectado: 'connected',
  'Rol de': 'Role of',
  '¿Revocar?': 'Revoke?',
  Revocar: 'Revoke',
  'La URL no lleva llave: empareja el móvil abajo para darle la suya.':
    'The URL carries no key: pair the phone below to give it its own.',
}

export function t(text: string): string {
  if (currentLang() === 'es') return text
  return EN[text] ?? text
}
