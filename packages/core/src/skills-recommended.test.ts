import { describe, expect, it } from 'vitest'
import { knowledgeBaseSkills } from './skills-recommended'

describe('knowledge base skills', () => {
  it('loads Obsidian skills only for writable explicit or legacy Obsidian vaults', () => {
    const legacy = { path: '/notes', write: true }
    expect(knowledgeBaseSkills(legacy)).toEqual([{ repo: 'kepano-obsidian-skills', skill: 'obsidian-markdown' }])
    expect(knowledgeBaseSkills({ ...legacy, kind: 'obsidian' })).toEqual(knowledgeBaseSkills(legacy))
    expect(knowledgeBaseSkills({ ...legacy, write: false })).toEqual([])
    expect(knowledgeBaseSkills({ ...legacy, kind: 'obsidian', write: false })).toEqual([])
    expect(knowledgeBaseSkills({ ...legacy, kind: 'markdown' })).toEqual([])
    expect(knowledgeBaseSkills({ ...legacy, kind: 'markdown', write: false })).toEqual([])
    expect(knowledgeBaseSkills(null)).toEqual([])
  })
})
