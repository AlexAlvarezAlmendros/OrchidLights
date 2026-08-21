/**
 * The Simple Desk: every channel of a universe, held by hand.
 *
 * Raw DMX, deliberately below the console's abstractions: any of the 512
 * addresses can be grabbed WHETHER OR NOT a fixture is patched there -- the
 * house light on channel 500 nobody bothered to patch is exactly what this
 * screen is for. A held channel carries the engine's Override flag, so the
 * desk beats whatever function is running on it; releasing it lets the
 * function show through again.
 *
 * The values on screen are the frames off the wire, not an echo of what was
 * asked: what this desk shows is what the rig receives, grand master and all.
 *
 * The keypad speaks the engine's own grammar (`1 THRU 10 AT FULL`,
 * `500 -% 10`) through the daemon's parser, so a command means here exactly
 * what it means in QLC+ 5.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type FixtureState, type UniverseState, api } from './api'
import { Slider } from './slider'

const PER_PAGE = 96

export function Mesa({
  fixtures,
  frames,
  held,
  onHeld,
  onError,
}: {
  fixtures: FixtureState[]
  /** Latest frame per universe (1-based), straight from the feed. */
  frames: Record<number, Uint8Array>
  /** What the desk is holding: universe -> { '1-based channel': value }. */
  held: Record<number, Record<string, number>>
  onHeld: (universe: number, channels: Record<string, number>) => void
  onError: (message: string) => void
}) {
  const [universes, setUniverses] = useState<UniverseState[]>([])
  const [universe, setUniverse] = useState(1)

  useEffect(() => {
    api
      .universes()
      .then(setUniverses)
      .catch(() => setUniverses([]))
  }, [])
  const [page, setPage] = useState(0)
  const [command, setCommand] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const commandField = useRef<HTMLInputElement | null>(null)

  const fail = useCallback(
    (e: unknown) => onError(e instanceof Error ? e.message : String(e)),
    [onError],
  )

  /* Seeded once per universe visit; the WS event keeps it fresh after. */
  useEffect(() => {
    api
      .deskHeld(universe)
      .then((body) => onHeld(universe, body.held))
      .catch(fail)
  }, [universe, onHeld, fail])

  /* Which fixture sits on each address, for the banding and the jump list.
     Banding alternates PER FIXTURE, not per channel: the eye needs to see
     where one lamp ends and the next begins. */
  const occupancy = useMemo(() => {
    const byAddress = new Array<{ fixture: FixtureState; band: 0 | 1 } | null>(512).fill(null)
    const here = fixtures
      .filter((f) => f.universe === universe)
      .sort((a, b) => a.address - b.address)
    here.forEach((fixture, index) => {
      const band = (index % 2) as 0 | 1
      for (let c = 0; c < fixture.channels; c++) {
        const address = fixture.address - 1 + c
        if (address >= 0 && address < 512) byAddress[address] = { fixture, band }
      }
    })
    return { byAddress, fixtures: here }
  }, [fixtures, universe])

  const frame = frames[universe]
  const heldHere = held[universe] ?? {}

  const setChannel = (channel: number, value: number) => {
    api.deskSet(universe, { [String(channel)]: value }).catch(fail)
    /* Optimistic grip: the WS echo confirms, but the hand must not lag. */
    onHeld(universe, { ...heldHere, [String(channel)]: value })
  }

  const releaseChannel = (channel: number) => {
    api.deskReleaseChannel(universe, channel).catch(fail)
    const next = { ...heldHere }
    delete next[String(channel)]
    onHeld(universe, next)
  }

  const releaseUniverse = () => {
    api.deskReleaseUniverse(universe).catch(fail)
    onHeld(universe, {})
  }

  const send = () => {
    const trimmed = command.trim()
    if (trimmed === '') return
    api
      .deskKeypad(universe, trimmed)
      .then(() => {
        setHistory((current) => [trimmed, ...current].slice(0, 8))
        setCommand('')
      })
      .catch(fail)
    commandField.current?.focus()
  }

  const start = page * PER_PAGE
  const channels = Array.from({ length: PER_PAGE }, (_, i) => start + i).filter((c) => c < 512)
  const pageCount = Math.ceil(512 / PER_PAGE)
  const heldCount = Object.keys(heldHere).length

  return (
    <div className="mesa">
      <header className="mesa-bar">
        <label className="field">
          <span>Universo</span>
          <select
            value={universe}
            onChange={(e) => {
              setUniverse(Number(e.target.value))
              setPage(0)
            }}
          >
            {universes.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>

        {occupancy.fixtures.length > 0 && (
          <label className="field">
            <span>Ir a</span>
            <select
              value=""
              onChange={(e) => {
                const address = Number(e.target.value)
                if (Number.isNaN(address)) return
                setPage(Math.floor((address - 1) / PER_PAGE))
              }}
            >
              <option value="">— fixture —</option>
              {occupancy.fixtures.map((f) => (
                <option key={f.id} value={f.address}>
                  {f.name} · {f.address}
                </option>
              ))}
            </select>
          </label>
        )}

        <span className="spacer" />

        {heldCount > 0 && <span className="chip mesa-heldcount num">{heldCount} en mano</span>}
        <button
          type="button"
          disabled={heldCount === 0}
          title={heldCount === 0 ? 'La mesa no sujeta nada en este universo' : undefined}
          onClick={releaseUniverse}
        >
          Soltar universo
        </button>
      </header>

      <div className="mesa-grid">
        {channels.map((index) => {
          const address = index + 1
          const value = frame?.[index] ?? 0
          const holding = heldHere[String(address)] !== undefined
          const occupant = occupancy.byAddress[index]

          return (
            <div
              key={address}
              className="mesa-channel"
              data-held={holding}
              data-band={occupant?.band ?? 'none'}
              title={occupant ? `${occupant.fixture.name}` : 'Sin fixture'}
            >
              <span className="mesa-address num">{address}</span>
              <span className="mesa-value num">{value}</span>
              <Slider
                min={0}
                max={255}
                value={holding ? (heldHere[String(address)] ?? value) : value}
                aria-label={`Canal ${address}`}
                onChange={(e) => setChannel(address, Number(e.target.value))}
              />
              {/* Only a held channel offers release: an X on every channel
                  would promise an undo the desk does not have for values it
                  never touched. */}
              {holding && (
                <button
                  type="button"
                  className="mesa-release"
                  aria-label={`Soltar canal ${address}`}
                  title="Soltar: la función de debajo vuelve a mandar"
                  onClick={() => releaseChannel(address)}
                >
                  ✕
                </button>
              )}
            </div>
          )
        })}
      </div>

      <footer className="mesa-foot">
        <nav className="mesa-pages" aria-label="Páginas de canales">
          {Array.from({ length: pageCount }, (_, i) => (
            <button
              key={`p${i * PER_PAGE}`}
              type="button"
              aria-pressed={i === page}
              onClick={() => setPage(i)}
            >
              {i * PER_PAGE + 1}–{Math.min(512, (i + 1) * PER_PAGE)}
            </button>
          ))}
        </nav>

        <div className="mesa-keypad">
          <input
            ref={commandField}
            value={command}
            placeholder="1 THRU 10 AT FULL"
            aria-label="Orden de teclado"
            onChange={(e) => setCommand(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === 'Enter') send()
            }}
          />
          {['AT', 'THRU', 'FULL', 'ZERO', 'BY', '+', '-', '+%', '-%'].map((token) => (
            <button
              key={token}
              type="button"
              onClick={() => {
                setCommand(
                  (current) =>
                    `${current}${current.endsWith(' ') || current === '' ? '' : ' '}${token} `,
                )
                commandField.current?.focus()
              }}
            >
              {token}
            </button>
          ))}
          <button type="button" onClick={() => setCommand('')}>
            CLR
          </button>
          <button type="button" className="mesa-enter" onClick={send}>
            ENTER
          </button>
        </div>

        {history.length > 0 && (
          <div className="mesa-history" aria-label="Órdenes recientes">
            {/* Deduplicated so the command itself can be the key -- and a
                history where "FULL, FULL, FULL" collapses to one chip is the
                better history anyway. */}
            {[...new Set(history)].map((entry) => (
              <button key={entry} type="button" className="chip" onClick={() => setCommand(entry)}>
                {entry}
              </button>
            ))}
          </div>
        )}
      </footer>
    </div>
  )
}
