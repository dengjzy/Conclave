import { createContext } from 'react'
import type { ChatItem } from '@conclave/protocol'
import { t } from './i18n'
import { timeOfDay } from './labels'
import { isSubagent, workedFor } from './chat-tools'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

// Within this of its time limit, a background command is about to be stopped: worth a warning.
export const LIMIT_SOON_MS = 5 * 60_000

// A command the agent left running in the background, as opposed to a subagent it sent off.
export function isBackgroundCommand(tool: ToolItem): boolean {
  return Boolean(tool.background) && !isSubagent(tool.name)
}

// A background command stays in view after its turn while it runs, and once its time limit
// stopped it: either is still news when the turn is done.
export function keepsInView(tool: ToolItem): boolean {
  return isBackgroundCommand(tool) && (tool.status === 'running' || tool.stopReason === 'timeLimit')
}

// Background work the chat can stop on its own, apart from the turn, while it still runs.
export function canStop(tool: ToolItem): boolean {
  return Boolean(tool.stoppable) && tool.status === 'running'
}

// Stops one piece of the conversation's background work; true once core has passed it on. Unset
// where nothing can be stopped from (a chat shown read-only).
export const StopBackground = createContext<((tool: ToolItem) => Promise<boolean>) | null>(null)

// What the agent said the work is (a command's description, a subagent's task), else its title.
export function backgroundLabel(tool: ToolItem): string {
  return tool.description?.trim() || tool.title
}

// A command as people read it: without the env it starts under, the variables set ahead of it, and
// where its output goes, which the agent adds to run it in the background.
export function bareCommand(command: string): string {
  return (command.trim().split('\n')[0] ?? '')
    .replace(/^env(?:\s+(?:-u\s+\S+|-\S+))*\s+/, '')
    .replace(/^(?:\w+=(?:'[^']*'|"[^"]*"|\S*)\s+)+/, '')
    .replace(/\s+(?:\d?>>?|&>)\s*\S+/g, '')
    .replace(/\s*&\s*$/, '')
    .trim()
}

// When the agent's CLI stops the command, where the agent set a limit.
export function limitAt(tool: ToolItem): number | null {
  return tool.backgroundLimitMs ? tool.at + tool.backgroundLimitMs : null
}

// The limit as a line says it: the time it falls at, or, when close, how soon.
export function limitText(at: number, now: number): { text: string; soon: boolean } {
  const left = at - now
  return left <= LIMIT_SOON_MS
    ? { text: t('backgroundWork.limitIn', { time: workedFor(Math.max(0, left)) }), soon: true }
    : { text: t('backgroundWork.limitAt', { time: timeOfDay(at) }), soon: false }
}

// How a command its time limit stopped says so: with the limit, where the agent set it.
export function stoppedAtLimitText(tool: ToolItem): string {
  return tool.backgroundLimitMs
    ? t('backgroundWork.stoppedAtLimit', { time: workedFor(tool.backgroundLimitMs) })
    : t('backgroundWork.stoppedAtTheLimit')
}
