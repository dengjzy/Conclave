import { SearchQuery } from '@codemirror/search'
import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { matchCount } from './file-search-panel'

describe('matchCount', () => {
  const state = EditorState.create({ doc: 'foo bar foo baz foo', selection: EditorSelection.single(8, 11) })

  it('places the selection among the matches', () => {
    expect(matchCount(state, new SearchQuery({ search: 'foo' }))).toEqual({ current: 2, total: 3 })
  })

  it('counts zero when the selection is not on a match', () => {
    expect(matchCount(state, new SearchQuery({ search: 'ba' }))).toEqual({ current: 0, total: 2 })
  })

  it('reports a broken regexp', () => {
    expect(matchCount(state, new SearchQuery({ search: '(', regexp: true }))).toBeNull()
  })
})
