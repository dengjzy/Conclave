import { describe, expect, it } from 'vitest'
import type { ChatItem } from '@conclave/protocol'
import { bareCommand, keepsInView, limitAt, limitText, stoppedAtLimitText } from './background-work'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>
const tool = (changes: Partial<ToolItem> = {}): ToolItem => ({
  kind: 'tool', id: 'b', stageId: 's', revision: 1, at: 0, name: 'Bash', title: 'pnpm dev', input: 'pnpm dev',
  status: 'running', output: null, diffs: [], background: true, ...changes
})

describe('background work', () => {
  it('reads a command without the env, variables and redirection it was started with', () => {
    expect(bareCommand('env -u CONCLAVE_MCP_JS CONCLAVE_HOME=/Users/me/.conclave-demo pnpm --filter @conclave/desktop run dev --remoteDebuggingPort 9333 > /tmp/out.log 2>&1'))
      .toBe('pnpm --filter @conclave/desktop run dev --remoteDebuggingPort 9333')
    expect(bareCommand('PORT=3000 NODE_ENV="dev x" npm start >> log.txt &')).toBe('npm start')
    expect(bareCommand('sleep 90')).toBe('sleep 90')
    expect(bareCommand('environment-check --all')).toBe('environment-check --all')
  })

  it('keeps a running background command, and one its limit stopped, in view', () => {
    expect(keepsInView(tool())).toBe(true)
    expect(keepsInView(tool({ status: 'interrupted', stopReason: 'timeLimit' }))).toBe(true)
    expect(keepsInView(tool({ status: 'interrupted' }))).toBe(false)
    expect(keepsInView(tool({ status: 'done' }))).toBe(false)
    expect(keepsInView(tool({ background: false }))).toBe(false)
    expect(keepsInView(tool({ name: 'Agent' }))).toBe(false)
  })

  it('knows the limit only where the agent set one, and warns when it is close', () => {
    expect(limitAt(tool())).toBeNull()
    const at = limitAt(tool({ at: 1000, backgroundLimitMs: 7_200_000 }))
    expect(at).toBe(7_201_000)
    expect(limitText(10 * 60_000, 0)).toMatchObject({ soon: false })
    expect(limitText(10 * 60_000, 6 * 60_000)).toEqual({ text: '4 分钟后到上限', soon: true })
  })

  it('says how a command its limit stopped ended', () => {
    expect(stoppedAtLimitText(tool({ backgroundLimitMs: 7_200_000 }))).toBe('跑满 2 小时上限，被停止')
    expect(stoppedAtLimitText(tool())).toBe('到后台时长上限，被停止')
  })
})
