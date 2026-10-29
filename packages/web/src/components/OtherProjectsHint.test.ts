import { describe, expect, it } from 'vitest'
import { reachesOnlyPrimary } from './OtherProjectsHint'

describe('reachesOnlyPrimary', () => {
  it('holds only for an agent whose file tools reach the primary project alone, given others', () => {
    expect(reachesOnlyPrimary('antigravity', 2)).toBe(true)
    expect(reachesOnlyPrimary('antigravity', 1)).toBe(false)
    expect(reachesOnlyPrimary('claude', 3)).toBe(false)
    expect(reachesOnlyPrimary(null, 3)).toBe(false)
  })
})
