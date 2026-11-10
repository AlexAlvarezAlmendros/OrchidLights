/**
 * Every icon in the desk, on one grid and one stroke.
 *
 * A character used as an icon -- an arrow, a play triangle, an emoji -- is a
 * different picture on every platform, in a different weight from the text
 * beside it, and sometimes a different picture altogether: the dump button's
 * download arrow came out as an exclamation mark in the font the desktop shell
 * falls back to. These are drawn: a 24-unit grid, a 1.7 stroke, round caps,
 * and the colour of whatever state they are in.
 *
 * Outline by default, because an outline is a label and a fill reads as a
 * state. The transport glyphs (play, stop, pause, skip) are the exception and
 * are drawn filled, because that is what every transport in the world does and
 * an outlined play triangle reads as "disabled".
 */

const PATHS = {
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  undo: (
    <>
      <path d="M9 14.5L4.5 10 9 5.5" />
      <path d="M4.5 10h10a5 5 0 0 1 0 10H11" />
    </>
  ),
  redo: (
    <>
      <path d="M15 14.5l4.5-4.5L15 5.5" />
      <path d="M19.5 10h-10a5 5 0 0 0 0 10H13" />
    </>
  ),
  /* Into a tray: what the desk holds, poured into a scene. */
  dump: (
    <>
      <path d="M12 4v10.5" />
      <path d="M7.5 10.5L12 15l4.5-4.5" />
      <path d="M4.5 15.5v2A1.5 1.5 0 0 0 6 19h12a1.5 1.5 0 0 0 1.5-1.5v-2" />
    </>
  ),
  chevronDown: <path d="M6.5 9.5l5.5 5.5 5.5-5.5" />,
  chevronUp: <path d="M6.5 14.5L12 9l5.5 5.5" />,
  chevronRight: <path d="M9.5 6.5l5.5 5.5-5.5 5.5" />,
  chevronLeft: <path d="M14.5 6.5L9 12l5.5 5.5" />,
  arrowUp: <path d="M12 19V5.5M6.5 11L12 5.5 17.5 11" />,
  arrowDown: <path d="M12 5v13.5M6.5 13l5.5 5.5 5.5-5.5" />,
  arrowsH: <path d="M4 12h16M7.5 8.5L4 12l3.5 3.5M16.5 8.5L20 12l-3.5 3.5" />,
  arrowsV: <path d="M12 4v16M8.5 7.5L12 4l3.5 3.5M8.5 16.5L12 20l3.5-3.5" />,
  swap: <path d="M4.5 8.5h14l-3.5-3.5M19.5 15.5h-14l3.5 3.5" />,
  rotate: (
    <>
      <path d="M19 12a7 7 0 1 1-2.05-4.95" />
      <path d="M19 4.5V8h-3.5" />
    </>
  ),
  alignRow: (
    <>
      <path d="M3.5 12h17" />
      <circle cx="7" cy="12" r="1.9" />
      <circle cx="12" cy="12" r="1.9" />
      <circle cx="17" cy="12" r="1.9" />
    </>
  ),
  alignColumn: (
    <>
      <path d="M12 3.5v17" />
      <circle cx="12" cy="7" r="1.9" />
      <circle cx="12" cy="12" r="1.9" />
      <circle cx="12" cy="17" r="1.9" />
    </>
  ),
  distributeH: (
    <>
      <path d="M4.5 5v14M19.5 5v14" />
      <rect x="9.5" y="8" width="5" height="8" rx="1.2" />
    </>
  ),
  distributeV: (
    <>
      <path d="M5 4.5h14M5 19.5h14" />
      <rect x="8" y="9.5" width="8" height="5" rx="1.2" />
    </>
  ),
  reset: (
    <>
      <path d="M5 12a7 7 0 1 0 2.05-4.95" />
      <path d="M5 4.5V8h3.5" />
    </>
  ),
  folder: (
    <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" />
  ),
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="9.5" rx="2.2" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
    </>
  ),
  unlock: (
    <>
      <rect x="5" y="10.5" width="14" height="9.5" rx="2.2" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 6.8-1.2" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 7h15" />
      <path d="M9.5 7V5h5v2" />
      <path d="M6.5 7l.9 12h9.2l.9-12" />
    </>
  ),
  warning: (
    <>
      <path d="M12 4.5l8.5 15h-17z" />
      <path d="M12 10.5v4M12 17.3v.2" />
    </>
  ),
  volume: (
    <>
      <path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z" />
      <path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.8 7.8 0 0 1 0 11" />
    </>
  ),
  mute: (
    <>
      <path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z" />
      <path d="M15.5 9.5l5 5M20.5 9.5l-5 5" />
    </>
  ),
  timer: (
    <>
      <circle cx="12" cy="13" r="7.5" />
      <path d="M12 9.5V13M10 3.5h4" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14.2 3h-4l-.4 2.7a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2l.4 2.7h4l.4-2.7a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z" />
    </>
  ),
  more: (
    <>
      <circle cx="6" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12" r="1.3" fill="currentColor" stroke="none" />
    </>
  ),
  sidebar: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
      <path d="M9.5 5v14" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4 4" />
    </>
  ),
  moon: <path d="M20 13a8 8 0 1 1-9-9 6.5 6.5 0 0 0 9 9z" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" />
    </>
  ),
  devices: (
    <>
      <rect x="3" y="5" width="13" height="10" rx="1.8" />
      <path d="M7 19h5M9.5 15v4" />
      <rect x="17.5" y="9" width="4" height="10" rx="1.2" />
    </>
  ),
  /* Transport, filled. */
  play: <path d="M8 5.8v12.4a.8.8 0 0 0 1.2.7l10-6.2a.8.8 0 0 0 0-1.4l-10-6.2A.8.8 0 0 0 8 5.8z" />,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2" />,
  pause: (
    <>
      <rect x="6.5" y="5.5" width="4" height="13" rx="1.2" />
      <rect x="13.5" y="5.5" width="4" height="13" rx="1.2" />
    </>
  ),
  previous: (
    <>
      <rect x="5.5" y="6" width="2.6" height="12" rx="1" />
      <path d="M18.5 6.8v10.4a.8.8 0 0 1-1.2.7l-8-5.2a.8.8 0 0 1 0-1.4l8-5.2a.8.8 0 0 1 1.2.7z" />
    </>
  ),
  next: (
    <>
      <rect x="15.9" y="6" width="2.6" height="12" rx="1" />
      <path d="M5.5 6.8v10.4a.8.8 0 0 0 1.2.7l8-5.2a.8.8 0 0 0 0-1.4l-8-5.2a.8.8 0 0 0-1.2.7z" />
    </>
  ),
} as const

export type IconName = keyof typeof PATHS

const FILLED: ReadonlySet<IconName> = new Set(['play', 'stop', 'pause', 'previous', 'next'])

/** One icon. Decorative by default: the button around it carries the name. */
export function Icon({
  name,
  size = 20,
  label,
}: {
  name: IconName
  size?: number
  /** Only when the icon stands alone and nothing else names it. */
  label?: string
}) {
  const filled = FILLED.has(name)
  const paint = {
    className: 'icon',
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: filled ? 'currentColor' : 'none',
    stroke: filled ? 'none' : 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  } as const

  if (label !== undefined) {
    return (
      <svg {...paint} role="img" aria-label={label}>
        <title>{label}</title>
        {PATHS[name]}
      </svg>
    )
  }

  return (
    <svg {...paint} aria-hidden="true">
      {PATHS[name]}
    </svg>
  )
}

/** The raw grid, for the navigation's own drawings. */
export function Glyph({ children, size = 22 }: { children: React.ReactNode; size?: number }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}
