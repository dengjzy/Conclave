import { beforeEach, describe, expect, it, vi } from 'vitest'

// A window and document just real enough for focus to move between them.
function stubWindow() {
  const handlers = new Map<string, Array<() => void>>()
  const on = (name: string, handler: () => void) => handlers.set(name, [...(handlers.get(name) ?? []), handler])
  const fire = (name: string) => { for (const handler of handlers.get(name) ?? []) handler() }
  const state = { hidden: false, focused: true }
  const dataset: Record<string, string> = {}
  vi.stubGlobal('window', { addEventListener: on })
  vi.stubGlobal('document', {
    get hidden() { return state.hidden },
    hasFocus: () => state.focused,
    addEventListener: on,
    documentElement: { dataset }
  })
  return { state, fire, resting: () => 'resting' in dataset }
}

async function start() {
  const module = await import('./background-rest')
  module.startBackgroundRest()
  return module
}

beforeEach(() => {
  vi.resetModules()
})

describe('background rest', () => {
  it('rests while another window has the keyboard', async () => {
    const win = stubWindow()
    const { useBackgroundRest } = await start()
    expect(win.resting()).toBe(false)
    win.state.focused = false
    win.fire('blur')
    expect(win.resting()).toBe(true)
    expect(useBackgroundRest.getState().resting).toBe(true)
    win.state.focused = true
    win.fire('focus')
    expect(win.resting()).toBe(false)
    expect(useBackgroundRest.getState().resting).toBe(false)
  })

  it('rests while hidden and resumes when visible and focused', async () => {
    const win = stubWindow()
    const { useBackgroundRest } = await start()
    win.state.hidden = true
    win.fire('visibilitychange')
    expect(win.resting()).toBe(true)
    expect(useBackgroundRest.getState().resting).toBe(true)
    win.fire('focus')
    expect(win.resting()).toBe(true)
    win.state.hidden = false
    win.fire('visibilitychange')
    expect(win.resting()).toBe(false)
    expect(useBackgroundRest.getState().resting).toBe(false)
  })
})
