/**
 * The desk's own controls, from the operator's side.
 *
 * What these promise is behaviour the browser's versions did not have: a
 * question drawn inside the theme that answers with a promise, a sheet that
 * Escape and the dimmed page both cancel and that hands focus back, a popover
 * the keyboard can leave, a toast whose errors wait to be read.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { litOnLight } from './App'
import { Segmented, Sheet, Toast, dialogo, useDismiss } from './ui'

afterEach(() => {
  vi.useRealTimers()
})

describe('the sheet', () => {
  it('is a modal dialog with its name, and Escape is Cancel', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <Sheet label="Ajustes" onClose={onClose}>
        <button type="button">Dentro</button>
      </Sheet>,
    )

    const sheet = screen.getByRole('dialog', { name: 'Ajustes' })
    expect(sheet).toHaveAttribute('aria-modal', 'true')
    // Focus starts inside: on the sheet itself, not on whatever control
    // happens to come first.
    expect(sheet).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('cancels on a press on the dimmed page, not on its own content', () => {
    const onClose = vi.fn()
    render(
      <Sheet label="Algo" onClose={onClose}>
        <p>Contenido</p>
      </Sheet>,
    )

    fireEvent.pointerDown(screen.getByText('Contenido'))
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.pointerDown(screen.getByRole('dialog', { name: 'Algo' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('cannot be waved away when it must be answered', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <Sheet label="Token" onClose={onClose} dismissable={false}>
        <input aria-label="Token" />
      </Sheet>,
    )
    await user.keyboard('{Escape}')
    fireEvent.pointerDown(screen.getByRole('dialog', { name: 'Token' }))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('only the sheet on top hears Escape', async () => {
    const user = userEvent.setup()
    const under = vi.fn()
    const over = vi.fn()
    render(
      <>
        <Sheet label="Debajo" onClose={under}>
          <p>a</p>
        </Sheet>
        <Sheet label="Encima" onClose={over}>
          <p>b</p>
        </Sheet>
      </>,
    )
    await user.keyboard('{Escape}')
    expect(over).toHaveBeenCalledTimes(1)
    expect(under).not.toHaveBeenCalled()
  })

  it('hands focus back to where it was when it closes', () => {
    function Host() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Abrir
          </button>
          {open && (
            <Sheet label="Hoja" onClose={() => setOpen(false)}>
              <button type="button" onClick={() => setOpen(false)}>
                Cerrar
              </button>
            </Sheet>
          )}
        </>
      )
    }
    render(<Host />)
    const opener = screen.getByRole('button', { name: 'Abrir' })
    opener.focus()
    fireEvent.click(opener)
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }))
    expect(opener).toHaveFocus()
  })
})

describe('the questions', () => {
  it('confirmar resolves true on the named action and false on Cancelar', async () => {
    const user = userEvent.setup()

    const yes = dialogo.confirmar({ title: '¿Borrar?', confirm: 'Borrar', destructive: true })
    await user.click(await screen.findByRole('button', { name: 'Borrar' }))
    await expect(yes).resolves.toBe(true)

    const no = dialogo.confirmar({ title: '¿Borrar?', confirm: 'Borrar' })
    await user.click(await screen.findByRole('button', { name: 'Cancelar' }))
    await expect(no).resolves.toBe(false)

    // And it leaves nothing behind.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('confirmar puts Cancelar first, so a reflex lands on the harmless one', async () => {
    const pending = dialogo.confirmar({ title: '¿Descartar?', confirm: 'Descartar' })
    const buttons = await screen.findAllByRole('button')
    expect(buttons[0]).toHaveTextContent('Cancelar')
    expect(buttons[0]).toHaveFocus()
    fireEvent.click(buttons[0] as HTMLElement)
    await expect(pending).resolves.toBe(false)
  })

  it('preguntar resolves with what was typed, or null when cancelled', async () => {
    const user = userEvent.setup()

    const named = dialogo.preguntar({ title: 'Guardar como', label: 'Nombre', confirm: 'Guardar' })
    await user.type(await screen.findByLabelText('Nombre'), 'nochevieja{Enter}')
    await expect(named).resolves.toBe('nochevieja')

    const cancelled = dialogo.preguntar({
      title: 'Salir del kiosko',
      label: 'PIN',
      confirm: 'Salir',
      secret: true,
    })
    const field = await screen.findByLabelText('PIN')
    expect(field).toHaveAttribute('type', 'password')
    await user.keyboard('{Escape}')
    await expect(cancelled).resolves.toBeNull()
  })
})

describe('the segmented control', () => {
  it('says which is chosen and reports a different choice once', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <Segmented
        label="Modo"
        value="run"
        options={[
          { value: 'run', label: 'Tocar' },
          { value: 'edit', label: 'Editar' },
        ]}
        onChange={onChange}
      />,
    )

    expect(screen.getByRole('group', { name: 'Modo' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Tocar' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Editar' })).toHaveAttribute('aria-pressed', 'false')

    await user.click(screen.getByRole('button', { name: 'Tocar' }))
    expect(onChange).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Editar' }))
    expect(onChange).toHaveBeenCalledWith('edit')
  })
})

describe('the toast', () => {
  it('lets news go by itself, after four seconds', () => {
    vi.useFakeTimers()
    const onClose = vi.fn()
    render(<Toast toast={{ text: 'Guardado', kind: 'info' }} onClose={onClose} />)
    expect(screen.getByRole('status')).toHaveTextContent('Guardado')
    act(() => vi.advanceTimersByTime(3900))
    expect(onClose).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(200))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps an error until it is closed: a problem that clears itself is one nobody read', () => {
    vi.useFakeTimers()
    const onClose = vi.fn()
    render(<Toast toast={{ text: 'Sin plugin', kind: 'error' }} onClose={onClose} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Sin plugin')
    act(() => vi.advanceTimersByTime(60_000))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar aviso' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('offers the way back, and goes once it is taken', () => {
    const run = vi.fn()
    const onClose = vi.fn()
    render(
      <Toast
        toast={{ text: 'Universo 2 eliminado', kind: 'info', action: { label: 'Deshacer', run } }}
        onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Deshacer' }))
    expect(run).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('popovers', () => {
  function Popover({ onClose }: { onClose: () => void }) {
    const ref = useRef<HTMLDivElement | null>(null)
    useDismiss(true, ref, onClose)
    return (
      <div>
        <div ref={ref}>
          <button type="button">Dentro</button>
        </div>
        <button type="button">Fuera</button>
      </div>
    )
  }

  it('close on Escape, and on a press outside but not inside', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<Popover onClose={onClose} />)

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Dentro' }))
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Fuera' }))
    expect(onClose).toHaveBeenCalledTimes(1)

    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('leave Ctrl+Shift+Escape to the panic shortcut', () => {
    const onClose = vi.fn()
    render(<Popover onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape', ctrlKey: true, shiftKey: true })
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('words on a lit card', () => {
  it('go dark on light fills and stay light on dark ones', () => {
    // The show's own dark red, lit: white words.
    expect(litOnLight('#880000')).toBe(false)
    // A yellow strobe lit: dark words.
    expect(litOnLight('#b4b400')).toBe(true)
    // No colour of its own: the live green, which is light.
    expect(litOnLight(undefined)).toBe(true)
    // Something that is not a hex colour falls back the same way.
    expect(litOnLight('Default')).toBe(true)
  })
})
