import { describe, expect, it } from 'vitest'
import { AgentCliAccess } from './agent-cli-access'
import { Rejection } from './rejection'

describe('AgentCliAccess', () => {
  it('refuses a credential reservation while an agent is starting', async () => {
    const access = new AgentCliAccess()
    let finish: (() => void) | undefined
    const start = access.use('antigravity', () => new Promise<void>((resolve) => { finish = resolve }))
    expect(() => access.reserve('antigravity')).toThrowError(expect.objectContaining({ reason: 'agent-cli-active' }))
    finish?.()
    await start
    const release = access.reserve('antigravity')
    release()
    await expect(access.use('antigravity', async () => 'started')).resolves.toBe('started')
  })

  it('blocks new launches with the credential reason until released, without blocking other agents', async () => {
    const access = new AgentCliAccess()
    const reason = new Rejection('account-credentials-active', 'sign-in pending')
    const release = access.reserve('antigravity', reason)
    await expect(access.use('antigravity', async () => {})).rejects.toBe(reason)
    await expect(access.use('claude', async () => 'started')).resolves.toBe('started')
    release()
    const nextRelease = access.reserve('antigravity', reason)
    release()
    expect(access.blocked('antigravity')).toBe(true)
    nextRelease()
    expect(access.blocked('antigravity')).toBe(false)
  })
})
