import { describe, expect, it } from 'vitest'
import { userMcpServer } from './conclave-mcp-server'
import { ReadOnlyToolFilter } from './mcp-read-only-filter'

const list = (id: number | string) => ({ jsonrpc: '2.0', id, method: 'tools/list' })
const call = (id: number, name: string) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name } })
const tools = (id: number | string) => ({
  jsonrpc: '2.0', id,
  result: { tools: [{ name: 'read', annotations: { readOnlyHint: true } }, { name: 'write', annotations: { readOnlyHint: false } }, { name: 'unmarked' }] }
})

describe('the read-only filter of a user\'s MCP server', () => {
  it('lists only the tools marked read-only, and lets through calls to those alone', () => {
    const filter = new ReadOnlyToolFilter()
    expect(filter.fromAgent(call(1, 'read'))).toHaveProperty('reply')
    expect(filter.fromAgent(list(2))).toEqual({ forward: list(2) })
    expect(filter.fromServer(tools(2))).toEqual({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'read', annotations: { readOnlyHint: true } }] } })
    expect(filter.fromAgent(call(3, 'read'))).toEqual({ forward: call(3, 'read') })
    for (const name of ['write', 'unmarked']) {
      expect(filter.fromAgent(call(4, name))).toEqual({ reply: { jsonrpc: '2.0', id: 4, error: expect.objectContaining({ code: -32602 }) } })
    }
  })

  it('leaves alone a reply to anything but the agent\'s tool list', () => {
    const filter = new ReadOnlyToolFilter()
    filter.fromAgent(list(1))
    // The same id as a string is another request.
    expect(filter.fromServer(tools('1'))).toEqual(tools('1'))
    expect(filter.fromServer({ jsonrpc: '2.0', id: 1, method: 'sampling/createMessage' })).toEqual({ jsonrpc: '2.0', id: 1, method: 'sampling/createMessage' })
    expect(filter.fromServer(tools(1)).result).toEqual({ tools: [expect.objectContaining({ name: 'read' })] })
    expect(filter.fromServer(tools(1))).toEqual(tools(1))
  })

  it('sends a member even a server the agent would reach itself through the launcher', () => {
    const server = { name: 'docs', enabled: true, agents: ['claude' as const], transport: { type: 'http' as const, url: 'https://mcp.example.com/mcp', headerKeys: [] }, createdAt: 0, updatedAt: 0 }
    expect(userMcpServer('/home', server)).toEqual({ name: 'docs', type: 'http', url: 'https://mcp.example.com/mcp' })
    expect(userMcpServer('/home', server, true)).toMatchObject({ name: 'docs', type: 'stdio', args: expect.arrayContaining(['--run', 'docs', '--read-only']) })
  })
})
