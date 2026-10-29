import { z } from 'zod'
import { AgentKind } from './agent'

// MCP servers the user keeps in Conclave and core hands to the agents they pick at each start, beside
// Conclave's own. Nothing goes into an agent's own configuration. `conclave` is Conclave's own server's
// name in every agent, which tool names are read by (conclaveToolName), so no user server takes it.
export const RESERVED_MCP_SERVER_NAME = 'conclave'
export const McpServerName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/).refine((name) => name !== RESERVED_MCP_SERVER_NAME)
export type McpServerName = z.infer<typeof McpServerName>

export const McpEnvKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
export const McpHeaderName = z.string().regex(/^[A-Za-z0-9-]{1,128}$/)

// Environment values and headers carry the tokens a server signs in with, so all of them are kept
// as secrets: a client sees which keys are set, never what they are set to.
export const McpTransport = z.discriminatedUnion('type', [
  z.object({ type: z.literal('stdio'), command: z.string().min(1).max(4096), args: z.array(z.string().max(4096)).max(64), cwd: z.string().max(4096).nullable(), envKeys: z.array(McpEnvKey).max(64) }),
  z.object({ type: z.literal('http'), url: z.string().url().max(2048), headerKeys: z.array(McpHeaderName).max(64) })
])
export type McpTransport = z.infer<typeof McpTransport>

// agents: the agents it is handed to; enabled off keeps it without handing it to any.
export const McpServer = z.object({
  name: McpServerName,
  enabled: z.boolean(),
  agents: z.array(AgentKind),
  transport: McpTransport,
  createdAt: z.number(),
  updatedAt: z.number()
})
export type McpServer = z.infer<typeof McpServer>

// A secret as an edit gives it: a new value, or null to keep the one stored under that key. A key
// left out is removed.
export const McpSecretInput = z.object({ key: z.string(), value: z.string().max(16_384).nullable() })
export type McpSecretInput = z.infer<typeof McpSecretInput>

export const McpTransportInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('stdio'), command: z.string().trim().min(1).max(4096), args: z.array(z.string().max(4096)).max(64), cwd: z.string().trim().max(4096).nullable(), env: z.array(McpSecretInput.extend({ key: McpEnvKey })).max(64) }),
  z.object({ type: z.literal('http'), url: z.string().trim().url().max(2048), headers: z.array(McpSecretInput.extend({ key: McpHeaderName })).max(64) })
])
export type McpTransportInput = z.infer<typeof McpTransportInput>

// previousName: the server this edit renames, its secrets carried over; null adds one.
export const McpServerInput = z.object({
  name: McpServerName,
  previousName: McpServerName.nullable(),
  enabled: z.boolean(),
  agents: z.array(AgentKind),
  transport: McpTransportInput
})
export type McpServerInput = z.infer<typeof McpServerInput>

// What connecting to a server found: its tools, or why it could not be reached, and what the
// command printed on stderr either way.
export const McpProbe = z.object({
  ok: z.boolean(),
  tools: z.array(z.object({ name: z.string(), description: z.string() })),
  error: z.string().nullable(),
  stderr: z.string().nullable(),
  at: z.number()
})
export type McpProbe = z.infer<typeof McpProbe>

// A server one of the agents is set up with in its own configuration, as Conclave could take it in:
// the name Conclave would give it, and, where it cannot, why not. Its secret values stay where they
// are until it is imported, which core reads again.
export const McpImportSource = AgentKind
export const McpImportCandidate = z.object({
  source: McpImportSource,
  name: z.string(),
  suggestedName: McpServerName.nullable(),
  transport: McpTransport,
  problem: z.string().nullable()
})
export type McpImportCandidate = z.infer<typeof McpImportCandidate>

export const McpImportItem = z.object({ source: McpImportSource, name: z.string().max(200), as: McpServerName })
export type McpImportItem = z.infer<typeof McpImportItem>
