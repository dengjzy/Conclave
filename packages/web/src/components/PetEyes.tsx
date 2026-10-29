import { useEffect, useId, useRef, type CSSProperties } from 'react'
import type { EyeTone, PetEye } from '../pet-face'
import type { PetRig } from '@conclave/protocol'

export function PetEyes({ rig, texture, eyes, tones, atlas, frame, lookX, lookY, reduced }: {
  rig: PetRig; texture: string; eyes: readonly PetEye[]; atlas: string; frame: number
  tones?: readonly EyeTone[]
  lookX: number; lookY: number; reduced: boolean
}) {
  const { model } = rig.eyes
  const id = useId()
  const root = useRef<SVGSVGElement>(null)
  useEffect(() => {
    const node = root.current
    if (!node || reduced) return
    let timer: ReturnType<typeof setTimeout>
    let animation = 0
    let previous = performance.now()
    let remaining = 2800 + Math.random() * 3600
    let double = false
    const paused = () => document.hidden || node.closest('[data-paused], [data-resting], [data-hidden]') !== null
    const schedule = () => { previous = performance.now(); timer = setTimeout(tick, Math.min(remaining, 200)) }
    const blink = (start: number) => {
      const elapsed = performance.now() - start
      if (paused() || elapsed >= 190) {
        node.style.setProperty('--pet-eye-open', '1')
        remaining = !double && Math.random() < .14 ? 140 : 2800 + Math.random() * 3600
        double = remaining === 140
        schedule()
        return
      }
      const openness = elapsed < 55 ? 1 - elapsed / 55 : elapsed < 85 ? 0 : (elapsed - 85) / 105
      node.style.setProperty('--pet-eye-open', String(openness))
      animation = requestAnimationFrame(() => blink(start))
    }
    const tick = () => {
      const now = performance.now()
      if (!paused()) remaining -= now - previous
      if (remaining <= 0) blink(now)
      else schedule()
    }
    schedule()
    return () => { clearTimeout(timer); cancelAnimationFrame(animation); node.style.removeProperty('--pet-eye-open') }
  }, [reduced, rig])
  const source = rig.eyes.texture
  const canonical = rig.faces.idle.eyes ?? []
  const colors = rig.eyes
  return <svg ref={root} className="pet-eyes" viewBox="0 0 256 256" aria-hidden="true" focusable="false">
    <defs>
      <radialGradient id={`${id}-feather`}><stop offset=".9" stopColor="white" /><stop offset="1" stopColor="white" stopOpacity="0" /></radialGradient>
      <mask id={`${id}-silhouette`} style={{ maskType: 'alpha' }}><image href={atlas} x={-(frame % 4) * 256} y={-Math.floor(frame / 4) * 256} width="1024" height="1024" /></mask>
    </defs>
    <g mask={`url(#${id}-silhouette)`}>
    {eyes.map((eye, index) => {
      const ref = canonical[index] ?? canonical[0]
      if (!ref) return null
      const clip = `${id}-${index}-clip`, patch = `${id}-${index}-patch`, pupil = `${id}-${index}-pupil`
      const tint = `${id}-${index}-tone`
      const [red, green, blue] = tones?.[index] ?? [0, 0, 0]
      const gaze: CSSProperties = { transform: `translate(${lookX * (model === 'stitched' ? 1.6 : eye.rx * .38)}px, ${-lookY * (model === 'stitched' ? 1.3 : eye.ry * .23)}px)` }
      return <g key={index} transform={`translate(${eye.x} ${eye.y}) rotate(${eye.angle})`}>
        <defs>
          <filter id={tint} colorInterpolationFilters="sRGB"><feColorMatrix values={`1 0 0 0 ${red / 255} 0 1 0 0 ${green / 255} 0 0 1 0 ${blue / 255} 0 0 0 1 0`} /></filter>
          <clipPath id={clip}><ellipse rx={eye.rx} ry={eye.ry} /></clipPath>
          <clipPath id={pupil}><ellipse cx={eye.rx * .2} rx={eye.rx * .73} ry={eye.ry * .84} /></clipPath>
          <mask id={patch} maskUnits="userSpaceOnUse" x={-eye.rx - 5} y={-eye.ry - 5} width={(eye.rx + 5) * 2} height={(eye.ry + 5) * 2}><ellipse rx={eye.rx + 5} ry={eye.ry + 5} fill={`url(#${id}-feather)`} /></mask>
        </defs>
        <g mask={`url(#${patch})`} filter={`url(#${tint})`}>
          <svg x={-eye.rx - 5} y={-eye.ry - 5} width={(eye.rx + 5) * 2} height={(eye.ry + 5) * 2} viewBox={`${ref.x - ref.rx - 5} ${ref.y - ref.ry - 5} ${(ref.rx + 5) * 2} ${(ref.ry + 5) * 2}`} preserveAspectRatio="none">
            <image href={texture} x={source.x - source.column * 96} y={source.y} width="288" height="80" />
          </svg>
        </g>
        <g className="pet-eyelid">
          {model !== 'stitched' && <ellipse rx={eye.rx} ry={eye.ry} fill={colors.white} stroke={colors.ink} strokeWidth={model === 'ink' ? 1.3 : .75} />}
          <g clipPath={`url(#${clip})`}>
            <g className="pet-pupil" style={gaze}>
              {model === 'ink' ? <ellipse cx={eye.rx * .58} cy="-1" rx={eye.rx * .45} ry={eye.ry * .84} fill={colors.ink} /> :
                <g clipPath={model === 'textured' ? `url(#${pupil})` : undefined}><g transform={`rotate(${-eye.angle}) translate(${-eye.x} ${-eye.y})`}><image href={atlas} x={-(frame % 4) * 256} y={-Math.floor(frame / 4) * 256} width="1024" height="1024" /></g></g>}
            </g>
          </g>
        </g>
        <path className="pet-eye-closed" d={`M${-eye.rx * .75} 0 Q0 ${eye.ry * .3} ${eye.rx * .75} 0`} fill="none" stroke={colors.ink} strokeWidth={model === 'stitched' ? 1.8 : 1.5} strokeLinecap="round" />
      </g>
    })}
    </g>
  </svg>
}
