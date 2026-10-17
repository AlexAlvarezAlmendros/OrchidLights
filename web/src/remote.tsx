/**
 * Remote access, as a thing the operator can see.
 *
 * Three questions a desk on a venue network gets asked mid-show: "how do I
 * get in from this phone?", "which phones may?" and "who is on my desk right
 * now?". This screen answers them from one place: every reachable door, the
 * paired devices -- each with a key of its own and a role, revocable one by
 * one -- and the live list of connections, each with the door out.
 *
 * Pairing is how a phone gets in. The doors carry no key: the master key in a
 * QR made every phone that scanned it the owner of the desk. A paired phone's
 * QR carries ITS key, shown once, and an operator's phone is held to the
 * console by the daemon, not by this screen.
 *
 * Honesty rules the edges. A daemon listening only on loopback shows no
 * network doors, because a QR code to a URL that does not answer is worse
 * than none; and only the desk's own machine -- the master key -- sees the
 * device list at all.
 */

import qrcode from 'qrcode-generator'
import { useCallback, useEffect, useState } from 'react'
import { type Device, type DeviceRole, Unauthorized, api } from './api'
import { t } from './i18n'

type RemoteState = Awaited<ReturnType<typeof api.remote>>
type Paired = Awaited<ReturnType<typeof api.pairDevice>>

const ROLE_LABEL: Record<string, string> = {
  operate: 'Operar',
  design: 'Diseñar',
  master: 'Llave maestra',
  open: 'Sin llave',
}

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

/**
 * The paired devices, and the one-time QR of a device just paired.
 *
 * Revoking is two presses: a revoked phone has to be paired again from here,
 * and a single mis-tap mid-show is exactly how that happens.
 */
function DevicesSection({ revision, listening }: { revision: number; listening: boolean }) {
  const [devices, setDevices] = useState<Device[] | null>(null)
  const [masterOnly, setMasterOnly] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [role, setRole] = useState<DeviceRole>('operate')
  const [paired, setPaired] = useState<Paired | null>(null)
  const [arming, setArming] = useState<number | null>(null)

  const refresh = useCallback(() => {
    api
      .devices()
      .then((next) => {
        setDevices(next.devices)
        setMasterOnly(false)
      })
      .catch((cause: unknown) => {
        if (cause instanceof Unauthorized) setMasterOnly(true)
        else setError(cause instanceof Error ? cause.message : String(cause))
      })
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` is the refetch trigger -- connections coming and going change each device's count
  useEffect(refresh, [refresh, revision])

  const act = (work: Promise<unknown>) => {
    setError(null)
    work.then(refresh).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause))
      refresh()
    })
  }

  const pair = () => {
    setError(null)
    api
      .pairDevice(name.trim(), role)
      .then((made) => {
        setPaired(made)
        setName('')
        refresh()
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
  }

  if (masterOnly) {
    return (
      <section>
        <h2 className="section">{t('Dispositivos')}</h2>
        <p className="remote-empty">
          {t('Los dispositivos se emparejan desde el equipo de la mesa, con su llave maestra.')}
        </p>
      </section>
    )
  }
  if (devices === null) return null

  const door = paired?.urls[0]

  return (
    <section>
      <h2 className="section">
        {t('Dispositivos')} · {devices.length}
      </h2>

      {paired && (
        <article className="remote-door remote-paired" aria-live="polite">
          <header>
            <strong>{paired.name}</strong>
            <span className="remote-iface">{t(ROLE_LABEL[paired.role] ?? paired.role)}</span>
          </header>
          {door ? (
            <>
              <Qr text={door.url} />
              <code className="remote-url">{door.url}</code>
            </>
          ) : (
            <p className="remote-empty">
              {t('El motor solo escucha en este equipo: el móvil no llegará hasta arrancarlo con')}{' '}
              <code>--listen-all</code>. {t('Su llave:')}{' '}
              <code className="remote-url">{paired.key}</code>
            </p>
          )}
          <p className="remote-note">
            {t('Esta llave solo se enseña ahora: escanéala desde el móvil antes de cerrar.')}
          </p>
          <button type="button" onClick={() => setPaired(null)}>
            {t('Hecho')}
          </button>
        </article>
      )}

      <form
        className="remote-pair"
        onSubmit={(event) => {
          event.preventDefault()
          if (name.trim() !== '') pair()
        }}
      >
        <label className="field">
          <span>{t('Nombre')}</span>
          <input
            id="device-name"
            value={name}
            maxLength={64}
            placeholder={t('Truss izquierdo')}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="field">
          <span>{t('Rol')}</span>
          <select
            id="device-role"
            value={role}
            onChange={(event) => setRole(event.target.value as DeviceRole)}
          >
            <option value="operate">{t('Operar')}</option>
            <option value="design">{t('Diseñar')}</option>
          </select>
        </label>
        <button type="submit" disabled={name.trim() === ''}>
          {t('Emparejar')}
        </button>
      </form>
      <p className="remote-note">
        {role === 'operate'
          ? t('Operar: la consola y la mesa simple, bajo la máscara. No edita nada.')
          : t('Diseñar: toda la mesa salvo el disco, el apagado, la máscara y los dispositivos.')}
        {!listening &&
          ` ${t('El motor solo escucha en este equipo: arráncalo con --listen-all para que lleguen los móviles.')}`}
      </p>

      {error && (
        <p className="remote-error" role="alert">
          {error}
        </p>
      )}

      {devices.length === 0 ? (
        <p className="remote-empty">{t('Ningún dispositivo emparejado todavía.')}</p>
      ) : (
        <ul className="remote-clients">
          {devices.map((device) => (
            <li key={device.id} data-device-id={device.id}>
              <div className="remote-who">
                <strong>{device.name}</strong>
                <span>
                  {device.lastSeen
                    ? `${t('visto a las')} ${since(device.lastSeen)}`
                    : t('sin estrenar')}
                  {device.connections > 0 && ` · ${device.connections} ${t('conectado')}`}
                </span>
              </div>
              <div className="remote-actions">
                <select
                  aria-label={`${t('Rol de')} ${device.name}`}
                  value={device.role}
                  onChange={(event) =>
                    act(api.updateDevice(device.id, { role: event.target.value as DeviceRole }))
                  }
                >
                  <option value="operate">{t('Operar')}</option>
                  <option value="design">{t('Diseñar')}</option>
                </select>
                <button
                  type="button"
                  className="danger"
                  onBlur={() => setArming(null)}
                  onClick={() => {
                    if (arming !== device.id) {
                      setArming(device.id)
                      return
                    }
                    setArming(null)
                    act(api.revokeDevice(device.id))
                  }}
                >
                  {arming === device.id ? t('¿Revocar?') : t('Revocar')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
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
            {t('La URL no lleva llave: empareja el móvil abajo para darle la suya.')}
          </p>
        )}
      </section>

      <DevicesSection revision={revision} listening={state.listenAll} />

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
                    {client.device
                      ? ` · ${client.device} (${t(ROLE_LABEL[client.role ?? 'open'] ?? '')})`
                      : client.role === 'master'
                        ? ` · ${t('Llave maestra')}`
                        : client.trusted && ` · ${t('con llave')}`}
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
