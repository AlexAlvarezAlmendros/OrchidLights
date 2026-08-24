/**
 * Remote access, as a thing the operator can see.
 *
 * Two questions a desk on a venue network gets asked mid-show: "how do I get
 * in from this phone?" and "who is on my desk right now?". This screen answers
 * both from one place: every reachable door as a URL with its QR code -- scan,
 * and the phone is on the desk, token included -- and the live list of
 * connections, each with the one control that matters: the door out.
 *
 * Honesty rules the edges. A daemon listening only on loopback shows no
 * network doors, because a QR code to a URL that does not answer is worse
 * than none; and the join URL carries the token only when the daemon judged
 * this client worthy of it (see the API note on masks).
 */

import qrcode from 'qrcode-generator'
import { useCallback, useEffect, useState } from 'react'
import { api } from './api'
import { t } from './i18n'

type RemoteState = Awaited<ReturnType<typeof api.remote>>

/** The QR as an SVG path: one rect per dark module is thousands of nodes; one
 *  path is one. Error level M and auto-sizing carry a URL with a 64-hex token
 *  comfortably. */
function qrPath(text: string): { path: string; modules: number } {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()

  const modules = qr.getModuleCount()
  let path = ''
  for (let row = 0; row < modules; row++) {
    for (let col = 0; col < modules; col++) {
      if (qr.isDark(row, col)) path += `M${col} ${row}h1v1h-1z`
    }
  }
  return { path, modules }
}

function Qr({ text }: { text: string }) {
  const { path, modules } = qrPath(text)
  return (
    <svg
      className="qr"
      viewBox={`-2 -2 ${modules + 4} ${modules + 4}`}
      role="img"
      aria-label={t('Código QR de acceso')}
    >
      {/* Always dark-on-light, whatever the theme: a camera reads contrast,
          not design systems. The quiet zone is part of the spec. */}
      <rect x={-2} y={-2} width={modules + 4} height={modules + 4} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  )
}

function since(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function RemotePanel({ revision }: { revision: number }) {
  const [state, setState] = useState<RemoteState | null>(null)
  const [failed, setFailed] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  const refresh = useCallback(() => {
    api
      .remote()
      .then((next) => {
        setState(next)
        setFailed(false)
      })
      .catch(() => setFailed(true))
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` is the refetch trigger -- the feed bumps it when a connection comes or goes
  useEffect(refresh, [refresh, revision])

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(url)
      window.setTimeout(() => setCopied(null), 1500)
    } catch {
      /* No clipboard (plain http on a phone): the URL is selectable text
         right above the button, and pretending it was copied is a lie. */
    }
  }

  if (failed) return <p className="remote-empty">{t('El motor no responde')}</p>
  if (state === null) return null

  return (
    <div className="remote">
      <section>
        <h2 className="section">{t('Acceso desde la red')}</h2>

        {state.listenAll ? (
          state.addresses.length === 0 ? (
            <p className="remote-empty">
              {t(
                'El motor escucha en toda la red, pero este equipo no tiene ninguna dirección de red ahora mismo.',
              )}
            </p>
          ) : (
            <div className="remote-doors">
              {state.addresses.map((door) => (
                <article className="remote-door" key={door.ip}>
                  <header>
                    <strong>{door.ip}</strong>
                    <span className="remote-iface">{door.interface}</span>
                  </header>
                  <Qr text={door.url} />
                  <code className="remote-url">{door.url}</code>
                  <button type="button" onClick={() => void copy(door.url)}>
                    {copied === door.url ? t('Copiada') : t('Copiar URL')}
                  </button>
                </article>
              ))}
            </div>
          )
        ) : (
          <p className="remote-empty">
            {t('El motor solo escucha en este equipo')} (<code>{state.localUrl}</code>).{' '}
            {t('Para abrirlo a los móviles de la red, arranca el daemon con')}{' '}
            <code>--listen-all</code>.
          </p>
        )}

        {state.authRequired && state.addresses.length > 0 && (
          <p className="remote-note">
            {t('La URL lleva la llave de esta mesa: compártela solo con quien deba tocarla.')}
          </p>
        )}
      </section>

      <section>
        <h2 className="section">
          {t('Conectados')} · {state.clients.length}
        </h2>

        {state.clients.length === 0 ? (
          <p className="remote-empty">{t('Nadie más está conectado ahora mismo.')}</p>
        ) : (
          <ul className="remote-clients">
            {state.clients.map((client) => (
              <li key={client.id} data-client-id={client.id}>
                <div className="remote-who">
                  <strong>{client.address}</strong>
                  <span>
                    {t('desde las')} {since(client.connectedAt)}
                    {client.trusted && ` · ${t('con llave')}`}
                    {client.universes > 0 && ` · ${client.universes} DMX`}
                  </span>
                </div>
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    api
                      .kickRemote(client.id)
                      .then(refresh)
                      .catch(() => refresh())
                  }}
                >
                  {t('Desconectar')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
