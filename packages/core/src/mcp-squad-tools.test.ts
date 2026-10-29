import { describe, expect, it } from 'vitest'
import { SquadRun, createRpcClient, type RpcConnection } from '@conclave/protocol'
import { createMcpHandler } from './mcp-server'
import { squadToolsOverCore } from './mcp-squad-tools'

const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`
const run = SquadRun.parse({ id: id(5), taskId: 'task', leaderConversationId: id(6), state: 'running', permissionMode: 'ask', allowBypass: false, summary: null, works: [], createdAt: 0, updatedAt: 0,
  squad: { id: id(7), name: 'Team', leaderId: id(1), archivedAt: null, createdAt: 0, updatedAt: 0, members: [
    { id: id(1), name: 'Lead', agent: 'claude', capability: 'readOnly' }, { id: id(2), name: 'Dev', agent: 'codex', capability: 'develop' }
  ] }
})
describe('squad MCP', () => {
  it('exposes coordination tools in a read-only coordinator, with only roster for members', async () => {
    const client = createRpcClient(() => {})
    const rpc: RpcConnection = { ...client, features: ['squads'], close: () => {}, closed: new Promise(() => {}) }
    const withCore = async <T>(action: (connection: RpcConnection) => Promise<T>) => action(rpc)
    const tools = squadToolsOverCore(withCore, id(6), run)
    const handler = createMcpHandler({ planOnly: true, preview: async () => {}, squad: tools })
    const list = await handler(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
    expect(JSON.stringify(list)).toContain('conclave_squad_dispatch')
    expect(squadToolsOverCore(withCore, id(9), run).map((tool) => tool.spec.name)).toEqual(['conclave_squad_roster'])
    const dispatch = tools.find((tool) => tool.spec.name === 'conclave_squad_dispatch')!
    expect((await dispatch.run({ memberId: 'not-an-id' })).isError).toBe(true)
  })
})
