import { describe, expect, it } from 'vitest'
import { handoffMessage, parseHandoffMessage } from './handoff'

describe('handoff message', () => {
  it('reads back the file and what the user added, with or without a note', () => {
    expect(parseHandoffMessage(handoffMessage('/k/sessions/c/handoffs/h.md', '  先跑测试 \n'))).toEqual({ path: '/k/sessions/c/handoffs/h.md', note: '先跑测试' })
    expect(parseHandoffMessage(`  ${handoffMessage('/k/sessions/c/handoffs/h.md')}\n`)).toEqual({ path: '/k/sessions/c/handoffs/h.md', note: '' })
  })

  it('leaves any other message alone', () => {
    expect(parseHandoffMessage('请先阅读 Conclave 移交文件，然后告诉我里面写了什么')).toBeNull()
    expect(parseHandoffMessage('帮我看看 /k/sessions/c/handoffs/h.md')).toBeNull()
  })
})
