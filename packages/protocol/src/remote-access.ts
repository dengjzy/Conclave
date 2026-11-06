import { z } from 'zod'
import { Task } from './task'
import { Conversation } from './conversation'

export const RemoteDevice = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
  lastSeenAt: z.number(),
  online: z.boolean()
})
export type RemoteDevice = z.infer<typeof RemoteDevice>

export const RemoteAccessStatus = z.object({
  supported: z.boolean(),
  state: z.enum(['disabled', 'preparing', 'starting', 'ready', 'error']),
  clientUrl: z.string().nullable(),
  problem: z.string().nullable(),
  access: z.literal('control'),
  devices: z.array(RemoteDevice),
  nodeId: z.string().uuid().optional(),
  nodeName: z.string().min(1).max(80).optional(),
  webState: z.enum(['disabled', 'preparing', 'ready', 'error']).optional(),
  webProblem: z.string().nullable().optional()
})
export type RemoteAccessStatus = z.infer<typeof RemoteAccessStatus>

export const RemoteInvitation = z.object({ url: z.string().url(), appUrl: z.string().url().optional(), expiresAt: z.number() })
export type RemoteInvitation = z.infer<typeof RemoteInvitation>

export const RemoteTaskSummary = Task.pick({
  id: true, title: true, status: true, agent: true, awaitingInput: true,
  conversationId: true, updatedAt: true
})
export type RemoteTaskSummary = z.infer<typeof RemoteTaskSummary>
export const RemoteTaskPage = z.object({
  items: z.array(RemoteTaskSummary).max(20),
  total: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable()
})
export type RemoteTaskPage = z.infer<typeof RemoteTaskPage>

export const RemoteConversationPage = z.object({
  items: z.array(Conversation).max(20),
  total: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable()
})
export type RemoteConversationPage = z.infer<typeof RemoteConversationPage>
export const RemotePermissionMode = z.enum(['ask', 'plan', 'readOnly'])
export type RemotePermissionMode = z.infer<typeof RemotePermissionMode>
export const RemoteAgentPresets = z.object({
  options: z.array(z.object({ id: z.string(), label: z.string(), description: z.string().optional() })),
  defaultPreset: z.string()
})
export const RemoteProject = z.object({
  path: z.string(), name: z.string(), taskCount: z.number().int().nonnegative(), conversationCount: z.number().int().nonnegative()
})
export type RemoteProject = z.infer<typeof RemoteProject>


export const RemotePairingPayload = z.object({
  version: z.literal(2), address: z.string().min(1).max(2048),
  port: z.number().int().min(1).max(65535),
  ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/), expiresAt: z.number(),
  nodeId: z.string().uuid().optional(), nodeName: z.string().min(1).max(80).optional()
}).strict()
export type RemotePairingPayload = z.infer<typeof RemotePairingPayload>
