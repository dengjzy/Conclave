import type { CSSProperties, ReactNode } from 'react'
import type { PetSkin, PetSkinProps } from './pet-skin'
import './ant-skin.css'

// Drawn from its bottom centre, so a pose places it by where it rests.
export function Parcel({ width = 26, height = 18 }: { width?: number; height?: number }) {
  const half = width / 2
  const depth = 4
  return (
    <g className="ant-parcel">
      <path className="ant-parcel-top" d={`M${-half} ${-height}l${depth} ${-depth}h${width}l${-depth} ${depth}z`} />
      <path className="ant-parcel-side" d={`M${half} 0v${-height}l${depth} ${-depth}v${height}z`} />
      <rect className="ant-parcel-front" x={-half} y={-height} width={width} height={height} rx="1.5" />
      <path className="ant-parcel-tape" d={`M-2.5 ${0.6 - height}h5V-.6h-5z M-2 ${-height}l${depth} ${-depth}h4.5l${-depth} ${depth}z`} />
      <path className="ant-parcel-mark" d={`M${half - 9} -6.5h5 M${half - 9} -4h3`} />
    </g>
  )
}

// Faces right with its feet on y=70. Legs step as two tripods (a, b), as real ants do; how far they
// swing, whether the front pair holds something up and where the head looks are CSS properties a
// pose animates, so the same figure walks, sits, clings, sprints and sleeps.
export function AntFigure({ asleep = false }: { asleep?: boolean }) {
  return (
    <g className="ant-figure">
      <g className="ant-legs-far">
        <path className="ant-leg ant-leg-hf" data-tripod="b" d="M51 45L44 55L40 69l-3 1" />
        <path className="ant-leg ant-leg-mf" data-tripod="a" d="M56 46L60 57L64 69l3 1" />
        <g className="ant-leg ant-leg-front ant-leg-ff" data-tripod="b">
          <path d="M61 45L70 51" />
          <path className="ant-tibia" d="M70 51L76 69l3 1" />
        </g>
      </g>
      <g className="ant-gaster">
        <ellipse className="ant-shell" cx="24" cy="44" rx="17" ry="13" transform="rotate(-14 24 44)" />
        <path className="ant-stripe" d="M18 33.5q-3.5 9 .5 19.5 M27.5 31.5q-3.5 10 .5 20.5" />
        <ellipse className="ant-sheen" cx="19" cy="37.5" rx="7" ry="3" transform="rotate(-24 19 37.5)" />
      </g>
      <circle className="ant-shell" cx="42" cy="45" r="3.8" />
      <ellipse className="ant-shell" cx="53" cy="41" rx="10.5" ry="7.5" transform="rotate(-20 53 41)" />
      <ellipse className="ant-sheen" cx="50.5" cy="37" rx="4" ry="1.7" transform="rotate(-26 50.5 37)" />
      <g className="ant-head">
        <g className="ant-antenna ant-antenna-far">
          <path d="M68 20Q65 13 66 9Q71 4 77 2" />
          <circle cx="77.5" cy="2" r="1.9" />
        </g>
        <ellipse className="ant-shell" cx="72" cy="31" rx="13.5" ry="12.5" transform="rotate(-8 72 31)" />
        <ellipse className="ant-sheen" cx="66.5" cy="23.5" rx="5" ry="2.3" transform="rotate(-20 66.5 23.5)" />
        <path className="ant-smile" d="M80.5 39.5q2.6 1.6 5-.6" />
        <path className="ant-frown" d="M80.5 40.5q2.6-1.6 5 .6" />
        <ellipse className="ant-blush" cx="80.5" cy="36.5" rx="3" ry="1.7" />
        {asleep ? (
          <path className="ant-eye-closed" d="M73 29q4 3.5 8 0" />
        ) : (
          <g className="ant-eye">
            <ellipse className="ant-eye-white" cx="77" cy="28" rx="4.8" ry="5.6" />
            <g className="ant-gaze">
              <circle className="ant-pupil" cx="78.6" cy="28.8" r="3" />
              <circle className="ant-glint" cx="79.8" cy="27.1" r="1.1" />
            </g>
          </g>
        )}
        <g className="ant-antenna ant-antenna-near">
          <path d="M74 20Q72 14 73 10Q79 6 85 5" />
          <circle cx="85.5" cy="5" r="1.9" />
        </g>
      </g>
      <g className="ant-legs-near">
        <path className="ant-leg ant-leg-hn" data-tripod="a" d="M48 46L39 55L34 69l-3 1" />
        <path className="ant-leg ant-leg-mn" data-tripod="b" d="M53 47L54 57L57 69l3 1" />
        <g className="ant-leg ant-leg-front ant-leg-fn" data-tripod="a">
          <path d="M58 46L66 52" />
          <path className="ant-tibia" d="M66 52L70 69l3 1" />
        </g>
      </g>
    </g>
  )
}

// The figure's own units: it spans about x 7–87 and y 0–70, feet on 70. The box leaves room for
// the antennae and a hop above, and the speed lines behind.
const VIEW = { x: -2, y: -10, width: 98, height: 80 }
const HEIGHT = 34

function AntBody({ pose, walking, lookX, lookY, reduced }: PetSkinProps): ReactNode {
  const style: CSSProperties & Record<'--ant-look-x' | '--ant-look-y', number> = { '--ant-look-x': lookX, '--ant-look-y': lookY }
  return (
    <svg
      className="ant-skin"
      viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.width} ${VIEW.height}`}
      data-pose={pose}
      data-walking={walking || undefined}
      data-reduced={reduced || undefined}
      style={style}
      focusable="false"
      aria-hidden="true"
    >
      <g className="ant-speed">
        <path d="M2 46h14 M-2 54h18 M4 62h12" />
      </g>
      {pose === 'nap' && <g className="ant-cargo-rest"><Parcel /></g>}
      <g className="ant-pose"><AntFigure asleep={pose === 'nap'} /></g>
      {pose === 'nap' && <g className="ant-snore"><text x="92" y="14">z</text><text x="100" y="5">z</text></g>}
      <g className="ant-spark" transform="translate(48 -2)"><path d="M0-4v-6 M8-1l5-4 M-8-1l-5-4" /></g>
    </svg>
  )
}

export const antSkin: PetSkin = {
  id: 'ant',
  width: Math.round((HEIGHT * VIEW.width) / VIEW.height),
  height: HEIGHT,
  render: (props) => <AntBody {...props} />
}
