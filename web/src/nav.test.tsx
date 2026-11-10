/**
 * The rail, from the operator's side of the glass.
 *
 * What matters here is not how the rail is drawn but what it offers: only the
 * views the access mask left on the table, the current one announced to
 * assistive tech, and a tap landing on the view it named. The labels go
 * through i18n because a rented desk in another country still has to read.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Nav, VIEWS } from './nav'
import type { View } from './views'

function renderNav(over: Partial<React.ComponentProps<typeof Nav>> = {}) {
  const props: React.ComponentProps<typeof Nav> = {
    view: 'console',
    visible: VIEWS,
    onView: vi.fn(),
    ...over,
  }
  return { ...render(<Nav {...props} />), props }
}

beforeEach(() => {
  /* i18n reads the language from localStorage; tests must not inherit the
     previous test's choice. */
  localStorage.clear()
})

describe('which views are on offer', () => {
  it('paints only the views the access mask allows', () => {
    renderNav({ visible: ['console', 'desk'] })

    expect(screen.getByRole('button', { name: 'Consola' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Mesa' })).toBeInTheDocument()

    /* A kiosk client must not even see the doors it cannot open. */
    for (const hidden of ['Funciones', 'Patch', 'Planta', 'Escenario', 'Montaje']) {
      expect(screen.queryByRole('button', { name: hidden })).toBeNull()
    }
  })

  it('offers no more than five places on a phone', () => {
    /* The phone's tab bar is everything that is not a sidebar-only item.
       Apple's ceiling is five, and it is the point past which a tab bar stops
       being something you can hit without looking. */
    renderNav({ visible: [...VIEWS, 'remote'] })
    const tabs = screen.getAllByRole('button').filter((b) => !b.className.includes('rail-wide'))
    const places = tabs.filter((b) => !b.className.includes('rail-toggle'))
    expect(places.map((b) => b.textContent)).toEqual([
      'Consola',
      'Mesa',
      'Planta',
      'Montaje',
      'Asistente',
    ])
  })

  it('folds the three building screens into Montaje, which reads as current on any of them', () => {
    renderNav({ view: 'setup' })
    expect(screen.getByRole('button', { name: 'Montaje' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Patch' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Funciones' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('names the devices screen nowhere in the navigation: it lives in Ajustes', () => {
    renderNav({ visible: [...VIEWS, 'remote'] })
    expect(screen.queryByRole('button', { name: 'Dispositivos' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remoto' })).toBeNull()
  })

  it('keeps the rail order fixed regardless of the order the mask arrives in', () => {
    // The mask says what is allowed, never where it sits: an operator's muscle
    // memory survives a permissions change.
    const backwards: View[] = ['assistant', 'functions', 'desk', 'console']
    renderNav({ visible: backwards })

    const labels = screen.getAllByRole('button').map((b) => b.textContent)
    expect(labels.indexOf('Consola')).toBeLessThan(labels.indexOf('Mesa'))
    expect(labels.indexOf('Mesa')).toBeLessThan(labels.indexOf('Funciones'))
    expect(labels.indexOf('Funciones')).toBeLessThan(labels.indexOf('Asistente'))
  })
})

describe('the active view', () => {
  it('announces the current view as pressed and the rest as not', () => {
    renderNav({ view: 'desk' })

    expect(screen.getByRole('button', { name: 'Mesa' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Consola' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Planta' })).toHaveAttribute('aria-pressed', 'false')
  })
})

describe('what a tap does', () => {
  it('reports the view that was tapped, exactly once', async () => {
    const user = userEvent.setup()
    const { props } = renderNav({ view: 'console' })

    await user.click(screen.getByRole('button', { name: 'Planta' }))

    expect(props.onView).toHaveBeenCalledTimes(1)
    expect(props.onView).toHaveBeenCalledWith('plan')
  })

  it('carries no actions: settings and the theme are not places', () => {
    renderNav()
    for (const action of ['Ajustes', 'Oscuro', 'Pase']) {
      expect(screen.queryByRole('button', { name: action })).toBeNull()
    }
  })

  it('folds the sidebar to its icons and back', async () => {
    const user = userEvent.setup()
    const onCollapse = vi.fn()
    const first = renderNav({ onCollapse })
    await user.click(screen.getByRole('button', { name: 'Plegar la barra lateral' }))
    expect(onCollapse).toHaveBeenCalledTimes(1)
    first.unmount()

    renderNav({ onCollapse, collapsed: true })
    expect(screen.getByRole('navigation')).toHaveAttribute('data-collapsed', 'true')
    expect(screen.getByRole('button', { name: 'Mostrar la barra lateral' })).toBeInTheDocument()
  })
})

describe('the labels speak the desk language', () => {
  it('renders the rail in English when the operator chose English', () => {
    localStorage.setItem('orchid.lang', 'en')
    renderNav({ visible: ['console', 'functions', 'desk', 'plan', 'assistant'] })

    for (const label of ['Console', 'Build', 'Functions', 'Desk', 'Plan', 'Assistant']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
    // The group headings too.
    expect(screen.getByText('Live')).toBeInTheDocument()
  })

  // Regression: 'Escenario' landed after the EN dictionary and shipped
  // untranslated between otherwise-translated rail labels.
  it('translates every visible rail label, stage3d included', () => {
    localStorage.setItem('orchid.lang', 'en')
    renderNav({ visible: VIEWS })

    // Fails today: the button renders 'Escenario', the Spanish fallback.
    expect(screen.getByRole('button', { name: 'Stage' })).toBeInTheDocument()
  })
})
