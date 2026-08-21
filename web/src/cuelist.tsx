/**
 * A cue list: the control a show is actually run from.
 *
 * A cue list is a chaser plus transport. The steps come from the chaser, the
 * cue that is up comes from the live feed, and the buttons go back over the
 * same socket -- so two people running the same show from two phones see the
 * same cue, because neither of them is the source of truth.
 */

import { useEffect, useState } from 'react'
import { type FunctionState, api } from './api'
import type { VcWidget } from './layout'

export interface Step {
  index: number
  function: number
  name: string
  /** The operator's own name for the step, absent when it just wears its
   *  function's. */
  note?: string
  fadeIn: number
  hold: number
  fadeOut: number
  duration: number
  /** Sequence steps: the DMX this step holds. */
  values?: { fixture: number; channel: number; value: number }[]
}

export function CueList({
  widget,
  style,
  functions,
  onCommand,
}: {
  widget: VcWidget
  style: React.CSSProperties
  functions: FunctionState[]
  onCommand: (
    chaser: number,
    action: 'play' | 'stop' | 'next' | 'previous' | 'step',
    index?: number,
  ) => void
}) {
  const chaser = widget.chaserId
  const [steps, setSteps] = useState<Step[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (chaser === undefined) return
    let live = true
    api
      .functionBody(chaser)
      .then((body) => live && setSteps(body.steps ?? []))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [chaser])

  if (chaser === undefined || chaser >= 0xffffffff) {
    return (
      <div className="widget unsupported" style={style}>
        <span>
          {widget.caption || 'Cue list'}
          <br />
          <small>sin chaser</small>
        </span>
      </div>
    )
  }

  // The live one, not the one fetched with the steps: this is what makes the
  // list follow the show rather than describe it.
  const state = functions.find((f) => f.id === chaser)
  const current = state?.running ? (state.step ?? -1) : -1

  return (
    <div className="widget cuelist" style={style} data-running={state?.running === true}>
      <div className="cuelist-head">
        <strong>{widget.caption || state?.name || 'Cue list'}</strong>
        <span className="spacer" />
        <button
          type="button"
          className="cuelist-transport"
          aria-label="Anterior"
          onClick={() => onCommand(chaser, 'previous')}
        >
          ⏮
        </button>
        <button
          type="button"
          className="cuelist-transport"
          aria-label={state?.running ? 'Parar' : 'Reproducir'}
          aria-pressed={state?.running === true}
          onClick={() => onCommand(chaser, state?.running ? 'stop' : 'play')}
        >
          {state?.running ? '⏹' : '▶'}
        </button>
        <button
          type="button"
          className="cuelist-transport"
          aria-label="Siguiente"
          onClick={() => onCommand(chaser, 'next')}
        >
          ⏭
        </button>
      </div>

      {error && <p className="hint">{error}</p>}

      <ol className="cuelist-steps">
        {(steps ?? []).map((step) => (
          <li key={step.index} data-current={step.index === current}>
            {/* Jumping straight to a cue: on a desk this is what the operator
                does when the show skips a number. */}
            <button type="button" onClick={() => onCommand(chaser, 'step', step.index)}>
              <span className="cue-number">{step.index + 1}</span>
              <span className="cue-name">{step.name}</span>
              <span className="cue-time">{formatTime(step)}</span>
            </button>
          </li>
        ))}
      </ol>

      {steps !== null && steps.length === 0 && <p className="hint">Este chaser no tiene pasos.</p>}
    </div>
  )
}

/** Fade in / hold, the two an operator reads off a cue sheet. */
function formatTime(step: Step) {
  const seconds = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`)
  return `${seconds(step.fadeIn)} / ${seconds(step.hold)}`
}
