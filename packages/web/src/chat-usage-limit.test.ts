import { expect, it } from 'vitest'
import { usageLimitOpen, usageLimitText, type UsageLimitItem } from './components/ChatUsageLimit'

const NOW = Date.parse('2026-10-09T07:30:00Z')
const item = (fields: Partial<UsageLimitItem> = {}): UsageLimitItem => ({
  id: 'limit:turn',
  stageId: 'stage',
  revision: 1,
  at: NOW - 60_000,
  kind: 'usageLimit',
  message: 'usage limit reached',
  resetsAt: NOW + 60_000,
  autoContinue: false,
  status: 'waiting',
  continueAt: null,
  continuedAt: null,
  error: null,
  runId: null,
  ...fields
})

it('collapses a waiting usage-limit card when its reset time arrives', () => {
  expect(usageLimitOpen(item(), NOW)).toBe(true)
  expect(usageLimitOpen(item({ resetsAt: NOW }), NOW)).toBe(false)
  expect(usageLimitText(item({ resetsAt: NOW }), NOW)).toBe('额度已恢复')
})

it('keeps a card open when the recovery time is unknown', () => {
  expect(usageLimitOpen(item({ resetsAt: null }), NOW)).toBe(true)
})

it('says which account a limit moved the agent to, going on and once it went on', () => {
  expect(usageLimitText(item({ switchedTo: 'work', autoContinue: true }), NOW, '工作')).toBe('额度用完，正在换到账号「工作」继续')
  expect(usageLimitText(item({ switchedTo: 'work', status: 'continued', continuedAt: NOW }), NOW, '工作')).toBe('已换到账号「工作」继续')
  expect(usageLimitText(item({ resetsAt: NOW }), NOW, null)).toBe('额度已恢复')
})
