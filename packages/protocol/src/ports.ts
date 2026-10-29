import { z } from 'zod'

// A listening process identified again before it can be stopped; a port number alone is not an identity.
export const PortRef = z.object({
  sessionId: z.string(),
  pid: z.number().int().positive(),
  startedAt: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  address: z.string().min(1)
})
export type PortRef = z.infer<typeof PortRef>

// What core starts a process under (an agent's chat, a terminal), in an environment variable every
// process it starts inherits: a server that left the process tree it came from (its shell gone, its
// agent stopped) still names whose it is. The daemon reads it only where the tree no longer tells.
export const PROCESS_OWNER_ENV = 'CONCLAVE_OWNER'
export type ProcessOwner = { kind: 'conversation' | 'terminal'; id: string }
export function processOwner(owner: ProcessOwner): string {
  return `${owner.kind}:${owner.id}`
}
export function parseProcessOwner(value: string): ProcessOwner | null {
  const match = /^(conversation|terminal):([0-9a-f-]{36})$/.exec(value)
  return match && (match[1] === 'conversation' || match[1] === 'terminal') && match[2] ? { kind: match[1], id: match[2] } : null
}

// owner: for a process no session's tree leads to, what it was started under (PROCESS_OWNER_ENV);
// its sessionId is empty then. Older daemons leave it out.
export const HostedPort = PortRef.extend({ command: z.string(), canStop: z.boolean(), cwd: z.string().optional(), owner: z.string().optional() })
export type HostedPort = z.infer<typeof HostedPort>

export const ListeningPort = HostedPort.extend({
  terminalId: z.string().uuid().nullable(),
  conversationId: z.string().uuid().nullable(),
  taskId: z.string().nullable(),
  cwd: z.string(),
  label: z.string().nullable()
})
export type ListeningPort = z.infer<typeof ListeningPort>

export const PortList = z.object({ ports: z.array(ListeningPort), problem: z.string().nullable() })
export type PortList = z.infer<typeof PortList>

export const PortLabels = z.object({ ports: z.array(z.object({ port: z.number().int().min(1).max(65535), label: z.string().trim().min(1).max(80) })).max(200) })
