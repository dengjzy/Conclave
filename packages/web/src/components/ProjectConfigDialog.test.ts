import { describe, expect, it, vi } from 'vitest'
import { configOf, fillFromSuggestion, projectConfigSummary } from './ProjectConfigDialog'

vi.hoisted(() => {
  vi.stubGlobal('window', { conclave: undefined, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('navigator', { userAgent: 'Mac', platform: 'MacIntel' })
})

describe('the project config form', () => {
  it('turns the fields into the file, one copied path a line, blanks dropped', () => {
    expect(configOf({ copy: '.env\n\n  config/local.yml  \n.env', setup: '  go mod download ', check: '' })).toEqual({ copy: ['.env', 'config/local.yml'], setup: 'go mod download' })
    expect(configOf({ copy: '\n', setup: ' ', check: '' })).toEqual({})
  })

  it("sums a config up for the project's row", () => {
    expect(projectConfigSummary({ copy: ['.env'], setup: 'uv sync', check: 'uv run pytest' })).toBe('复制 1 个文件 · setup · check')
    expect(projectConfigSummary({ check: 'cargo test' })).toBe('check')
    expect(projectConfigSummary({})).toBeNull()
  })

  it('fills only the empty fields from a suggestion, and says by what', () => {
    const suggestion = { config: { copy: ['.env'], setup: 'pnpm install', check: 'pnpm test' }, from: ['pnpm'] }
    const result = fillFromSuggestion({ copy: '', setup: 'make deps', check: '' }, suggestion)
    expect(result.draft).toEqual({ copy: '.env', setup: 'make deps', check: 'pnpm test' })
    expect(result.note).toBe('按 pnpm 填入了复制的文件、check，保存前看一眼命令对不对。')
  })

  it('changes nothing it has no word for, and says why', () => {
    const draft = { copy: '', setup: 'make deps', check: 'make test' }
    expect(fillFromSuggestion(draft, { config: {}, from: [] })).toEqual({ draft, note: '没认出项目类型，可以参考输入框里的示例自己填。' })
    expect(fillFromSuggestion(draft, { config: { setup: 'go mod download' }, from: ['Go'] }).note).toContain('都已有内容')
  })
})
