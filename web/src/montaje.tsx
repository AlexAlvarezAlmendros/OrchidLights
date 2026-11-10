/**
 * Montaje, on a phone: one tab that opens onto the screens that build a show.
 *
 * A phone has room for five tabs, and the desk has more places than that. The
 * answer Apple gives is not a "More" tab -- a drawer of leftovers with no name
 * -- but a section that says what it holds, laid out the way Settings is: one
 * row per screen, a line under each saying what is there right now, and a
 * chevron that says it goes somewhere.
 */

import { t } from './i18n'
import { Icon } from './icons'
import { LABELS } from './nav'
import type { View } from './views'

export function Montaje({
  visible,
  counts,
  onView,
}: {
  visible: View[]
  counts: { functions: number; fixtures: number }
  onView: (view: View) => void
}) {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

  const rows: { view: View; detail: string }[] = [
    { view: 'functions', detail: plural(counts.functions, 'función', 'funciones') },
    { view: 'setup', detail: plural(counts.fixtures, 'fixture parcheada', 'fixtures parcheadas') },
    { view: 'stage3d', detail: 'El rig en tres dimensiones' },
  ]

  const offered = rows.filter((row) => visible.includes(row.view))

  return (
    <section className="hub" aria-label={t('Montaje')}>
      <h1 className="screen-title">{t('Montaje')}</h1>
      {offered.length === 0 ? (
        <p className="empty">Este dispositivo no puede montar el show.</p>
      ) : (
        <ul className="list" data-inset="true">
          {offered.map((row) => (
            <li key={row.view}>
              <button type="button" className="list-row" onClick={() => onView(row.view)}>
                <span className="list-text">
                  <strong>{t(LABELS[row.view])}</strong>
                  <span>{row.detail}</span>
                </span>
                <Icon name="chevronRight" size={18} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
