/**
 * The project menu: every entry must land on its route, and no entry may
 * throw away unsaved work without asking first.
 *
 * `./api` and `./shell` are both mocked: what is under test is the wiring
 * from a menu click to a daemon route (or a native dialog), plus the one
 * question the daemon cannot ask -- "discard the unsaved edits?" -- which
 * lives here and only here.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import { ProjectMenu } from './proyecto'
import { isShell, pickProjectToOpen, pickProjectToSave } from './shell'

vi.mock('./api', () => ({
  api: {
    recentProjects: vi.fn(),
    listProjects: vi.fn(),
    newProject: vi.fn(),
    openProjectPath: vi.fn(),
    loadProject: vi.fn(),
    saveProject: vi.fn(),
    saveProjectAs: vi.fn(),
    saveProjectNamed: vi.fn(),
    importPreview: vi.fn(),
    importProject: vi.fn(),
  },
}))

vi.mock('./shell', () => ({
  isShell: vi.fn(),
  pickProjectToOpen: vi.fn(),
  pickProjectToSave: vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
  // Browser world by default; the shell tests flip this per test.
  vi.mocked(isShell).mockReturnValue(false)
  vi.mocked(api.recentProjects).mockResolvedValue({ recents: [] })
  vi.mocked(api.listProjects).mockResolvedValue({ directory: '/proyectos', projects: [] })
  vi.mocked(api.newProject).mockResolvedValue({ path: '/proyectos/nuevo.qxw' })
  vi.mocked(api.openProjectPath).mockResolvedValue({ path: '/x.qxw' })
  vi.mocked(api.loadProject).mockResolvedValue({ path: '/x.qxw' })
  vi.mocked(api.saveProject).mockResolvedValue({ path: '/x.qxw' })
  vi.mocked(api.saveProjectAs).mockResolvedValue({ path: '/x.qxw' })
  vi.mocked(api.saveProjectNamed).mockResolvedValue({ path: '/x.qxw' })
  /* jsdom's confirm/prompt are stubs that warn; the menu needs real answers. */
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  vi.spyOn(window, 'prompt').mockReturnValue(null)
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function openMenu(props: Partial<Parameters<typeof ProjectMenu>[0]> = {}) {
  const onError = vi.fn()
  render(<ProjectMenu name="bolo" dirty={false} onError={onError} {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'bolo' }))
  await screen.findByRole('menu')
  // The lists are fetched on open; let them land before the test clicks on.
  await waitFor(() => expect(api.recentProjects).toHaveBeenCalled())
  return onError
}

describe('the menu itself', () => {
  it('wears the project name and opens on click', async () => {
    await openMenu()

    expect(screen.getByRole('menuitem', { name: 'Nuevo' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Guardar' })).toBeInTheDocument()
  })

  it('closes when the operator clicks elsewhere, but not inside itself', async () => {
    await openMenu()

    fireEvent.pointerDown(screen.getByRole('menuitem', { name: 'Nuevo' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()

    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('re-fetches recents and the directory each time it opens', async () => {
    // Both lists change behind this client's back (another window saves);
    // a menu that trusts its first fetch shows ghosts.
    await openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'bolo' }))
    fireEvent.click(screen.getByRole('button', { name: 'bolo' }))

    await waitFor(() => expect(api.recentProjects).toHaveBeenCalledTimes(2))
    expect(api.listProjects).toHaveBeenCalledTimes(2)
  })
})

describe('nuevo', () => {
  it('starts a new project through the daemon and closes the menu', async () => {
    await openMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Nuevo' }))

    await waitFor(() => expect(api.newProject).toHaveBeenCalled())
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('does not ask about a clean project', async () => {
    await openMenu({ dirty: false })

    fireEvent.click(screen.getByRole('menuitem', { name: 'Nuevo' }))

    await waitFor(() => expect(api.newProject).toHaveBeenCalled())
    expect(window.confirm).not.toHaveBeenCalled()
  })

  it('asks before discarding unsaved work and stands down on "no"', async () => {
    vi.mocked(window.confirm).mockReturnValue(false)
    await openMenu({ dirty: true })

    fireEvent.click(screen.getByRole('menuitem', { name: 'Nuevo' }))

    expect(window.confirm).toHaveBeenCalled()
    await waitFor(() => expect(api.newProject).not.toHaveBeenCalled())
  })

  it('proceeds when the operator accepts the loss', async () => {
    vi.mocked(window.confirm).mockReturnValue(true)
    await openMenu({ dirty: true })

    fireEvent.click(screen.getByRole('menuitem', { name: 'Nuevo' }))

    await waitFor(() => expect(api.newProject).toHaveBeenCalled())
  })
})

describe('abrir, from a browser', () => {
  it('lists what the projects directory offers, extensions stripped', async () => {
    vi.mocked(api.listProjects).mockResolvedValue({
      directory: '/proyectos',
      projects: ['verbena.qxw', 'nochevieja.qxw'],
    })
    await openMenu()

    fireEvent.click(await screen.findByRole('menuitem', { name: 'verbena' }))

    // The daemon gets the real file name; the operator never sees it.
    await waitFor(() => expect(api.loadProject).toHaveBeenCalledWith('verbena.qxw'))
  })

  it('offers no open entry at all when the directory is empty', async () => {
    await openMenu()

    // An entry that could only fail is a trap, not an entry.
    expect(screen.queryByText('Abrir')).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Abrir…' })).not.toBeInTheDocument()
  })
})

describe('abrir, from the desktop shell', () => {
  beforeEach(() => {
    vi.mocked(isShell).mockReturnValue(true)
  })

  it('walks the native dialog to a disk path', async () => {
    vi.mocked(pickProjectToOpen).mockResolvedValue('/bolos/agosto.qxw')
    await openMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Abrir…' }))

    await waitFor(() => expect(api.openProjectPath).toHaveBeenCalledWith('/bolos/agosto.qxw'))
  })

  it('opens nothing when the dialog is cancelled', async () => {
    vi.mocked(pickProjectToOpen).mockResolvedValue(null)
    await openMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Abrir…' }))

    await waitFor(() => expect(pickProjectToOpen).toHaveBeenCalled())
    expect(api.openProjectPath).not.toHaveBeenCalled()
  })

  it('asks about unsaved work before even showing the dialog', async () => {
    vi.mocked(window.confirm).mockReturnValue(false)
    await openMenu({ dirty: true })

    fireEvent.click(screen.getByRole('menuitem', { name: 'Abrir…' }))

    await waitFor(() => expect(window.confirm).toHaveBeenCalled())
    expect(pickProjectToOpen).not.toHaveBeenCalled()
  })
})

describe('recientes', () => {
  it('opens a recent by its full path', async () => {
    vi.mocked(api.recentProjects).mockResolvedValue({
      recents: [{ path: '/bolos/agosto.qxw', name: 'agosto.qxw', exists: true }],
    })
    await openMenu()

    fireEvent.click(await screen.findByRole('menuitem', { name: 'agosto' }))

    await waitFor(() => expect(api.openProjectPath).toHaveBeenCalledWith('/bolos/agosto.qxw'))
  })

  it('shows a recent whose file is gone, but dead', async () => {
    vi.mocked(api.recentProjects).mockResolvedValue({
      recents: [{ path: '/fuera/perdido.qxw', name: 'perdido.qxw', exists: false }],
    })
    await openMenu()

    const entry = await screen.findByRole('menuitem', { name: 'perdido' })
    expect(entry).toBeDisabled()
    expect(entry).toHaveAttribute('title', '/fuera/perdido.qxw (no existe)')
  })
})

describe('guardar', () => {
  it('is disabled while there is nothing to save', async () => {
    await openMenu({ dirty: false })

    expect(screen.getByRole('menuitem', { name: 'Guardar' })).toBeDisabled()
  })

  it('saves through the daemon when dirty, without questions', async () => {
    await openMenu({ dirty: true })

    fireEvent.click(screen.getByRole('menuitem', { name: 'Guardar' }))

    await waitFor(() => expect(api.saveProject).toHaveBeenCalled())
    expect(window.confirm).not.toHaveBeenCalled()
  })

  it('surfaces a failed save where every error goes', async () => {
    vi.mocked(api.saveProject).mockRejectedValue(new Error('disco lleno'))
    const onError = await openMenu({ dirty: true })

    fireEvent.click(screen.getByRole('menuitem', { name: 'Guardar' }))

    await waitFor(() => expect(onError).toHaveBeenCalledWith('disco lleno'))
  })
})

describe('guardar como', () => {
  it('asks for a name and saves it into the projects directory, extension added', async () => {
    vi.mocked(window.prompt).mockReturnValue('nochevieja')
    await openMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Guardar como…' }))

    await waitFor(() => expect(api.saveProjectNamed).toHaveBeenCalledWith('nochevieja.qxw'))
  })

  it('does not double the extension when the operator typed it', async () => {
    vi.mocked(window.prompt).mockReturnValue('nochevieja.qxw')
    await openMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Guardar como…' }))

    await waitFor(() => expect(api.saveProjectNamed).toHaveBeenCalledWith('nochevieja.qxw'))
  })

  // Regression: the extension check was case-sensitive while the display
  // strip was not, so "FIESTA.QXW" was saved as "FIESTA.QXW.qxw".
  it('accepts the extension whatever its case', async () => {
    vi.mocked(window.prompt).mockReturnValue('FIESTA.QXW')
    await openMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Guardar como…' }))

    await waitFor(() => expect(api.saveProjectNamed).toHaveBeenCalledWith('FIESTA.QXW'))
  })

  it('saves nothing on a cancelled or blank prompt', async () => {
    vi.mocked(window.prompt).mockReturnValueOnce(null).mockReturnValueOnce('   ')
    await openMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Guardar como…' }))
    await waitFor(() => expect(window.prompt).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('button', { name: 'bolo' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Guardar como…' }))

    await waitFor(() => expect(window.prompt).toHaveBeenCalledTimes(2))
    expect(api.saveProjectNamed).not.toHaveBeenCalled()
  })

  it('never asks about unsaved changes: nothing is lost by saving', async () => {
    vi.mocked(window.prompt).mockReturnValue('copia')
    await openMenu({ dirty: true })

    fireEvent.click(screen.getByRole('menuitem', { name: 'Guardar como…' }))

    await waitFor(() => expect(api.saveProjectNamed).toHaveBeenCalledWith('copia.qxw'))
    expect(window.confirm).not.toHaveBeenCalled()
  })

  it('walks the native save dialog in the shell', async () => {
    vi.mocked(isShell).mockReturnValue(true)
    vi.mocked(pickProjectToSave).mockResolvedValue('/bolos/copia.qxw')
    await openMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Guardar como…' }))

    await waitFor(() => expect(api.saveProjectAs).toHaveBeenCalledWith('/bolos/copia.qxw'))
  })

  it('saves nothing when the native dialog is cancelled', async () => {
    vi.mocked(isShell).mockReturnValue(true)
    vi.mocked(pickProjectToSave).mockResolvedValue(null)
    await openMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Guardar como…' }))

    await waitFor(() => expect(pickProjectToSave).toHaveBeenCalled())
    expect(api.saveProjectAs).not.toHaveBeenCalled()
  })
})

describe('importar de otro proyecto', () => {
  const preview = {
    fixtures: [{ id: 1, name: 'PAR viejo', universe: 1, address: 1, channels: 3 }],
    functions: [
      { id: 4, name: 'Rojo pleno', type: 'Scene' },
      { id: 9, name: 'Persecución', type: 'Chaser' },
    ],
    groups: 0,
    palettes: 0,
  }

  beforeEach(() => {
    vi.mocked(window.prompt).mockReturnValue('/bolos/otro.qxw')
    vi.mocked(api.importPreview).mockResolvedValue(preview)
    vi.mocked(api.importProject).mockResolvedValue({
      fixturesCreated: 1,
      fixturesReused: 0,
      groupsCreated: 0,
      palettesCreated: 0,
      functionsCreated: 2,
    })
  })

  it('previews the other file and offers everything checked', async () => {
    await openMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Importar de otro proyecto…' }))

    const dialog = await screen.findByRole('dialog')
    expect(api.importPreview).toHaveBeenCalledWith('/bolos/otro.qxw')
    expect(dialog).toBeInTheDocument()
    // "Bring the whole bolo across" is the common intent: all checked.
    for (const box of screen.getAllByRole('checkbox')) expect(box).toBeChecked()
  })

  it('imports the chosen pieces and reports what happened', async () => {
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Importar de otro proyecto…' }))
    await screen.findByRole('dialog')

    // Leave one function behind: the daemon must hear the difference.
    fireEvent.click(screen.getByRole('checkbox', { name: /Persecución/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Importar' }))

    await waitFor(() =>
      expect(api.importProject).toHaveBeenCalledWith({
        path: '/bolos/otro.qxw',
        fixtures: [1],
        functions: [4],
      }),
    )
    expect(await screen.findByText('1 fixtures nuevas · 2 funciones')).toBeInTheDocument()
  })

  it('will not import an empty selection', async () => {
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Importar de otro proyecto…' }))
    await screen.findByRole('dialog')

    for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box)

    expect(screen.getByRole('button', { name: 'Importar' })).toBeDisabled()
  })

  it('imports nothing when the path prompt is cancelled', async () => {
    vi.mocked(window.prompt).mockReturnValue(null)
    await openMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Importar de otro proyecto…' }))

    await waitFor(() => expect(window.prompt).toHaveBeenCalled())
    expect(api.importPreview).not.toHaveBeenCalled()
  })
})
