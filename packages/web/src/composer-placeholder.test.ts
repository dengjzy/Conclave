import { describe, expect, it } from 'vitest'
import { workingPlaceholder } from './composer-placeholder'

describe('workingPlaceholder', () => {
  it('names the platform\'s key for putting a message into the running turn', () => {
    const working = { awaiting: false, queueable: true, steerable: true }
    expect(workingPlaceholder(working, '⌘')).toBe('也可以写下一条，Enter 排到回合结束后发送，⌘Enter 立刻插入；Esc 中断')
    expect(workingPlaceholder(working, 'Ctrl+')).toBe('也可以写下一条，Enter 排到回合结束后发送，Ctrl+Enter 立刻插入；Esc 中断')
  })

  it('leaves the key out where the agent takes nothing mid-turn, and asks first while it waits', () => {
    expect(workingPlaceholder({ awaiting: false, queueable: true, steerable: false }, '⌘')).toBe('也可以写下一条，Enter 排到回合结束后发送；Esc 中断')
    expect(workingPlaceholder({ awaiting: true, queueable: true, steerable: true }, '⌘')).toBe('先回答上面的请求，也可以写下一条，Enter 排到回合结束后发送，⌘Enter 立刻插入；Esc 中断')
  })

  it('says only what an older core allows, which queues nothing', () => {
    expect(workingPlaceholder({ awaiting: false, queueable: false, steerable: true }, '⌘')).toBe('Agent 正在处理，可以先写下一条；Esc 中断')
    expect(workingPlaceholder({ awaiting: true, queueable: false, steerable: true }, '⌘')).toBe('先回答上面的请求')
  })

  it('never shows a placeholder of its own source', () => {
    for (const awaiting of [false, true]) for (const queueable of [false, true]) for (const steerable of [false, true]) {
      expect(workingPlaceholder({ awaiting, queueable, steerable })).not.toContain('${')
    }
  })
})
