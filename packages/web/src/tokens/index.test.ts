import { describe, expect, it } from 'vitest'
import {
  ACTION_TOKENS,
  BORDER_TOKENS,
  CODE_TOKENS,
  ELEVATION_TOKENS,
  GRAPH_TOKENS,
  LAYOUT_TOKENS,
  MOTION_TOKENS,
  PALETTES,
  RADIUS_TOKENS,
  SPACING_TOKENS,
  STATUS_TOKENS,
  SURFACE_TOKENS,
  TOKENS,
  tokenVar,
} from './index'

describe('design tokens', () => {
  it('defines 5 valid palettes', () => {
    expect(PALETTES).toEqual(['terracotta', 'indigo', 'nord', 'paper', 'catppuccin'])
  })

  it('all tokens begin with --', () => {
    for (const [key, value] of Object.entries(TOKENS)) {
      expect(value, `Token ${key}`).toMatch(/^--[a-z0-9-]+$/)
    }
  })

  it('correctly maps tokenVar', () => {
    expect(tokenVar('accent')).toBe('var(--accent)')
    expect(tokenVar('--accent')).toBe('var(--accent)')
    expect(tokenVar(TOKENS.surface)).toBe('var(--surface)')
    expect(tokenVar(TOKENS.space2)).toBe('var(--space-2)')
  })

  it('groups contain expected semantic keys', () => {
    expect(SURFACE_TOKENS.bg).toBe('--bg')
    expect(SURFACE_TOKENS.surface).toBe('--surface')
    expect(BORDER_TOKENS.border).toBe('--border')
    expect(BORDER_TOKENS.border2).toBe('--border-2')
    expect(ACTION_TOKENS.accent).toBe('--accent')
    expect(ACTION_TOKENS.focus).toBe('--focus')
    expect(STATUS_TOKENS.running).toBe('--status-running')
    expect(STATUS_TOKENS.done).toBe('--status-done')
    expect(STATUS_TOKENS.review).toBe('--status-review')
    expect(SPACING_TOKENS.space1).toBe('--space-1')
    expect(SPACING_TOKENS.space4).toBe('--space-4')
    expect(RADIUS_TOKENS.sm).toBe('--radius-sm')
    expect(ELEVATION_TOKENS.shadow).toBe('--shadow')
    expect(MOTION_TOKENS.durationFast).toBe('--duration-fast')
    expect(LAYOUT_TOKENS.reading).toBe('--page-reading')
  })
})
