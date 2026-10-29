import { parseArgs } from 'node:util'
import { RpcError } from '@conclave/protocol'
import { serveMcp } from './mcp-server'
import { conclaveHome, writePrivateJson } from '@conclave/protocol/node'
import { runUserMcp } from './user-mcp-launch'

// Conclave's MCP server, a process of its own that an agent starts over stdio: core configures it
// for every chat (see mcpCommand), and it reaches core over RPC like any other client.
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    home: { type: 'string' },
    conversation: { type: 'string' },
    'plan-only': { type: 'boolean' },
    history: { type: 'boolean' },
    'no-todos': { type: 'boolean' },
    'ready-file': { type: 'string' },
    // The ready file is written once the client has listed the tools rather than once it connects.
    'ready-on-list': { type: 'boolean' },
    // One of the user's MCP servers, started in its place (see runUserMcp), with only its
    // read-only tools under --read-only.
    run: { type: 'string' },
    'read-only': { type: 'boolean' }
  }
})

// Speaks MCP on stdout, so nothing else may print there.
const readyFile = values['ready-file']
const ready = readyFile ? () => writePrivateJson(readyFile, { ready: true }) : undefined
const onList = values['ready-on-list']
const served = values.run
  ? runUserMcp(values.home ?? conclaveHome(), values.run, values['read-only'])
  : serveMcp(values.home, values.conversation, values['plan-only'], onList ? undefined : ready, values.history, !values['no-todos'], onList ? ready : undefined)
served.catch((error: unknown) => {
  const reason = error instanceof RpcError && error.reason ? ` (${error.reason})` : ''
  console.error(`conclave mcp: ${error instanceof Error ? error.message : String(error)}${reason}`)
  process.exitCode = 1
})
