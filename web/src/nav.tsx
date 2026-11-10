/**
 * Where you are in the desk.
 *
 * One component, three shapes, decided by CSS alone: a sidebar with room, a
 * rail of icons with less, and five tabs across the bottom on a phone -- under
 * the thumb, not at the top of the screen next to everything else competing
 * for the same corner. Same markup every time, because they are the same
 * control.
 *
 * The views are grouped by what the operator is there to do (Endsley: organise
 * around goals). Directo is running a show: the console, the raw desk and the
 * plan with the rig lit. Montaje is building one: functions, the patch, the
 * stage in 3D. On a phone there is room for five tabs and no more (Apple's own
 * ceiling, and the point past which a tab bar stops being glanceable), so
 * Montaje folds into one tab that opens onto its three screens -- a section
 * with a name, never a "More" drawer.
 *
 * The theme and the settings are not here. They are not places, and a tab bar
 * that carries actions is a tab bar where a tap sometimes goes somewhere and
 * sometimes does something.
 */

import { t } from './i18n'
import { Glyph, Icon } from './icons'
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
  /* A row of raw faders at equal height: the desk with no abstraction. */
  desk: (
    <>
      <path d="M4 4v16M9 4v16M14 4v16M19 4v16" />
      <path d="M2.5 14h3M7.5 9h3M12.5 17h3M17.5 11h3" />
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
  stage3d: (
    <>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />
      <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
    </>
  ),
  /* A speech bubble with a spark in it: the desk you talk to. */
  assistant: (
    <>
      <path d="M4 5h16v11H10l-4 3.5V16H4z" />
      <path d="M12 7.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" />
    </>
  ),
  /* Waves leaving an antenna: the desk, reachable. */
  remote: (
    <>
      <path d="M12 21v-8" />
      <circle cx="12" cy="11" r="2" />
      <path d="M8.5 7.5a5 5 0 0 1 7 0M5.5 4.5a9 9 0 0 1 13 0" />
    </>
  ),
  /* A wrench over a grid: everything that builds the show. */
  build: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.6" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.6" />
    </>
  ),
}

export const LABELS: Record<View, string> = {
  console: 'Consola',
  functions: 'Funciones',
  setup: 'Patch',
  desk: 'Mesa',
  plan: 'Planta',
  stage3d: 'Escenario',
  remote: 'Dispositivos',
  assistant: 'Asistente',
  build: 'Montaje',
}

/** The building screens, the ones the Montaje tab stands for. */
export const BUILD_VIEWS: View[] = ['functions', 'setup', 'stage3d']

const GROUPS: { title: string | null; views: View[] }[] = [
  { title: 'Directo', views: ['console', 'desk', 'plan'] },
  { title: 'Montaje', views: BUILD_VIEWS },
  { title: null, views: ['assistant'] },
]

/** Every place the navigation can name, in the order it names them. */
export const VIEWS: View[] = GROUPS.flatMap((group) => group.views)

export function Nav({
  view,
  visible,
  onView,
  collapsed = false,
  onCollapse,
}: {
  view: View
  /** What the access mask leaves on offer. The console always is. */
  visible: View[]
  onView: (view: View) => void
  /** The sidebar folded to its icons, by choice. */
  collapsed?: boolean
  onCollapse?: () => void
}) {
  const offered = (target: View) => visible.includes(target)
  const building = BUILD_VIEWS.some(offered)
  const inBuild = view === 'build' || BUILD_VIEWS.includes(view)

  const item = (target: View, className: string, pressed: boolean) => (
    <button
      key={`${className}-${target}`}
      type="button"
      className={`rail-item ${className}`}
      aria-pressed={pressed}
      aria-current={pressed ? 'page' : undefined}
      title={t(LABELS[target])}
      onClick={() => onView(target)}
    >
      <Glyph>{ICONS[target]}</Glyph>
      <span>{t(LABELS[target])}</span>
    </button>
  )

  return (
    <nav className="rail" aria-label="Vistas" data-collapsed={collapsed}>
      {onCollapse !== undefined && (
        <button
          type="button"
          className="rail-toggle icon-button"
          aria-label={collapsed ? 'Mostrar la barra lateral' : 'Plegar la barra lateral'}
          title={collapsed ? 'Mostrar la barra lateral' : 'Plegar la barra lateral'}
          onClick={onCollapse}
        >
          <Icon name="sidebar" />
        </button>
      )}

      {GROUPS.map((group) => {
        const views = group.views.filter(offered)
        if (views.length === 0) return null
        const isBuild = group.views === BUILD_VIEWS
        return (
          <div
            key={group.title ?? 'rest'}
            className="rail-group"
            data-group={isBuild ? 'build' : group.title === null ? 'rest' : 'live'}
          >
            {group.title !== null && <span className="rail-title">{t(group.title)}</span>}
            {views.map((target) =>
              /* The three building screens are sidebar items; on a phone they
                 collapse into the one Montaje tab below. */
              item(target, isBuild ? 'rail-wide' : '', view === target),
            )}
            {isBuild && building && item('build', 'rail-narrow', inBuild)}
          </div>
        )
      })}
    </nav>
  )
}
