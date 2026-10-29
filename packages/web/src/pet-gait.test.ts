import { describe, expect, it } from 'vitest'
import { petGait } from './pet-gait'

describe('pet gait', () => {
  it('keeps foot cadence and relative travel consistent when the pet is resized', () => {
    const small = petGait(80), large = petGait(192)
    expect(large.cycleMs).toBeCloseTo(small.cycleMs)
    expect(large.speed / small.speed).toBeCloseTo(192 / 80)
    expect(large.speed * large.cycleMs / 1000 / 192).toBeCloseTo(small.speed * small.cycleMs / 1000 / 80)
  })

  it('advances the feet faster during a sprint without changing stride length', () => {
    const walk = petGait(120), sprint = petGait(120, true)
    expect(sprint.speed).toBeGreaterThan(walk.speed)
    expect(sprint.cycleMs).toBeLessThan(walk.cycleMs)
    expect(sprint.speed * sprint.cycleMs).toBeCloseTo(walk.speed * walk.cycleMs)
  })
})
