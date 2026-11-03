import { describe, expect, it, vi } from 'vitest'
import { pullReference, readPull } from './pull-request'

describe('public pull request adapter', () => {
  it('accepts only canonical GitHub pull URLs', () => {
    expect(pullReference('https://github.com/team/repo/pull/12/')).toEqual({ owner: 'team', repo: 'repo', number: '12', url: 'https://github.com/team/repo/pull/12' })
    for (const url of ['https://github.com.evil/team/repo/pull/12', 'https://github.com/team/repo/pull/1?x=2', 'http://github.com/team/repo/pull/1', 'https://github.com/../repo/pull/1', 'https://github.com/team/repo/pull/0']) expect(pullReference(url)).toBeNull()
  })
  it('reads public data only on request and marks individual failures unavailable', async () => {
    const ref = pullReference('https://github.com/team/repo/pull/12')!
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(init?.credentials).toBe('omit')
      const url = String(input)
      if (url.endsWith('/pulls/12')) return Response.json({ title: 'Fix', state: 'open', merged: false, head: { sha: 'a'.repeat(40) } })
      if (url.includes('/status?')) return Response.json({ state: 'success', total_count: 0, statuses: [] })
      if (url.includes('/check-runs?')) return new Response('', { status: 403 })
      return Response.json([{ user: { login: 'reviewer' }, state: 'APPROVED' }])
    })
    const result = await readPull(ref, new AbortController().signal, request)
    expect(result).toMatchObject({ status: { state: 'success' }, checks: null, reviews: [{ state: 'APPROVED' }] })
    expect(request).toHaveBeenCalledTimes(4)
  })
})
