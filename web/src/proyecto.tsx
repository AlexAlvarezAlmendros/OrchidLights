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
import { Icon } from './icons'
import { isShell, pickProjectToOpen, pickProjectToSave } from './shell'
import { Sheet, dialogo, useDismiss } from './ui'

export interface MenuExtra {
  label: string
  run: () => void
  /** Set for one of a set of choices: the console's three modes. */
  checked?: boolean
  disabled?: boolean
}

interface ImportPreviewState {
  path: string
  fixtures: { id: number; name: string; universe: number; address: number; channels: number }[]
  functions: { id: number; name: string; type: string }[]
}

export function ProjectMenu({
  name,
  dirty,
  pass,
  onPass,
  extras = [],
  onError,
}: {
  name: string
  dirty: boolean
  /** The pass is a switch the operator reaches for mid-show, so it lives in
   *  the one menu that is on every screen. Whether it is on, and the switch:
   *  where it comes back to is the theme's business, not the menu's. */
  pass?: boolean
  onPass?: () => void
  /** What a phone's bar has no room for, offered here instead: the console's
   *  mode, operator mode, settings. A narrow toolbar moves its overflow into a
   *  menu rather than shrinking every control below the size of a finger. */
  extras?: MenuExtra[]
  /** Failures surface where every other out-of-band problem does. */
  onError: (message: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [recents, setRecents] = useState<RecentProject[]>([])
  const [available, setAvailable] = useState<string[]>([])
  const [importing, setImporting] = useState<ImportPreviewState | null>(null)
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
  }, [open])

  useDismiss(open, menu, () => setOpen(false))

  const guard = (work: () => Promise<unknown>) => {
    setOpen(false)
    work().catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
  }

  /* Loading over unsaved edits loses them; the daemon cannot ask, so this is
     asked here, once, in words. */
  const confirmDiscard = async () =>
    !dirty ||
    dialogo.confirmar({
      title: 'Hay cambios sin guardar',
      message: 'Se perderán si sigues sin guardarlos.',
      confirm: 'Descartar cambios',
      destructive: true,
    })

  const newProject = () =>
    guard(async () => {
      if (!(await confirmDiscard())) return
      await api.newProject()
    })

  const openNative = () =>
    guard(async () => {
      if (!(await confirmDiscard())) return
      const path = await pickProjectToOpen()
      if (path !== null) await api.openProjectPath(path)
    })

  const openByName = (file: string) =>
    guard(async () => {
      if (!(await confirmDiscard())) return
      await api.loadProject(file)
    })

  const openRecent = (path: string) =>
    guard(async () => {
      if (!(await confirmDiscard())) return
      await api.openProjectPath(path)
    })

  const save = () => guard(() => api.saveProject())

  const saveAsNative = () =>
    guard(async () => {
      const path = await pickProjectToSave()
      if (path !== null) await api.saveProjectAs(path)
    })

  const startImport = () =>
    guard(async () => {
      const path = isShell()
        ? await pickProjectToOpen()
        : await dialogo.preguntar({
            title: '¿De qué proyecto importar?',
            label: 'Ruta absoluta del .qxw',
            placeholder: '/home/…/otro.qxw',
            confirm: 'Siguiente',
          })
      if (path === null || path.trim() === '') return
      const preview = await api.importPreview(path.trim())
      setImporting({ path: path.trim(), fixtures: preview.fixtures, functions: preview.functions })
    })

  const saveAsNamed = () =>
    guard(async () => {
      const file = await dialogo.preguntar({
        title: 'Guardar como',
        label: 'Nombre del proyecto',
        message: 'Se guarda en la carpeta de proyectos de la mesa.',
        confirm: 'Guardar',
      })
      if (file === null || file.trim() === '') return
      /* Case-insensitive, like the display strip below: a name typed as
         "FIESTA.QXW" must not be sent as "FIESTA.QXW.qxw" -- a file the
         operator never named, shown in the open list under the name they did. */
      const trimmed = file.trim()
      const cleaned = /\.qxw$/i.test(trimmed) ? trimmed : `${trimmed}.qxw`
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
        <Icon name="chevronDown" size={16} />
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

          <button type="button" role="menuitem" onClick={startImport}>
            Importar de otro proyecto…
          </button>

          {extras.length > 0 && (
            <div className="projectmenu-group">
              {extras.map((extra) => (
                <button
                  key={extra.label}
                  type="button"
                  role={extra.checked === undefined ? 'menuitem' : 'menuitemradio'}
                  aria-checked={extra.checked}
                  disabled={extra.disabled}
                  className="projectmenu-check"
                  onClick={() => {
                    setOpen(false)
                    extra.run()
                  }}
                >
                  <span>{extra.label}</span>
                  {extra.checked === true && <Icon name="check" size={18} />}
                </button>
              ))}
            </div>
          )}

          {pass !== undefined && onPass !== undefined && (
            <div className="projectmenu-group">
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={pass}
                className="projectmenu-check"
                title="Ctrl+Alt+P"
                onClick={() => {
                  setOpen(false)
                  onPass()
                }}
              >
                <Icon name={pass ? 'sun' : 'moon'} size={18} />
                <span>Modo pase</span>
                <span className="projectmenu-switch" aria-hidden="true" />
              </button>
            </div>
          )}
        </div>
      )}

      {importing !== null && (
        <ImportDialog preview={importing} onClose={() => setImporting(null)} onError={onError} />
      )}
    </div>
  )
}

/**
 * Selective import: what the other file offers, chosen piece by piece.
 *
 * Everything starts checked because "bring the whole bolo across" is the
 * common intent; unchecking is the exception, not the chore. Fixtures with a
 * name that already exists are reused rather than duplicated, and the report
 * says which happened.
 */
function ImportDialog({
  preview,
  onClose,
  onError,
}: {
  preview: ImportPreviewState
  onClose: () => void
  onError: (message: string) => void
}) {
  const [fixtures, setFixtures] = useState<Set<number>>(new Set(preview.fixtures.map((f) => f.id)))
  const [functions, setFunctions] = useState<Set<number>>(
    new Set(preview.functions.map((f) => f.id)),
  )
  const [report, setReport] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const toggle = (set: Set<number>, id: number, into: (next: Set<number>) => void) => {
    const next = new Set(set)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    into(next)
  }

  const apply = () => {
    setBusy(true)
    api
      .importProject({
        path: preview.path,
        fixtures: [...fixtures],
        functions: [...functions],
      })
      .then((result) => {
        const pieces = [
          `${result.fixturesCreated} fixtures nuevas`,
          result.fixturesReused > 0 ? `${result.fixturesReused} reutilizadas por nombre` : '',
          result.groupsCreated > 0 ? `${result.groupsCreated} grupos` : '',
          result.palettesCreated > 0 ? `${result.palettesCreated} palettes` : '',
          `${result.functionsCreated} funciones`,
        ].filter((p) => p !== '')
        setReport(pieces.join(' · '))
      })
      .catch((e: unknown) => {
        onError(e instanceof Error ? e.message : String(e))
        onClose()
      })
      .finally(() => setBusy(false))
  }

  return (
    <Sheet label="Importar de otro proyecto" size="l" onClose={onClose}>
      <div className="import-dialog">
        <h2>Importar de {preview.path.split('/').pop()}</h2>

        {report === null ? (
          <>
            <div className="import-lists">
              <fieldset>
                <legend>Fixtures ({fixtures.size})</legend>
                {preview.fixtures.length === 0 && <p className="hint">No trae fixtures.</p>}
                {preview.fixtures.map((f) => (
                  <label key={f.id} className="field row-field">
                    <input
                      type="checkbox"
                      checked={fixtures.has(f.id)}
                      onChange={() => toggle(fixtures, f.id, setFixtures)}
                    />
                    <span>
                      {f.name} · U{f.universe} @ {f.address}
                    </span>
                  </label>
                ))}
              </fieldset>
              <fieldset>
                <legend>Funciones ({functions.size})</legend>
                {preview.functions.length === 0 && <p className="hint">No trae funciones.</p>}
                {preview.functions.map((f) => (
                  <label key={f.id} className="field row-field">
                    <input
                      type="checkbox"
                      checked={functions.has(f.id)}
                      onChange={() => toggle(functions, f.id, setFunctions)}
                    />
                    <span>
                      {f.name} <span className="chip">{f.type}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
            </div>

            <p className="hint">
              Una función marcada arrastra lo que necesita: sus escenas, sus grupos y sus palettes
              vienen con ella aunque no estén marcados.
            </p>

            <div className="sheet-actions">
              <button type="button" onClick={onClose}>
                Cancelar
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy || (fixtures.size === 0 && functions.size === 0)}
                onClick={apply}
              >
                Importar
              </button>
            </div>
          </>
        ) : (
          <>
            <p>{report}</p>
            <div className="sheet-actions">
              <button type="button" className="primary" onClick={onClose}>
                Listo
              </button>
            </div>
          </>
        )}
      </div>
    </Sheet>
  )
}
