import { describe, expect, it } from 'vitest'
import { KnowledgeBase, knowledgeBaseKind } from './knowledge'

describe('local knowledge bases', () => {
  it('keeps old settings as Obsidian without adding a required field', () => {
    const legacy = { path: '/notes', write: true }
    expect(KnowledgeBase.parse(legacy)).toEqual(legacy)
    expect(knowledgeBaseKind(legacy)).toBe('obsidian')
  })

  it.each(['markdown', 'obsidian'] as const)('accepts an explicit %s mode', (kind) => {
    const base = KnowledgeBase.parse({ path: '/notes', write: false, kind })
    expect(knowledgeBaseKind(base)).toBe(kind)
  })

  it('rejects unknown modes', () => {
    expect(KnowledgeBase.safeParse({ path: '/notes', write: true, kind: 'notion' }).success).toBe(false)
  })
})
