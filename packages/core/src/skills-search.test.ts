import { afterEach, describe, expect, it, vi } from 'vitest'
import { searchSkills } from './skills-search'

const reply = (body: unknown, ok = true, status = 200) =>
  vi.fn().mockResolvedValue({ ok, status, json: () => Promise.resolve(body) })

afterEach(() => vi.unstubAllGlobals())

describe('searchSkills', () => {
  it('groups a registry answer into one row per repository, keeping order and popularity', async () => {
    vi.stubGlobal('fetch', reply({
      skills: [
        { source: 'vercel-labs/agent-skills', skillId: 'vercel-react-best-practices', installs: 833435 },
        { source: 'obra/superpowers', skillId: 'test-driven-development', installs: 120 },
        { source: 'Vercel-Labs/Agent-Skills.git', skillId: 'web-design-guidelines', installs: 775100 }
      ]
    }))
    const results = await searchSkills('react')
    expect(results).toEqual([
      { url: 'https://github.com/vercel-labs/agent-skills', source: 'vercel-labs/agent-skills', skills: ['vercel-react-best-practices', 'web-design-guidelines'], installs: 833435 },
      { url: 'https://github.com/obra/superpowers', source: 'obra/superpowers', skills: ['test-driven-development'], installs: 120 }
    ])
  })

  it('drops a source that is not a clean owner/repo so its URL cannot smuggle a path or host', async () => {
    vi.stubGlobal('fetch', reply({
      skills: [
        { source: 'owner/repo/extra', skillId: 'a' },
        { source: 'https://evil.example/x', skillId: 'b' },
        { source: 'good/repo', skillId: 'c' }
      ]
    }))
    expect(await searchSkills('x')).toEqual([
      { url: 'https://github.com/good/repo', source: 'good/repo', skills: ['c'], installs: 0 }
    ])
  })

  it('rejects with a stable reason when the registry is unreachable or answers badly', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await expect(searchSkills('x')).rejects.toMatchObject({ reason: 'skills-search-failed' })

    vi.stubGlobal('fetch', reply({}, false, 503))
    await expect(searchSkills('x')).rejects.toMatchObject({ reason: 'skills-search-failed' })

    vi.stubGlobal('fetch', reply('not json'))
    await expect(searchSkills('x')).rejects.toMatchObject({ reason: 'skills-search-failed' })
  })
})
