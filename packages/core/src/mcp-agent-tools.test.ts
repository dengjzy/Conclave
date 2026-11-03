import { describe, expect, it } from 'vitest'
import { AgentCall, createRpcClient, type RpcConnection } from '@conclave/protocol'
import { agentToolsOverCore } from './mcp-agent-tools'
import { createMcpHandler } from './mcp-server'

describe('agent delegation MCP', () => {
  it('reads one complete result by call ID without exposing unrelated results', async () => {
    const parentId = '00000001-0000-4000-8000-000000000000'
    const firstId = '00000002-0000-4000-8000-000000000000'
    const secondId = '00000003-0000-4000-8000-000000000000'
    const profile = { id: '00000004-0000-4000-8000-000000000000', name: 'Reviewer', agent: 'claude', archivedAt: null, createdAt: 1, updatedAt: 1 }
    const call = (id: string, result: string) => AgentCall.parse({ id, parentId, conversationId: id, profile, instruction: 'Review', permissionMode: 'readOnly', readOnly: true, state: 'completed', result, error: null, delivered: true, createdAt: 1, updatedAt: 1 })
    const calls = [call(firstId, 'full first report'), call(secondId, 'other report')]
    const client = createRpcClient((frame) => {
      const request = JSON.parse(frame)
      client.receive(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: calls }))
    })
    const rpc: RpcConnection = { ...client, features: ['agent-profiles'], close: () => {}, closed: new Promise(() => {}) }
    const status = agentToolsOverCore(async (action) => action(rpc), parentId).find((tool) => tool.spec.name === 'conclave_agent_status')!
    const result = await status.run({ callId: firstId })
    expect(result.isError).toBe(false)
    expect(result.content[0]?.text).toContain('full first report')
    expect(result.content[0]?.text).not.toContain('other report')
    expect((await status.run({ callId: '00000005-0000-4000-8000-000000000000' })).isError).toBe(true)
    expect((await status.run({ callId: 'invalid' })).isError).toBe(true)
    expect((await status.run({})).content[0]?.text).toContain('other report')
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
