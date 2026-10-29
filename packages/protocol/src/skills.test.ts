import { describe, expect, it } from 'vitest'
import { activatedSkillNames, skillNameConflicts, skillRepositoryUrl, SkillRepo, type SkillActivation } from './skills'

const repo = (id: string, activation?: SkillActivation) => SkillRepo.parse({ id, url: `https://github.com/team/${id}`, commit: 'a'.repeat(40), previousCommit: null, installedAt: 0, updatedAt: 0, plugin: null, skills: [{ name: 'review', description: 'Reviews code', dir: 'skills/review', problem: null }], activation })

describe('skill identity and activation', () => {
  it('unifies GitHub clone URL spellings without changing other servers', () => {
    expect(skillRepositoryUrl('https://GitHub.com/CathrynLavery/Diagram-Design.GIT///')).toBe('https://github.com/cathrynlavery/diagram-design')
    expect(skillRepositoryUrl('https://example.com/Team/Skills.git/')).toBe('https://example.com/Team/Skills.git/')
    expect(skillRepositoryUrl('https://github.com/team/skills?ref=next')).toBe('https://github.com/team/skills?ref=next')
  })

  it('accepts old locks, preserves feature-provided skills, and lets explicit settings disable them', () => {
    const legacy = repo('legacy')
    expect(activatedSkillNames(legacy, [{ repo: 'legacy', skill: 'review' }])).toEqual(['review'])
    expect(activatedSkillNames({ ...legacy, activation: { mode: 'selected', skills: [], agents: null } }, [{ repo: 'legacy', skill: 'review' }])).toEqual([])
  })

  it('checks names only where agent scopes overlap', () => {
    const a = repo('a', { mode: 'all', skills: [], agents: ['claude'] })
    const b = repo('b', { mode: 'all', skills: [], agents: ['pi'] })
    expect(skillNameConflicts([a, b], ['claude', 'pi'])).toEqual([])
    expect(skillNameConflicts([a, { ...b, activation: { mode: 'all', skills: [], agents: null } }], ['claude', 'pi'])).toEqual([{ name: 'review', repos: ['a', 'b'], agent: 'claude' }])
  })
})
