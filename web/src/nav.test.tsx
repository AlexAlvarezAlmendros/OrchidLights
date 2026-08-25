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
    theme: 'stage',
    visible: VIEWS,
    onView: vi.fn(),
    onTheme: vi.fn(),
    onSettings: vi.fn(),
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
    for (const hidden of ['Funciones', 'Patch', 'Planta', 'Escenario', 'Remoto']) {
      expect(screen.queryByRole('button', { name: hidden })).toBeNull()
    }
  })

  it('keeps the rail order fixed regardless of the order the mask arrives in', () => {
    // The mask says what is allowed, never where it sits: an operator's muscle
    // memory survives a permissions change.
    const backwards: View[] = ['remote', 'desk', 'console']
    renderNav({ visible: backwards })

    const labels = screen.getAllByRole('button').map((b) => b.textContent)
    expect(labels.indexOf('Consola')).toBeLessThan(labels.indexOf('Mesa'))
    expect(labels.indexOf('Mesa')).toBeLessThan(labels.indexOf('Remoto'))
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

  it('keeps the settings and theme buttons out of the view callback', async () => {
    const user = userEvent.setup()
    const { props } = renderNav()

    await user.click(screen.getByRole('button', { name: 'Ajustes' }))
    await user.click(screen.getByRole('button', { name: 'Oscuro' }))

    expect(props.onView).not.toHaveBeenCalled()
    expect(props.onSettings).toHaveBeenCalledTimes(1)
    expect(props.onTheme).toHaveBeenCalledTimes(1)
  })

  it('shows the theme toggle as the way OUT of the current theme', () => {
    // In stage theme the button offers the dark mode; in blackout it offers
    // the way back, and reads as engaged.
    const first = renderNav({ theme: 'stage' })
    expect(screen.getByRole('button', { name: 'Oscuro' })).toHaveAttribute('aria-pressed', 'false')
    first.unmount()

    renderNav({ theme: 'blackout' })
    expect(screen.getByRole('button', { name: 'Pase' })).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('the labels speak the desk language', () => {
  it('renders the rail in English when the operator chose English', () => {
    localStorage.setItem('orchid.lang', 'en')
    renderNav({ visible: ['console', 'functions', 'desk', 'plan', 'remote'] })

    for (const label of ['Console', 'Functions', 'Desk', 'Plan', 'Remote', 'Settings']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
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
