import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { opencodeConfig, OPENCODE_AUTO_AGENT, OPENCODE_BYPASS_AGENT, OPENCODE_READ_ONLY_AGENT } from './opencode-config'

const agents = (launch: Parameters<typeof opencodeConfig>[0]) => JSON.parse(opencodeConfig(launch)).agents

describe('OpenCode config Conclave adds', () => {
  it('adds a read-only agent that edits nothing and asks before running anything', () => {
    expect(agents({})[OPENCODE_READ_ONLY_AGENT]).toEqual(expect.objectContaining({ mode: 'primary', permissions: [
      { action: 'edit', resource: '*', effect: 'deny' },
      { action: 'shell', resource: '*', effect: 'ask' },
      { action: 'external_directory', resource: '*', effect: 'ask' }
    ] }))
  })

  it('lets every agent of its own read a reference project and none edit it, last so nothing overrides that', () => {
    const all = agents({ references: ['/refs/docs'], allowBypass: true })
    const read = { action: 'external_directory', resource: '/refs/docs/*', effect: 'allow' }
    const fenced = { action: 'edit', resource: '/refs/docs/*', effect: 'deny' }
    expect(all[OPENCODE_AUTO_AGENT].permissions.slice(-2)).toEqual([read, fenced])
    expect(all[OPENCODE_READ_ONLY_AGENT].permissions.at(-1)).toEqual(read)
    expect(all[OPENCODE_BYPASS_AGENT].permissions).toEqual([{ action: '*', resource: '*', effect: 'allow' }, fenced])
    // OpenCode's own Build, which asks nothing, too; and only when there is a reference.
    expect(all.build).toEqual({ permissions: [read, fenced] })
    expect(agents({}).build).toBeUndefined()
  })

  it('adds an automatic agent that works in the project and refuses, never asks, to go outside it', () => {
    const permissions = agents({})[OPENCODE_AUTO_AGENT].permissions
    expect(permissions).toEqual([
      { action: 'edit', resource: '*', effect: 'allow' },
      { action: 'shell', resource: '*', effect: 'allow' },
      { action: 'external_directory', resource: '*', effect: 'deny' },
      { action: 'read', resource: '*.env', effect: 'deny' },
      { action: 'read', resource: '*.env.*', effect: 'deny' },
      { action: 'read', resource: '*.env.example', effect: 'allow' }
    ])
    // A run nobody watches in this mode is never stopped on a request: OpenCode ends the turn on one rejected.
    expect(permissions.some((each: { effect: string }) => each.effect === 'ask')).toBe(false)
  })

  it('adds the allow-everything agent only where the stage may bypass', () => {
    expect(agents({})).not.toHaveProperty(OPENCODE_BYPASS_AGENT)
    expect(agents({ allowBypass: true })[OPENCODE_BYPASS_AGENT].permissions).toEqual([{ action: '*', resource: '*', effect: 'allow' }])
    expect(agents({ allowBypass: true, planOnly: { dirs: ['/work'] } })).not.toHaveProperty(OPENCODE_BYPASS_AGENT)
    expect(agents({ allowBypass: true, readOnly: { dirs: ['/work'] } })).not.toHaveProperty(OPENCODE_BYPASS_AGENT)
  })

  it('starts Conclave\'s MCP server with Code Mode off, as its adapter starts it', () => {
    const mcp = { command: 'node', args: ['mcp.mjs', '--conversation', 'c', '--ready-file', '/r.json'], env: { ELECTRON_RUN_AS_NODE: '1' } }
    expect(JSON.parse(opencodeConfig({ mcp })).mcp).toEqual({ servers: { conclave: { type: 'local', command: ['node', 'mcp.mjs', '--conversation', 'c', '--ready-file', '/r.json'], environment: { ELECTRON_RUN_AS_NODE: '1' }, codemode: false } } })
    expect(JSON.parse(opencodeConfig({}))).not.toHaveProperty('mcp')
  })

  it('points it at the skills bundle in the Agent Skills layout', () => {
    expect(JSON.parse(opencodeConfig({ skills: { dir: '/conclave/skills/bundles/abc' } })).skills).toEqual([path.join('/conclave/skills/bundles/abc', '.agents', 'skills')])
  })
})
