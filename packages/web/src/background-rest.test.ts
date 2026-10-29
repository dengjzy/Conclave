import { beforeEach, describe, expect, it, vi } from 'vitest'

const page = vi.hoisted(() => ({ listener: null as ((tabId: string, focused: boolean) => void) | null }))
vi.mock('./desktop-bridge', () => ({
  onBrowserFocused: (listener: (tabId: string, focused: boolean) => void) => {
    page.listener = listener
    return () => {}
  }
}))

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
  page.listener = null
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

  it('keeps going while the built-in browser has the keyboard', async () => {
    const win = stubWindow()
    await start()
    // Clicking into the page: this document blurs, then main says the page took the keyboard.
    win.state.focused = false
    win.fire('blur')
    page.listener?.('tab-1', true)
    expect(win.resting()).toBe(false)
    // The window itself loses the keyboard: the page blurs too.
    page.listener?.('tab-1', false)
    expect(win.resting()).toBe(true)
  })

  it('follows the keyboard from one page to another whichever order the news comes in', async () => {
    const win = stubWindow()
    await start()
    win.state.focused = false
    page.listener?.('tab-1', true)
    page.listener?.('tab-2', true)
    page.listener?.('tab-1', false)
    expect(win.resting()).toBe(false)
  })

  it('forgets a page once the keyboard is back here', async () => {
    const win = stubWindow()
    await start()
    win.state.focused = false
    page.listener?.('tab-1', true)
    // The tab closes without a blur of its own; the keyboard returns to this document.
    win.state.focused = true
    win.fire('focus')
    win.state.focused = false
    win.fire('blur')
    expect(win.resting()).toBe(true)
  })

  it('rests while hidden, focused or not', async () => {
    const win = stubWindow()
    await start()
    win.state.hidden = true
    win.fire('visibilitychange')
    expect(win.resting()).toBe(true)
  })
})
