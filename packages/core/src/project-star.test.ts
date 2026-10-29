import { describe, expect, it, vi } from 'vitest'
import type { ProjectStarIdentity } from '@conclave/protocol'
import type { SourceCredential } from './source-provider'
import { ProjectStar } from './project-star'

type Call = { path: string; method: string; token: string; signal: AbortSignal | null | undefined; redirect: string | undefined }
type Reply = (call: Call) => Response
const identity: ProjectStarIdentity = { source: 'gh', instance: null, account: 'cli-user' }
const credential = (token: string): SourceCredential => ({ kind: 'token', payload: { token } })

function harness(reply: Reply = () => new Response(null, { status: 204 })) {
  const calls: Call[] = []
  const sources = { credentialsFor: vi.fn(() => [{ instance: 'default', credential: credential('plugin-secret') }]) }
  const ghToken = vi.fn(async (_signal: AbortSignal): Promise<string | null> => 'gh-secret')
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const call = { path: new URL(String(input)).pathname, method: init?.method ?? 'GET', token: new Headers(init?.headers).get('authorization') ?? '', signal: init?.signal, redirect: init?.redirect }
    calls.push(call)
    if (call.path === '/user') return Response.json({ login: call.token === 'Bearer gh-secret' ? 'cli-user' : 'plugin-user' })
    return reply(call)
  }
  return { service: new ProjectStar(sources, { ghToken, fetch }), sources, ghToken, calls }
}

describe('project GitHub star', () => {
  it('checks gh first and only reports a star after an authenticated 204', async () => {
    const h = harness()
    const status = await h.service.check()
    expect(status).toEqual({ state: 'ready', identity, starred: true })
    expect(h.sources.credentialsFor).not.toHaveBeenCalled()
    expect(h.calls.map(({ path, method }) => [path, method])).toEqual([['/user', 'GET'], ['/user/starred/dengjzy/Conclave', 'GET']])
    expect(JSON.stringify(status)).not.toContain('secret')
    expect(h.calls.every((call) => call.signal && call.redirect === 'error')).toBe(true)
  })

  it('treats a 404 as not starred only after checking the authenticated account', async () => {
    const h = harness(() => new Response(null, { status: 404 }))
    expect(await h.service.check()).toEqual({ state: 'ready', identity, starred: false })
  })

  it('falls back to the GitHub plugin when gh is unavailable', async () => {
    const h = harness()
    h.ghToken.mockResolvedValue(null)
    expect(await h.service.check()).toEqual({ state: 'ready', identity: { source: 'github-plugin', instance: 'default', account: 'plugin-user' }, starred: true })
    expect(h.sources.credentialsFor).toHaveBeenCalledWith('github')
  })

  it('tries the plugin if gh credentials cannot read star status', async () => {
    const h = harness((call) => new Response(null, { status: call.token === 'Bearer gh-secret' ? 401 : 404 }))
    expect(await h.service.check()).toMatchObject({ state: 'ready', identity: { source: 'github-plugin' }, starred: false })
  })

  it('keeps unknown and permission failures distinct from not starred', async () => {
    for (const code of [200, 401, 403, 500]) {
      const h = harness(() => new Response(null, { status: code }))
      expect(await h.service.check()).toEqual({ state: 'unavailable' })
    }
  })

  it('shares concurrent checks but rechecks after one settles', async () => {
    const h = harness()
    const first = h.service.check()
    expect(h.service.check()).toBe(first)
    await first
    await h.service.check()
    expect(h.ghToken).toHaveBeenCalledTimes(2)
  })

  it('writes only the fixed project after confirming the displayed account', async () => {
    const h = harness()
    expect(await h.service.star(identity)).toEqual({ ok: true })
    expect(h.calls.map(({ path, method }) => [path, method])).toEqual([['/user', 'GET'], ['/user/starred/dengjzy/Conclave', 'PUT']])
  })

  it('never writes if the account changed between detection and the click', async () => {
    const h = harness()
    expect(await h.service.star({ ...identity, account: 'previous-user' })).toEqual({ ok: false, problem: 'account-changed' })
    expect(h.calls.every((call) => call.method === 'GET')).toBe(true)
  })

  it('uses the selected plugin instance and does not switch accounts after a refused write', async () => {
    const h = harness(() => new Response(null, { status: 403 }))
    h.sources.credentialsFor.mockReturnValue([{ instance: 'work', credential: credential('work-secret') }, { instance: 'personal', credential: credential('personal-secret') }])
    expect(await h.service.star({ source: 'github-plugin', instance: 'personal', account: 'plugin-user' })).toEqual({ ok: false, problem: 'permission-denied' })
    expect(h.ghToken).not.toHaveBeenCalled()
    expect(h.calls.every((call) => call.token === 'Bearer personal-secret')).toBe(true)
    expect(h.calls.filter((call) => call.method === 'PUT')).toHaveLength(1)
  })

  it('does not use a removed plugin credential or fabricate success after a network error', async () => {
    const h = harness(() => { throw new Error('network error with gh-secret') })
    h.sources.credentialsFor.mockReturnValue([])
    expect(await h.service.star({ source: 'github-plugin', instance: 'default', account: 'plugin-user' })).toEqual({ ok: false, problem: 'unavailable' })
    expect(await h.service.star(identity)).toEqual({ ok: false, problem: 'request-failed' })
    expect(await h.service.check()).toEqual({ state: 'unavailable' })
  })

  it('ignores unsupported plugin credentials and reports unavailable without gh', async () => {
    const h = harness()
    h.ghToken.mockResolvedValue(null)
    h.sources.credentialsFor.mockReturnValue([{ instance: 'default', credential: { kind: 'other', payload: { token: 'other-secret' } } }])
    expect(await h.service.check()).toEqual({ state: 'unavailable' })
    expect(h.calls).toHaveLength(0)
  })
})
