/**
 * The assistant's settings: which provider, which model, the key, and what it
 * has spent today.
 *
 * The key is typed here and goes to the daemon, which keeps it and never
 * gives it back -- this screen only ever learns whether there is one and its
 * last four characters. So the field is always empty: a filled one would be a
 * key sitting in a browser, which is what keeping it in the daemon avoids.
 *
 * Only the master key changes them. Any other caller sees a line saying how
 * the assistant is set up, because offering a form the daemon will refuse is
 * a form that lies.
 */

import { useEffect, useState } from 'react'
import { type AiCheck, type AiProviderName, type AiSettings, api } from './api'
import { t } from './i18n'

const PROVIDER_LABEL: Record<AiProviderName, string> = {
  anthropic: 'Anthropic',
  openai: 'Compatible con OpenAI',
}

/* The OpenAI dialect is spoken by more than OpenAI: one address away from
   each. Said here so nobody has to look them up mid-setup. */
const OPENAI_DOORS =
  'Ollama: http://localhost:11434/v1 · LM Studio: http://localhost:1234/v1 · ' +
  'OpenRouter: https://openrouter.ai/api/v1 · ' +
  'Gemini: https://generativelanguage.googleapis.com/v1beta/openai'

interface Draft {
  provider: AiProviderName
  model: string
  baseUrl: string
  /** What was typed; empty means "keep the stored one". */
  key: string
  dailyRequests: string
}

function draftOf(settings: AiSettings, provider: AiProviderName = settings.provider): Draft {
  return {
    provider,
    model: settings.providers[provider].model,
    baseUrl: settings.providers[provider].baseUrl,
    key: '',
    dailyRequests: String(settings.dailyRequests),
  }
}

function thousands(n: number): string {
  return n >= 10000 ? `${Math.round(n / 1000)}k` : String(n)
}

export function AssistantSettings() {
  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [master, setMaster] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [check, setCheck] = useState<AiCheck | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([api.access(), api.aiSettings()])
      .then(([access, next]) => {
        setMaster(access.role === 'master')
        setSettings(next)
        setDraft(draftOf(next))
      })
      /* An older daemon has no assistant: say nothing rather than an error
         about a feature it never had. */
      .catch(() => setSettings(null))
  }, [])

  if (settings === null || draft === null) return null

  const stored = settings.providers[draft.provider]

  if (!master) {
    const active = settings.providers[settings.provider]
    return (
      <section className="assistant-settings">
        <h3>{t('Asistente')}</h3>
        <p className="hint">
          {t(PROVIDER_LABEL[settings.provider])}
          {active.model ? ` · ${active.model}` : ''} ·{' '}
          {active.configured || settings.provider === 'openai' ? t('listo') : t('sin clave')}
        </p>
        <p className="hint">
          {t('Se configura desde el equipo de la mesa, con su llave maestra.')}
        </p>
      </section>
    )
  }

  const daily = Number(draft.dailyRequests)
  const dailyValid = draft.dailyRequests.trim() !== '' && Number.isInteger(daily) && daily >= 0

  const dirty =
    draft.provider !== settings.provider ||
    draft.model !== stored.model ||
    draft.baseUrl !== stored.baseUrl ||
    draft.key.trim() !== '' ||
    (dailyValid && daily !== settings.dailyRequests)

  /* Only what changed goes out: the daemon keeps a key nobody retyped, and a
     PUT that resent every field would reset what another screen just set. */
  const save = async (extra?: { key?: string }) => {
    const fields: { model?: string; baseUrl?: string; key?: string } = {}
    if (draft.model !== stored.model) fields.model = draft.model.trim()
    if (draft.baseUrl !== stored.baseUrl) fields.baseUrl = draft.baseUrl.trim()
    if (draft.key.trim() !== '') fields.key = draft.key.trim()
    if (extra?.key !== undefined) fields.key = extra.key

    const next = await api.setAiSettings({
      ...(draft.provider !== settings.provider ? { provider: draft.provider } : {}),
      ...(dailyValid && daily !== settings.dailyRequests ? { dailyRequests: daily } : {}),
      ...(Object.keys(fields).length > 0 ? { providers: { [draft.provider]: fields } } : {}),
    })
    setSettings(next)
    setDraft(draftOf(next, draft.provider))
    return next
  }

  const act = (work: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    work()
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false))
  }

  /* Trying is saving first: the daemon tests the key it holds, and a check of
     the old key while the new one sits in the field answers a question
     nobody asked. */
  const tryIt = () =>
    act(async () => {
      setCheck(null)
      if (dirty) await save()
      setCheck(await api.checkAi(draft.provider))
    })

  const models = check?.ok && check.provider === draft.provider ? (check.models ?? []) : []

  return (
    <section className="assistant-settings">
      <h3>{t('Asistente')}</h3>

      <label className="field">
        <span>{t('Proveedor')}</span>
        <select
          value={draft.provider}
          onChange={(e) => {
            setCheck(null)
            setDraft({ ...draftOf(settings, e.target.value as AiProviderName) })
          }}
        >
          <option value="anthropic">{t(PROVIDER_LABEL.anthropic)}</option>
          <option value="openai">{t(PROVIDER_LABEL.openai)}</option>
        </select>
      </label>

      <label className="field">
        <span>{t('Clave')}</span>
        <input
          type="password"
          autoComplete="off"
          value={draft.key}
          placeholder={
            stored.configured
              ? `${t('Guardada')} ${stored.keyHint}`.trim()
              : draft.provider === 'openai'
                ? t('Ninguna (un modelo local no la pide)')
                : t('Pega aquí la clave')
          }
          onChange={(e) => setDraft({ ...draft, key: e.target.value })}
        />
      </label>

      <label className="field">
        <span>{t('Modelo')}</span>
        <input
          list="assistant-models"
          value={draft.model}
          placeholder={draft.provider === 'openai' ? 'gpt-…, llama3, gemini-…' : 'claude-opus-5-5'}
          onChange={(e) => setDraft({ ...draft, model: e.target.value })}
        />
        <datalist id="assistant-models">
          {models.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
      </label>

      <label className="field">
        <span>{t('Dirección del servicio')}</span>
        <input
          value={draft.baseUrl}
          onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
        />
      </label>
      {draft.provider === 'openai' && <p className="hint">{OPENAI_DOORS}</p>}

      <label className="field">
        <span>{t('Peticiones por dispositivo y día')}</span>
        <input
          type="number"
          min={0}
          step={1}
          value={draft.dailyRequests}
          onChange={(e) => setDraft({ ...draft, dailyRequests: e.target.value })}
        />
      </label>
      <p className="hint">
        {t('Cuenta para los móviles emparejados; la mesa misma no tiene tope. 0 es sin tope.')}
      </p>

      <div className="assistant-actions">
        <button type="button" disabled={busy || !dirty || !dailyValid} onClick={() => act(save)}>
          {t('Guardar')}
        </button>
        <button type="button" disabled={busy || !dailyValid} onClick={tryIt}>
          {t('Probar')}
        </button>
        {stored.configured && (
          <button type="button" disabled={busy} onClick={() => act(() => save({ key: '' }))}>
            {t('Quitar la clave')}
          </button>
        )}
      </div>

      {check && (
        <p className={check.ok ? 'hint' : 'remote-error'} role={check.ok ? 'status' : 'alert'}>
          {check.ok
            ? `${t('Funciona')} · ${check.models?.length ?? 0} ${t('modelos')}`
            : `${t('No funciona')}: ${check.error ?? check.status}`}
        </p>
      )}
      {error && (
        <p className="remote-error" role="alert">
          {error}
        </p>
      )}

      <p className="hint">
        {t('Hoy')}: {settings.usage.requests} {t('peticiones')} ·{' '}
        {thousands(settings.usage.inputTokens)} {t('tokens de entrada')} ·{' '}
        {thousands(settings.usage.outputTokens)} {t('de salida')}
      </p>
    </section>
  )
}
