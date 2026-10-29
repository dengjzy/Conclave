import { describe, expect, it } from 'vitest'
import { nextFindIndex, textMatches } from './chat-find'

describe('chat text matching', () => {
  it('matches literal text without interpreting a regular expression', () => {
    expect(textMatches('a.b aXb a.b', 'a.b')).toEqual([{ start: 0, end: 3 }, { start: 8, end: 11 }])
    expect(textMatches('[a+b] and [a+b]', '[a+b]')).toEqual([{ start: 0, end: 5 }, { start: 10, end: 15 }])
    expect(textMatches('price: $x?', '$x?')).toEqual([{ start: 7, end: 10 }])
  })

  it('ignores case while retaining the original UTF-16 offsets', () => {
    expect(textMatches('İX x', 'x')).toEqual([{ start: 1, end: 2 }, { start: 3, end: 4 }])
    expect(textMatches('😀CHAT chat', 'chat')).toEqual([{ start: 2, end: 6 }, { start: 7, end: 11 }])
  })

  it('supports Chinese, spaces within phrases, and non-overlapping occurrences', () => {
    expect(textMatches('当前聊天：聊天', '聊天')).toEqual([{ start: 2, end: 4 }, { start: 5, end: 7 }])
    expect(textMatches('one two, one two', 'one two')).toHaveLength(2)
    expect(textMatches('aaaa', 'aa')).toEqual([{ start: 0, end: 2 }, { start: 2, end: 4 }])
  })

  it.each(['', '   ', '\n'])('does not create matches for a blank query (%j)', (query) => {
    expect(textMatches('chat content', query)).toEqual([])
  })
})

describe('chat find navigation', () => {
  it('wraps in both directions and handles an empty result set', () => {
    expect(nextFindIndex(2, 1, 3)).toBe(0)
    expect(nextFindIndex(0, -1, 3)).toBe(2)
    expect(nextFindIndex(0, 1, 1)).toBe(0)
    expect(nextFindIndex(0, -1, 0)).toBe(0)
  })
})
