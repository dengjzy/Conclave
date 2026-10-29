import { describe, expect, it } from 'vitest'
import { AGENT_KINDS, agentDescriptor } from '@conclave/protocol'
import { adapterOf, checkAdapter } from '.'

describe('agent registry', () => {
  it.each(AGENT_KINDS)('describes %s to clients as its adapter runs it', (kind) => {
    const adapter = adapterOf(kind)
    const descriptor = agentDescriptor(kind)
    expect(adapter.kind).toBe(kind)
    // A client names exactly the modes core lets the agent start in, and offers only those.
    expect(Object.keys(descriptor.modes).sort()).toEqual([...adapter.permissionModes].sort())
    expect(descriptor.startModes.every((mode) => adapter.permissionModes.includes(mode))).toBe(true)
    expect(adapter.permissionModes.includes(descriptor.defaultStartMode)).toBe(true)
    // An inbox issue's conversation starts in it, as a new conversation would.
    expect(descriptor.startModes).toContain(descriptor.discussionMode)
    expect(adapter.permissionModes.includes('bypass')).toBe(descriptor.capabilities.bypass)
    expect(adapter.permissionModes.includes('auto')).toBe(descriptor.capabilities.autoMode)
    if (adapter.fallbackMode) expect(adapter.permissionModes).toContain(adapter.fallbackMode)
    // A client is told whether the agent takes a skills bundle only where its command gives one,
    // on its command line or in its environment.
    const launch = { providerSessionId: null, resume: false, handoffPath: null, extraProjects: [], skills: { dir: '/conclave/skills/bundles/abc' } }
    const command = adapter.command(launch)
    expect([...command.args, ...Object.values(command.env ?? {})].some((value) => value.includes('/conclave/skills/bundles/abc'))).toBe(descriptor.capabilities.skills)
  })

  it.each(AGENT_KINDS)('gives %s a driver for every turn hook it declares', (kind) => {
    const adapter = adapterOf(kind)
    const driver = adapter.createDriver('stage', { cwd: '/tmp', extraDirs: [], resume: null })
    if (adapter.turns?.firstFrameTimeoutMs) expect(driver.turnSignal).toBeTypeOf('function')
  })

  it('refuses an adapter that watches for stalls it cannot stop and retry', () => {
    const adapter = { ...adapterOf('cursor'), turns: { firstFrameTimeoutMs: 1000 } }
    expect(() => checkAdapter(adapter)).toThrow(/stopAfterCancel and retryByRestart/)
  })
})
