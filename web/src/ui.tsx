/**
 * The desk's own controls: the handful of pieces every screen is built from.
 *
 * Each exists because the browser's version of it lies in this room. A native
 * confirm() is drawn by the operating system, outside the theme -- a white
 * rectangle in the middle of a pass on a desktop with a light theme, and red
 * nowhere. A `<dialog open>` looks modal and is not: the page behind it still
 * takes taps and Escape does nothing. A popover that only closes when you tap
 * somewhere else is a popover the keyboard can never leave.
 */

import { useEffect, useId, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Icon } from './icons'

/* -------------------------------------------------------------------------
   Popovers: one way to put them away.
   ------------------------------------------------------------------------- */

/**
 * Close an open popover when the pointer goes down outside it, or when Escape
 * is pressed anywhere. Every menu and panel in the show bar had the first half
 * and none had the second.
 */
export function useDismiss(
  open: boolean,
  inside: React.RefObject<HTMLElement | null>,
  close: () => void,
) {
  /* The latest close, without re-arming the listeners on every render. */
  const latest = useRef(close)
  latest.current = close

  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent) => {
      if (inside.current?.contains(event.target as Node) === true) return
      latest.current()
    }
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.ctrlKey || event.shiftKey) return
      latest.current()
    }
    window.addEventListener('pointerdown', away)
    window.addEventListener('keydown', onEscape)
    return () => {
      window.removeEventListener('pointerdown', away)
      window.removeEventListener('keydown', onEscape)
    }
  }, [open, inside])
}

/**
 * Whether a media query holds, and follows it as the window changes. False
 * where there is no matchMedia -- the test DOM -- so the wide layout is the
 * one tests see.
 */
export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
  )
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const list = window.matchMedia(query)
    const update = () => setMatches(list.matches)
    update()
    list.addEventListener('change', update)
    return () => list.removeEventListener('change', update)
  }, [query])
  return matches
}

/* -------------------------------------------------------------------------
   Sheets: a real modal.
   ------------------------------------------------------------------------- */

/**
 * A modal sheet: the page behind it is inert, focus starts inside and stays
 * there, and Escape -- or a tap on the dimmed page -- is Cancel.
 *
 * On a phone it rises from the bottom edge, under the thumb; with room it is a
 * card in the middle. One component, two shapes, decided by CSS.
 */
export function Sheet({
  label,
  onClose,
  children,
  size = 'm',
  className,
  dismissable = true,
}: {
  /** What a screen reader announces. Usually the title. */
  label: string
  onClose: () => void
  children: React.ReactNode
  size?: 's' | 'm' | 'l'
  className?: string
  /** False for the rare sheet that must be answered, like a missing token. */
  dismissable?: boolean
}) {
  const ref = useRef<HTMLDialogElement | null>(null)
  const latest = useRef(onClose)
  latest.current = onClose
  const allowed = useRef(dismissable)
  allowed.current = dismissable

  useEffect(() => {
    const dialog = ref.current
    if (dialog === null) return
    const before = document.activeElement as HTMLElement | null
    openSheets.push(dialog)

    /* jsdom has no showModal; the attribute is the honest fallback there and
       in the odd browser without it. */
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal()
    } else {
      dialog.setAttribute('open', '')
    }

    /* Focus starts inside, never left behind on the page: on the field that
       asked for it; in an alert, on its first answer -- Cancel, the one a
       reflex cannot regret; and otherwise on the sheet itself, so a settings
       screen does not open with a ring around its Done button. */
    const wanted =
      dialog.querySelector<HTMLElement>('[autofocus]') ??
      (dialog.classList.contains('alert')
        ? dialog.querySelector<HTMLElement>('button:not([disabled])')
        : null)
    if (wanted) wanted.focus()
    else dialog.focus()

    /* Escape is Cancel for the sheet on top, wherever focus has wandered.
       Handled on keydown, and the default prevented, so the browser's own
       cancel does not close the sheet a second time behind this desk's back. */
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || openSheets[openSheets.length - 1] !== dialog) return
      event.preventDefault()
      event.stopPropagation()
      if (allowed.current) latest.current()
    }
    document.addEventListener('keydown', onEscape, true)

    return () => {
      document.removeEventListener('keydown', onEscape, true)
      openSheets.splice(openSheets.indexOf(dialog), 1)
      if (typeof dialog.close === 'function' && dialog.open) dialog.close()
      /* Back to where the hand was. */
      if (before && document.contains(before)) before.focus()
    }
  }, [])

  return (
    <dialog
      ref={ref}
      className={`sheet${className ? ` ${className}` : ''}`}
      data-size={size}
      aria-label={label}
      aria-modal="true"
      tabIndex={-1}
      onCancel={(event) => {
        /* The browser closes on Escape by itself; this desk decides. */
        event.preventDefault()
        if (allowed.current) latest.current()
      }}
      onPointerDown={(event) => {
        /* A press on the backdrop lands on the dialog element itself. */
        if (allowed.current && event.target === ref.current) latest.current()
      }}
    >
      <div className="sheet-card">{children}</div>
    </dialog>
  )
}

/** The sheets on screen, bottom to top: only the top one hears Escape. */
const openSheets: HTMLDialogElement[] = []

/* -------------------------------------------------------------------------
   Segmented control: one choice of a few, always visible.
   ------------------------------------------------------------------------- */

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  size = 'm',
}: {
  label: string
  value: T
  options: { value: T; label: string; title?: string; disabled?: boolean }[]
  onChange: (value: T) => void
  size?: 's' | 'm'
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset cannot be a flex track with a sliding thumb
    <div className="segmented" role="group" aria-label={label} data-size={size}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          disabled={option.disabled}
          title={option.title}
          onClick={() => option.value !== value && onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/* -------------------------------------------------------------------------
   Questions: confirm() and prompt(), drawn by the desk.
   ------------------------------------------------------------------------- */

interface Confirm {
  title: string
  message?: string
  /** The verb that goes ahead: "Descartar", "Borrar". Never "OK". */
  confirm: string
  cancel?: string
  destructive?: boolean
}

interface Prompt {
  title: string
  message?: string
  label: string
  confirm: string
  cancel?: string
  initial?: string
  placeholder?: string
  secret?: boolean
}

/** Mount one question on the page and settle when it is answered. */
function ask<T>(render: (settle: (value: T) => void) => React.ReactNode): Promise<T> {
  return new Promise((resolve) => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const settle = (value: T) => {
      root.unmount()
      host.remove()
      resolve(value)
    }
    root.render(render(settle))
  })
}

function ConfirmSheet({ spec, settle }: { spec: Confirm; settle: (yes: boolean) => void }) {
  const titleId = useId()
  return (
    <Sheet label={spec.title} size="s" onClose={() => settle(false)} className="alert">
      <h2 id={titleId}>{spec.title}</h2>
      {spec.message && <p>{spec.message}</p>}
      <div className="sheet-actions">
        {/* Cancel first in the tab order and never the default: the one press
            that cannot hurt is the one a reflex lands on. */}
        <button type="button" onClick={() => settle(false)}>
          {spec.cancel ?? 'Cancelar'}
        </button>
        <button
          type="button"
          className={spec.destructive ? 'destructive' : 'primary'}
          onClick={() => settle(true)}
        >
          {spec.confirm}
        </button>
      </div>
    </Sheet>
  )
}

function PromptSheet({ spec, settle }: { spec: Prompt; settle: (value: string | null) => void }) {
  const [value, setValue] = useState(spec.initial ?? '')
  return (
    <Sheet label={spec.title} size="s" onClose={() => settle(null)} className="alert">
      <form
        className="sheet-form"
        onSubmit={(event) => {
          event.preventDefault()
          settle(value)
        }}
      >
        <h2>{spec.title}</h2>
        {spec.message && <p>{spec.message}</p>}
        <label className="field">
          <span>{spec.label}</span>
          <input
            // biome-ignore lint/a11y/noAutofocus: a question with one field is answered in it
            autoFocus
            type={spec.secret ? 'password' : 'text'}
            autoComplete="off"
            value={value}
            placeholder={spec.placeholder}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        <div className="sheet-actions">
          <button type="button" onClick={() => settle(null)}>
            {spec.cancel ?? 'Cancelar'}
          </button>
          <button type="submit" className="primary">
            {spec.confirm}
          </button>
        </div>
      </form>
    </Sheet>
  )
}

/**
 * The two questions, as an object so a test can answer them with a spy the
 * way it used to answer window.confirm.
 */
export const dialogo = {
  /** Resolves true only when the operator chose the named action. */
  confirmar(spec: Confirm): Promise<boolean> {
    return ask<boolean>((settle) => <ConfirmSheet spec={spec} settle={settle} />)
  },
  /** Resolves to the text typed, or null when cancelled. */
  preguntar(spec: Prompt): Promise<string | null> {
    return ask<string | null>((settle) => <PromptSheet spec={spec} settle={settle} />)
  },
}

/* -------------------------------------------------------------------------
   The toast: a moment, with a way back.
   ------------------------------------------------------------------------- */

export interface ToastState {
  text: string
  /** An error stays until it is read; news goes by itself. */
  kind: 'error' | 'info'
  action?: { label: string; run: () => void }
}

export function Toast({ toast, onClose }: { toast: ToastState; onClose: () => void }) {
  const latest = useRef(onClose)
  latest.current = onClose

  /* Information leaves after four seconds. An error does not: a problem that
     clears itself during a cue is a problem nobody read. */
  useEffect(() => {
    if (toast.kind === 'error') return
    const timer = setTimeout(() => latest.current(), 4000)
    return () => clearTimeout(timer)
  }, [toast])

  return (
    <div
      className="toast"
      data-kind={toast.kind}
      role={toast.kind === 'error' ? 'alert' : 'status'}
    >
      <span className="toast-text">{toast.text}</span>
      {toast.action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            toast.action?.run()
            latest.current()
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        className="icon-button toast-close"
        aria-label="Cerrar aviso"
        onClick={onClose}
      >
        <Icon name="close" size={16} />
      </button>
    </div>
  )
}
