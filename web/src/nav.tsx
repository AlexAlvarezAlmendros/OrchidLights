/**
 * Where you are in the desk.
 *
 * One component, two shapes, decided by CSS alone: a rail down the left where
 * there is room, and a bar across the bottom where there is not. Same markup
 * either way, because they are the same control — and because a phone's
 * navigation belongs under the thumb, not at the top of the screen next to
 * everything else that is competing for the same corner.
 *
 * The icons are drawn rather than set in type. An emoji is a different picture
 * on every platform and a different weight from the text beside it; these are
 * one stroke width on one grid, and they take the colour of whatever state
 * they are in.
 */

import type { View } from './views'

const ICONS: Record<View, React.ReactNode> = {
  /* Faders: what the console is. */
  console: (
    <>
      <path d="M6 3v6M6 15v6M12 3v10M12 19v2M18 3v2M18 11v10" />
      <path d="M4 11h4M10 15h4M16 7h4" />
    </>
  ),
  /* A stack of cues, one of them running. */
  functions: (
    <>
      <rect x="3" y="4" width="18" height="5" rx="1.5" />
      <rect x="3" y="12" width="18" height="5" rx="1.5" />
      <path d="M7 20h10" />
    </>
  ),
  /* Sockets in a row: the patch. */
  setup: (
    <>
      <rect x="3" y="8" width="18" height="9" rx="2" />
      <path d="M7 8V5M12 8V5M17 8V5" />
    </>
  ),
  /* Lamps over a stage. */
  plan: (
    <>
      <path d="M4 6h16" />
      <path d="M8 6v3M16 6v3" />
      <path d="M8 12a3 3 0 1 0 0 .01M16 12a3 3 0 1 0 0 .01" />
      <path d="M4 19h16" />
    </>
  ),
}

const LABELS: Record<View, string> = {
  console: 'Consola',
  functions: 'Funciones',
  setup: 'Patch',
  plan: 'Planta',
}

export const VIEWS: View[] = ['console', 'functions', 'setup', 'plan']

export function Nav({
  view,
  theme,
  onView,
  onTheme,
}: {
  view: View
  theme: 'stage' | 'blackout'
  onView: (view: View) => void
  onTheme: () => void
}) {
  return (
    <nav className="rail" aria-label="Vistas">
      {VIEWS.map((target) => (
        <button
          key={target}
          type="button"
          className="rail-item"
          aria-pressed={view === target}
          onClick={() => onView(target)}
        >
          <Glyph>{ICONS[target]}</Glyph>
          <span>{LABELS[target]}</span>
        </button>
      ))}

      <span className="rail-gap" />

      <button
        type="button"
        className="rail-item"
        aria-pressed={theme === 'blackout'}
        onClick={onTheme}
        title="Modo seguro para la oscuridad"
      >
        <Glyph>
          {theme === 'stage' ? (
            <path d="M20 13a8 8 0 1 1-9-9 6.5 6.5 0 0 0 9 9z" />
          ) : (
            <>
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" />
            </>
          )}
        </Glyph>
        <span>{theme === 'stage' ? 'Oscuro' : 'Pase'}</span>
      </button>
    </nav>
  )
}

/** One 24-grid stroke icon. Nothing filled: a filled glyph reads as a state
 *  here, and these are labels. */
function Glyph({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
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
