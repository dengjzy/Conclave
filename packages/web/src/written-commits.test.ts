import { beforeEach, describe, expect, it } from 'vitest'
import { createRpcClient, type Conversation, type GitTarget, type RpcConnection } from '@conclave/protocol'
import { useCore } from './core-store'
import { usePreferences } from './preferences'
import { commitSubject, commitWithWrittenMessage } from './written-commits'

const chat: Conversation = {
  id: 'chat', title: 'Chat', titleLocked: false, agent: 'codex', workspacePath: '/project',
  projectPaths: ['/project'], managedWorkspace: false, sessionId: null, createdAt: 0, updatedAt: 0
}
const target: GitTarget = { kind: 'conversation', id: 'chat', project: '/project' }

describe('commits the agent writes the message of', () => {
  let sent: Array<{ id: number; method: string; params: unknown }>
  let rpc: RpcConnection
  const answer = (index: number, result: unknown) => rpc.receive(JSON.stringify({ jsonrpc: '2.0', id: sent[index]?.id, result }))
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  beforeEach(() => {
    sent = []
    const client = createRpcClient((frame) => sent.push(JSON.parse(frame)))
    rpc = { ...client, features: ['commit-message'], close: () => {}, closed: new Promise(() => {}) }
    useCore.setState({ ...useCore.getInitialState(), rpc, conversations: { chat } }, true)
    usePreferences.setState({ quickModels: { codex: 'gpt-6-luna' } })
  })

  it('writes the message on the model picked for small jobs, then commits with it, one at a time', async () => {
    const committed: string[] = []
    const first = commitWithWrittenMessage(target, async (message) => { committed.push(message); return { commit: 'abc1234' } })
    expect(await commitWithWrittenMessage(target, async () => ({ commit: 'twice' }))).toBeNull()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ method: 'git.commitMessage', params: { ...target, model: 'gpt-6-luna' } })
    answer(0, { message: 'fix: keep the menu open\n\nBecause.', model: 'gpt-6-luna' })
    expect(await first).toEqual({ message: 'fix: keep the menu open\n\nBecause.', result: { commit: 'abc1234' } })
    expect(committed).toEqual(['fix: keep the menu open\n\nBecause.'])
    expect(commitSubject('fix: keep the menu open\n\nBecause.')).toBe('fix: keep the menu open')

    // A message that could not be written commits nothing, and leaves the way open for the next.
    const failed = commitWithWrittenMessage(target, async (message) => { committed.push(message); return {} })
    await settle()
    rpc.receive(JSON.stringify({ jsonrpc: '2.0', id: sent[1]?.id, error: { code: -32000, message: 'no answer', data: { reason: 'quick-failed' } } }))
    expect(await failed).toBeNull()
    expect(committed).toHaveLength(1)
    expect(useCore.getState().error).toBeTruthy()
    const again = commitWithWrittenMessage(target, async () => ({ commit: 'def5678' }))
    await settle()
    answer(2, { message: 'fix: again', model: null })
    expect(await again).toMatchObject({ result: { commit: 'def5678' } })
  })
})
