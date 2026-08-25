/**
 * The widget editor, pointed at a button.
 *
 * What matters here is the contract with the daemon: the panel paints the
 * widget's own values, and each edit leaves as the right patch -- because the
 * patch is exactly what PATCH /vc/widgets/{id} receives. The apply callback
 * is the seam App wires to api.editWidget, so asserting on it asserts the
 * request body without dragging the whole App into every test.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FunctionState, WidgetPatch } from './api'
import { WidgetEditor } from './editor'
import type { VcWidget } from './layout'

const FUNCTIONS: FunctionState[] = [
  { id: 1, name: 'Roja', type: 'Scene', running: false },
  { id: 2, name: 'Azul', type: 'Scene', running: false },
]

const button: VcWidget = {
  type: 'button',
  id: 7,
  caption: 'PAR ROJO',
  functionId: 1,
  action: 'Toggle',
  geometry: { x: 0, y: 0, width: 120, height: 60 },
}

function renderEditor(widget: VcWidget) {
  const onApply = vi.fn((_patch: WidgetPatch) => Promise.resolve())
  const onDelete = vi.fn(() => Promise.resolve())
  const onClose = vi.fn()
  render(
    <WidgetEditor
      widget={widget}
      functions={FUNCTIONS}
      fixtures={[]}
      learning={null}
      onApply={onApply}
      onDelete={onDelete}
      onClose={onClose}
    />,
  )
  return { onApply, onDelete, onClose }
}

beforeEach(() => {
  /* jsdom has no matchMedia; the panel only uses it to decide whether to
     scroll itself into view on a phone, so "not a phone" is the honest stub. */
  vi.stubGlobal('matchMedia', (query: string): MediaQueryList => {
    return { matches: false, media: query } as unknown as MediaQueryList
  })
})

describe('a button in the editor', () => {
  it('paints the widget its own values', () => {
    renderEditor(button)

    // The name field carries the caption, ready to edit.
    expect(screen.getByLabelText('Nombre')).toHaveValue('PAR ROJO')
    // The function picker shows the bound function by name, not by number.
    expect(screen.getByDisplayValue('Roja')).toBeInTheDocument()
    // The press action reads as words the operator chose from.
    expect(screen.getByDisplayValue('Alternar')).toBeInTheDocument()
  })

  it('treats the no-function sentinel as unbound', () => {
    // QLC+ writes UINT_MAX for "no function"; showing function 4294967295
    // would be the file format leaking onto the screen.
    renderEditor({ ...button, functionId: 0xffffffff })

    const picker = screen.getByDisplayValue('(ninguna)')
    expect(picker).toHaveValue('')
  })

  it('sends the new caption on Enter', async () => {
    const user = userEvent.setup()
    const { onApply } = renderEditor(button)

    const name = screen.getByLabelText('Nombre')
    await user.clear(name)
    await user.type(name, 'GENERAL{Enter}')

    expect(onApply).toHaveBeenCalledWith({ caption: 'GENERAL' })
  })

  it('does not write a caption that did not change', async () => {
    // Leaving the field without editing must not touch the daemon: every
    // apply re-reads the console and marks the project dirty.
    const user = userEvent.setup()
    const { onApply } = renderEditor(button)

    await user.click(screen.getByLabelText('Nombre'))
    await user.tab()

    expect(onApply).not.toHaveBeenCalled()
  })

  it('rebinds the function through the picker', async () => {
    const user = userEvent.setup()
    const { onApply } = renderEditor(button)

    await user.selectOptions(screen.getByDisplayValue('Roja'), 'Azul')
    expect(onApply).toHaveBeenCalledWith({ functionId: 2 })

    await user.selectOptions(screen.getByDisplayValue('Roja'), '(ninguna)')
    expect(onApply).toHaveBeenLastCalledWith({ functionId: null })
  })

  it('changes the press action', async () => {
    const user = userEvent.setup()
    const { onApply } = renderEditor(button)

    await user.selectOptions(screen.getByDisplayValue('Alternar'), 'Flash')

    expect(onApply).toHaveBeenCalledWith({ action: 'Flash' })
  })

  it('offers the flash flags only on a flash button, and sends them', async () => {
    const user = userEvent.setup()

    // A toggle button has no flash flags to offer.
    const plain = renderEditor(button)
    expect(screen.queryByLabelText(/Pisa lo que corre/)).not.toBeInTheDocument()
    expect(plain.onApply).not.toHaveBeenCalled()

    const { onApply } = renderEditor({ ...button, action: 'Flash' })
    const override = screen.getByLabelText(/Pisa lo que corre/)
    expect(override).not.toBeChecked()

    await user.click(override)
    expect(onApply).toHaveBeenCalledWith({ flashOverride: true })
  })

  it('shows the daemon refusal and lets the operator try again', async () => {
    const user = userEvent.setup()
    const { onApply } = renderEditor(button)
    onApply.mockRejectedValueOnce(new Error('El daemon dijo no'))

    await user.selectOptions(screen.getByDisplayValue('Roja'), 'Azul')

    // The refusal is on screen, and nothing stays locked: the operator can
    // correct and resend rather than reload.
    expect(await screen.findByText('El daemon dijo no')).toBeInTheDocument()
    expect(screen.getByLabelText('Nombre')).toBeEnabled()
  })

  it('hands deletion to its owner', async () => {
    const user = userEvent.setup()
    const { onDelete } = renderEditor(button)

    await user.click(screen.getByRole('button', { name: 'Eliminar widget' }))

    expect(onDelete).toHaveBeenCalledTimes(1)
  })
})
