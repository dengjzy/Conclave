/**
 * Conclave Design Tokens (Web)
 *
 * Single source of truth for semantic tokens across the Conclave Agent Workbench.
 * Concrete values and light-dark mappings reside in `packages/web/src/styles.css`.
 * Semantic usage rules and constraints reside in `TOKENS.md` and `DESIGN.md`.
 */

export const PALETTES = ['studio', 'ember'] as const
export type Palette = (typeof PALETTES)[number]

/** Semantic surface and background tokens */
export const SURFACE_TOKENS = {
  bg: '--bg',
  surface: '--surface',
  surfaceMuted: '--surface-muted',
  fill: '--fill',
  fill2: '--fill-2',
} as const

/** Structural border tokens */
export const BORDER_TOKENS = {
  border: '--border',
  border2: '--border-2',
} as const

/** Text and typographic hierarchy tokens */
export const TEXT_TOKENS = {
  text: '--text',
  textMuted: '--text-muted',
  text3: '--text-3',
  accentText: '--accent-text',
} as const

/** Action and interaction focus tokens */
export const ACTION_TOKENS = {
  accent: '--accent',
  accentBg: '--accent-bg',
  focus: '--focus',
} as const

/** Agent and system state tokens (Mixed-Initiative & Observability) */
export const STATUS_TOKENS = {
  running: '--status-running',
  done: '--status-done',
  review: '--status-review',
  pending: '--status-pending',
  abandoned: '--status-abandoned',
  warning: '--warning',
  danger: '--danger',
  info: '--info',
} as const

/** Code syntax highlighting tokens */
export const CODE_TOKENS = {
  keyword: '--code-keyword',
  string: '--code-string',
  number: '--code-number',
  comment: '--code-comment',
  title: '--code-title',
  type: '--code-type',
  variable: '--code-variable',
} as const

/** Multi-agent graph & causality topology line tokens */
export const GRAPH_TOKENS = {
  graph1: '--graph-1',
  graph2: '--graph-2',
  graph3: '--graph-3',
  graph4: '--graph-4',
  graph5: '--graph-5',
  graph6: '--graph-6',
} as const

/** Spacing tokens (4px strict grid scale) */
export const SPACING_TOKENS = {
  space1: '--space-1', // 4px
  space2: '--space-2', // 8px
  space3: '--space-3', // 12px
  space4: '--space-4', // 16px
  space5: '--space-5', // 20px
  space6: '--space-6', // 24px
  space8: '--space-8', // 32px
} as const

/** Radius scale tokens */
export const RADIUS_TOKENS = {
  xs: '--radius-xs', // 4px
  sm: '--radius-sm', // 6px
  md: '--radius',    // 8px (default)
  lg: '--radius-lg', // 12px
  full: '--radius-full', // 999px
} as const

/** Elevation & shadow tokens */
export const ELEVATION_TOKENS = {
  shadow: '--shadow',
  shadowFloat: '--shadow-float',
} as const

/** Motion & transition tokens */
export const MOTION_TOKENS = {
  durationFast: '--duration-fast',     // 120ms
  durationNormal: '--duration-normal', // 200ms
  easeStandard: '--ease-standard',     // cubic-bezier(0.16, 1, 0.3, 1)
} as const

/** Measure & layout width tokens */
export const LAYOUT_TOKENS = {
  reading: '--page-reading', // 800px
  form: '--page-form',       // 896px
  wide: '--page-wide',       // 1152px
} as const

/** All semantic tokens combined */
export const TOKENS = {
  ...SURFACE_TOKENS,
  ...BORDER_TOKENS,
  ...TEXT_TOKENS,
  ...ACTION_TOKENS,
  ...STATUS_TOKENS,
  ...CODE_TOKENS,
  ...GRAPH_TOKENS,
  ...SPACING_TOKENS,
  ...RADIUS_TOKENS,
  ...ELEVATION_TOKENS,
  ...MOTION_TOKENS,
  ...LAYOUT_TOKENS,
} as const

export type TokenKey = keyof typeof TOKENS
export type TokenVar = (typeof TOKENS)[TokenKey]

/**
 * Returns `var(--token-name)` format for use in inline styles or canvas.
 */
export function tokenVar(name: string): string {
  if (name.startsWith('--')) {
    return `var(${name})`
  }
  return `var(--${name})`
}
