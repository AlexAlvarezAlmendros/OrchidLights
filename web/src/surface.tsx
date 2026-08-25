/**
 * A surface: any browser as a projector.
 *
 * The page is black and owns nothing. The daemon DIRECTS -- video functions
 * started in the engine arrive as feed events with everything a screen needs
 * (source, screen index, layer, geometry, rotation) -- and this page obeys:
 * it plays /api/v1/functions/<id>/media (served without a token by the
 * confirmed decision: a bare phone or TV taped behind the stage must be able
 * to play), stacks by layer, and corrects its own drift against the sync
 * messages, because thirty minutes of film on two screens drift apart on
 * their own clocks.
 *
 * ?screen=N filters: a surface that declares itself screen 2 ignores videos
 * aimed at screen 0. Without the parameter it plays everything, which is
 * what a single-projector rig wants.
 */

import { useEffect, useRef, useState } from 'react'
import { Live, type VideoEvent } from './live'

/** How far a surface may drift before it snaps to the engine's clock. */
const DRIFT_S = 0.35

interface Playing {
  id: number
  paused: boolean
  screen: number
  fullscreen: boolean
  layer: number
  geometry?: { x: number; y: number; width: number; height: number } | undefined
  rotation?: { x: number; y: number; z: number } | undefined
}

export function Surface() {
  const [playing, setPlaying] = useState<Record<number, Playing>>({})
  const elements = useRef<Record<number, HTMLVideoElement | null>>({})

  const wanted = (() => {
    const segment = window.location.hash
      .replace(/^#/, '')
      .split('#')
      .find((s) => s.startsWith('/surface'))
    const query = segment?.split('?')[1] ?? window.location.search.replace(/^\?/, '')
    const value = new URLSearchParams(query).get('screen')
    return value === null ? null : Number(value)
  })()

  useEffect(() => {
    const feed = new Live({
      /* A surface watches films, not function lists. */
      onFunctions: () => undefined,
      onConnection: () => undefined,
      onVideo: (event: VideoEvent) => {
        if (event.action === 'stopped') {
          setPlaying((current) => {
            const { [event.id]: _gone, ...rest } = current
            return rest
          })
          return
        }

        /* Read the field the same way the store below does: a film without a
           screen is aimed at screen 0, so a surface declared ?screen=0 must
           play it rather than drop it on undefined !== 0. */
        if (wanted !== null && (event.screen ?? 0) !== wanted) return

        setPlaying((current) => ({
          ...current,
          [event.id]: {
            id: event.id,
            paused: event.paused === true,
            screen: event.screen ?? 0,
            fullscreen: event.fullscreen === true,
            layer: event.layer ?? 1,
            geometry: event.geometry,
            rotation: event.rotation,
          },
        }))

        /* The engine's clock, not ours: elapsed was true at serverTime, so
           the film should now be at elapsed plus however long the message
           took to get here. */
        const element = elements.current[event.id]
        if (element !== undefined && element !== null && event.elapsed !== undefined) {
          const target =
            (event.elapsed + Math.max(0, Date.now() - (event.serverTime ?? Date.now()))) / 1000
          if (Math.abs(element.currentTime - target) > DRIFT_S) {
            element.currentTime = target
          }
          if (event.paused === true) element.pause()
          else void element.play().catch(() => undefined)
        }
      },
    })
    feed.connect()
    return () => feed.close()
  }, [wanted])

  return (
    <div className="surface">
      {Object.values(playing).map((video) => (
        <video
          key={video.id}
          ref={(element) => {
            elements.current[video.id] = element
          }}
          className="surface-video"
          src={`/api/v1/functions/${video.id}/media`}
          autoPlay
          muted={false}
          controls={false}
          style={{
            zIndex: video.layer,
            ...(video.geometry
              ? {
                  left: `${video.geometry.x}px`,
                  top: `${video.geometry.y}px`,
                  width: `${video.geometry.width}px`,
                  height: `${video.geometry.height}px`,
                }
              : { inset: 0, width: '100%', height: '100%' }),
            ...(video.rotation
              ? {
                  transform: `rotateX(${video.rotation.x}deg) rotateY(${video.rotation.y}deg) rotateZ(${video.rotation.z}deg)`,
                }
              : {}),
          }}
        />
      ))}
    </div>
  )
}
