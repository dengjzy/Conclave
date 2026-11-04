import { describe, expect, it } from 'vitest'
import { AgentCall, createRpcClient, type RpcConnection } from '@conclave/protocol'
import { agentToolsOverCore } from './mcp-agent-tools'
import { createMcpHandler } from './mcp-server'

const openCodeReport = `OPENCODE_DELEGATE_SMOKE_OK

<conclave-summary>
结论：委派冒烟测试通过，按要求仅返回指定字符串。
改动：无。
验证：未做（本任务禁止使用工具、编辑文件或运行命令）。
未解决：无。
</conclave-summary>`

describe('agent delegation MCP', () => {
  it('reads the exact OpenCode report by call ID, including output outside its summary', async () => {
    const parentId = '00000001-0000-4000-8000-000000000000'
    const firstId = '00000002-0000-4000-8000-000000000000'
    const secondId = '00000003-0000-4000-8000-000000000000'
    const profile = { id: '00000004-0000-4000-8000-000000000000', name: 'OpenCode', agent: 'opencode', model: 'opencode/mimo-v2.6-flash-free', archivedAt: null, createdAt: 1, updatedAt: 1 }
    const call = (id: string, result: string) => AgentCall.parse({ id, parentId, conversationId: id, profile, instruction: 'Review', permissionMode: 'readOnly', readOnly: true, state: 'completed', result, error: null, delivered: true, createdAt: 1, updatedAt: 1 })
    const calls = [call(firstId, openCodeReport), call(secondId, 'other report')]
    const client = createRpcClient((frame) => {
      const request = JSON.parse(frame)
      client.receive(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: calls }))
    })
    const rpc: RpcConnection = { ...client, features: ['agent-profiles'], close: () => {}, closed: new Promise(() => {}) }
    const status = agentToolsOverCore(async (action) => action(rpc), parentId).find((tool) => tool.spec.name === 'conclave_agent_status')!
    const result = await status.run({ callId: firstId })
    expect(result.isError).toBe(false)
    const returned = AgentCall.parse(JSON.parse(result.content[0]?.text ?? 'null'))
    expect(returned).toEqual(calls[0])
    expect(returned.result).toBe(openCodeReport)
    expect(result.content[0]?.text).not.toContain('other report')
    expect((await status.run({ callId: '00000005-0000-4000-8000-000000000000' })).isError).toBe(true)
    expect((await status.run({ callId: 'invalid' })).isError).toBe(true)
    const listed = await status.run({})
    expect(listed.isError).toBe(false)
    expect(JSON.parse(listed.content[0]?.text ?? 'null')).toEqual(calls)
  })

  it('scopes exact result lookup and default lists to the calling parent conversation', async () => {
    const firstParent = '00000001-0000-4000-8000-000000000000'
    const secondParent = '00000002-0000-4000-8000-000000000000'
    const firstId = '00000003-0000-4000-8000-000000000000'
    const secondId = '00000004-0000-4000-8000-000000000000'
    const profile = { id: '00000005-0000-4000-8000-000000000000', name: 'Reviewer', agent: 'claude', archivedAt: null, createdAt: 1, updatedAt: 1 }
    const call = (id: string, parentId: string, result: string) => AgentCall.parse({ id, parentId, conversationId: id, profile, instruction: 'Review', permissionMode: 'readOnly', readOnly: true, state: 'completed', result, error: null, delivered: true, createdAt: 1, updatedAt: 1 })
    const first = call(firstId, firstParent, openCodeReport)
    const second = call(secondId, secondParent, 'SECOND_PARENT_PRIVATE_RESULT')
    const byParent = new Map([[firstParent, [first]], [secondParent, [second]]])
    const requestedParents: string[] = []
    const client = createRpcClient((frame) => {
      const request = JSON.parse(frame)
      expect(request.method).toBe('agentCalls.list')
      requestedParents.push(request.params.id)
      client.receive(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: byParent.get(request.params.id) ?? [] }))
    })
    const rpc: RpcConnection = { ...client, features: ['agent-profiles'], close: () => {}, closed: new Promise(() => {}) }
    const withCore = async <T>(action: (connection: RpcConnection) => Promise<T>) => action(rpc)
    for (const [parentId, own, foreign] of [[firstParent, first, second], [secondParent, second, first]] as const) {
      const status = agentToolsOverCore(withCore, parentId).find((tool) => tool.spec.name === 'conclave_agent_status')!
      const result = await status.run({ callId: own.id })
      expect(result.isError).toBe(false)
      expect(JSON.parse(result.content[0]?.text ?? 'null')).toEqual(own)

      const rejected = await status.run({ callId: foreign.id })
      expect(rejected.isError).toBe(true)
      expect(rejected.content[0]?.text).toBe('找不到当前会话的委派')
      expect(rejected.content[0]?.text).not.toContain(foreign.result)

      const listed = await status.run({})
      expect(listed.isError).toBe(false)
      expect(JSON.parse(listed.content[0]?.text ?? 'null')).toEqual([own])
      expect(listed.content[0]?.text).not.toContain(foreign.result)
    }
    expect(requestedParents).toEqual([firstParent, firstParent, firstParent, secondParent, secondParent, secondParent])
  })

  it('exposes scoped delegation in a read-only caller and rejects invalid arguments', async () => {
    const client = createRpcClient(() => {})
    const rpc: RpcConnection = { ...client, features: ['agent-profiles'], close: () => {}, closed: new Promise(() => {}) }
    const withCore = async <T>(action: (connection: RpcConnection) => Promise<T>) => action(rpc)
    const agents = agentToolsOverCore(withCore, '00000001-0000-4000-8000-000000000000')
    const handler = createMcpHandler({ planOnly: true, preview: async () => {}, agents })
    const listed = await handler(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
    expect(JSON.stringify(listed)).toContain('conclave_agent_dispatch')
    expect((await agents.find((tool) => tool.spec.name === 'conclave_agent_dispatch')!.run({ profileId: 'invalid' })).isError).toBe(true)
    const withoutDelegation = createMcpHandler({ planOnly: true, preview: async () => {} })
    expect(JSON.stringify(await withoutDelegation(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })))).not.toContain('conclave_agent_dispatch')
  })
})
