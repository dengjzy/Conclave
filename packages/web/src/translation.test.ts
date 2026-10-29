import { describe, expect, it } from 'vitest'
import { needsTranslation } from './translation'

describe('needsTranslation', () => {
  const english = 'Those red-boxed lines are empty turns started by the CLI itself. They do nothing.'
  const chinese = '红框里的那几行，是 Claude Code CLI 自己开的空回合，没有任何作用，可以隐藏。'

  it('asks for Chinese when a reply is mostly in another script, and not for Chinese with English terms', () => {
    expect(needsTranslation(english, 'zh-CN')).toBe(true)
    expect(needsTranslation(chinese, 'zh-CN')).toBe(false)
    expect(needsTranslation('把 `num_turns` 为 0 的回合隐藏掉，见 packages/core/src/agents/claude/claude-stream.ts 和 https://example.com/a/b', 'zh-CN')).toBe(false)
    expect(needsTranslation('このボタンはスマートフォンで押せません。原因を調べます。', 'zh-CN')).toBe(true)
  })

  it('asks for the other languages by their own scripts', () => {
    expect(needsTranslation(chinese, 'en')).toBe(true)
    expect(needsTranslation(english, 'en')).toBe(false)
    expect(needsTranslation(chinese, 'ja')).toBe(true)
    expect(needsTranslation('로그인 버튼이 모바일에서 눌리지 않습니다. 원인을 확인하겠습니다.', 'ko')).toBe(false)
  })

  it('leaves code and too little prose alone', () => {
    expect(needsTranslation('Done.', 'zh-CN')).toBe(false)
    expect(needsTranslation('```ts\nconst answer = computeTheAnswer(input, options, more, things)\n```', 'zh-CN')).toBe(false)
  })
})
