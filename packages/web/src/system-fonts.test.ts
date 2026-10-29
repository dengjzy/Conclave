import { describe, expect, it } from 'vitest'
import { chineseFamilies, cssFontFamily } from './system-fonts'

describe('cssFontFamily', () => {
  it('quotes a family name, escaping what would end the quote', () => {
    expect(cssFontFamily(' LXGW WenKai ')).toBe('"LXGW WenKai"')
    expect(cssFontFamily('a"b\\c')).toBe('"a\\"b\\\\c"')
  })
})

describe('chineseFamilies', () => {
  // A family draws the probe its own way if it has Chinese; otherwise as the reference behind it.
  const fonts: Record<string, string | null> = { 'PingFang SC': 'pingfang', 'Songti SC': 'songti', 'LXGW WenKai': 'wenkai', Inter: null, Menlo: null }
  const draw = (stack: string) => {
    const [first, behind] = stack.split(', ').map((each) => each.replace(/"/g, ''))
    return fonts[first ?? ''] ?? (behind ? fonts[behind] ?? null : null)
  }

  it('keeps the families that draw Chinese themselves', () => {
    expect(chineseFamilies(['Inter', 'LXGW WenKai', 'Menlo', 'PingFang SC', 'Songti SC'], draw)).toEqual(['LXGW WenKai', 'PingFang SC', 'Songti SC'])
  })

  it('keeps every family where it cannot tell', () => {
    expect(chineseFamilies(['Inter', 'LXGW WenKai', 'PingFang SC'], draw)).toEqual(['Inter', 'LXGW WenKai', 'PingFang SC'])
  })
})
