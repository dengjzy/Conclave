import { describe, expect, it } from 'vitest'
import { createRpcClient, type RpcConnection } from '@conclave/protocol'
import { agentToolsOverCore } from './mcp-agent-tools'
import { createMcpHandler } from './mcp-server'

describe('agent delegation MCP', () => {
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
