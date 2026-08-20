/**
 * The project menu: new, open, recents, save, save as.
 *
 * One menu, two worlds. In the desktop shell the open/save-as entries go
 * through native dialogs and the daemon's disk-path routes (token-gated even
 * on loopback). In a browser they fall back to the projects directory the
 * daemon serves by name -- a phone can switch shows, it just cannot roam the
 * disk. Recents appear wherever the token authorizes them and are simply
 * absent where it does not: an entry that would only ever answer 401 is not
 * an entry, it is a trap.
 */

import { useEffect, useRef, useState } from 'react'
import { type RecentProject, api } from './api'
import { isShell, pickProjectToOpen, pickProjectToSave } from './shell'

export function ProjectMenu({
  name,
  dirty,
  onError,
}: {
  name: string
  dirty: boolean
  /** Failures surface where every other out-of-band problem does. */
  onError: (message: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [recents, setRecents] = useState<RecentProject[]>([])
  const [available, setAvailable] = useState<string[]>([])
  const menu = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return

    /* Fetched on open, not on mount: both lists change behind this client's
       back (another window saves, the shell opens something). */
    api
      .recentProjects()
      .then((body) => setRecents(body.recents))
      .catch(() => setRecents([]))
    api
      .listProjects()
      .then((body) => setAvailable(body.projects))
      .catch(() => setAvailable([]))

    const away = (event: PointerEvent) => {
      if (menu.current?.contains(event.target as Node) === true) return
      setOpen(false)
    }
    window.addEventListener('pointerdown', away)
    return () => window.removeEventListener('pointerdown', away)
  }, [open])

  const guard = (work: () => Promise<unknown>) => {
    setOpen(false)
    work().catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
  }

  /* Loading over unsaved edits loses them; the daemon cannot ask, so this is
     asked here, once, in words. */
  const confirmDiscard = () =>
    !dirty || window.confirm('Hay cambios sin guardar que se perderán. ¿Seguir sin guardarlos?')

  const newProject = () =>
    guard(async () => {
      if (!confirmDiscard()) return
      await api.newProject()
    })

  const openNative = () =>
    guard(async () => {
      if (!confirmDiscard()) return
      const path = await pickProjectToOpen()
      if (path !== null) await api.openProjectPath(path)
    })

  const openByName = (file: string) =>
    guard(async () => {
      if (!confirmDiscard()) return
      await api.loadProject(file)
    })

  const openRecent = (path: string) =>
    guard(async () => {
      if (!confirmDiscard()) return
      await api.openProjectPath(path)
    })

  const save = () => guard(() => api.saveProject())

  const saveAsNative = () =>
    guard(async () => {
      const path = await pickProjectToSave()
      if (path !== null) await api.saveProjectAs(path)
    })

  const saveAsNamed = () =>
    guard(async () => {
      const file = window.prompt('Nombre del proyecto (en la carpeta de proyectos):')
      if (file === null || file.trim() === '') return
      const cleaned = file.trim().endsWith('.qxw') ? file.trim() : `${file.trim()}.qxw`
      await api.saveProjectNamed(cleaned)
    })

  return (
    <div className="projectmenu" ref={menu}>
      <button
        type="button"
        className="projectmenu-trigger"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((current) => !current)}
      >
        <strong>{name}</strong>
        <span aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="projectmenu-list" role="menu">
          <button type="button" role="menuitem" onClick={newProject}>
            Nuevo
          </button>

          {isShell() ? (
            <button type="button" role="menuitem" onClick={openNative}>
              Abrir…
            </button>
          ) : (
            available.length > 0 && (
              <div className="projectmenu-group">
                <span className="projectmenu-title">Abrir</span>
                {available.map((file) => (
                  <button key={file} type="button" role="menuitem" onClick={() => openByName(file)}>
                    {file.replace(/\.qxw$/i, '')}
                  </button>
                ))}
              </div>
            )
          )}

          {recents.length > 0 && (
            <div className="projectmenu-group">
              <span className="projectmenu-title">Recientes</span>
              {recents.map((recent) => (
                <button
                  key={recent.path}
                  type="button"
                  role="menuitem"
                  disabled={!recent.exists}
                  title={recent.exists ? recent.path : `${recent.path} (no existe)`}
                  onClick={() => openRecent(recent.path)}
                >
                  {recent.name.replace(/\.qxw$/i, '')}
                </button>
              ))}
            </div>
          )}

          <button type="button" role="menuitem" disabled={!dirty} onClick={save}>
            Guardar
          </button>

          {isShell() ? (
            <button type="button" role="menuitem" onClick={saveAsNative}>
              Guardar como…
            </button>
          ) : (
            <button type="button" role="menuitem" onClick={saveAsNamed}>
              Guardar como…
            </button>
          )}
        </div>
      )}
    </div>
  )
}
