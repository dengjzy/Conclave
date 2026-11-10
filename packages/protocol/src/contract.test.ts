import { describe, expect, it } from 'vitest'
import { CheckResult, contractNeedsHuman, newCheckFailures, TaskContractFields } from './contract'

describe('TaskContract', () => {
  it('fills in a conservative contract when nothing is given', () => {
    const contract = TaskContractFields.parse({})
    expect(contract).toMatchObject({
      goal: '',
      risk: 'medium',
      autonomy: 'confirm',
      verification: { checks: [], criteria: [], human: [], unknowns: [], baseline: [], autonomy: 'confirm' },
      constraints: { forbiddenPaths: [], maxAttempts: 3 }
    })
  })

  it('keeps a check trust hash, and leaves it out for a contract saved before trust hashes', () => {
    const checks = [{ repo: '/code', command: 'node scripts/check.mjs', timeoutMs: 600000, required: true }]
    expect(TaskContractFields.parse({ verification: { checks, trustedHash: 'abc' } }).verification.trustedHash).toBe('abc')
    expect(TaskContractFields.parse({ verification: { checks } }).verification.trustedHash).toBeUndefined()
    expect(TaskContractFields.parse({}).verification.trustedHash).toBeUndefined()
  })

  it('keeps a contract with no check for a person', () => {
    expect(contractNeedsHuman({ verification: { version: 1, checks: [], criteria: [], human: [], unknowns: [], baseline: [], autonomy: 'auto' } })).toBe(true)
    expect(contractNeedsHuman({
      verification: {
        version: 1,
        checks: [{ repo: '/code', command: 'pnpm test', timeoutMs: 600000, required: true }],
        criteria: [], human: [], unknowns: [], baseline: [], autonomy: 'auto'
      }
    })).toBe(false)
  })
})

describe('newCheckFailures', () => {
  const result = (failures: string[], signature: string): CheckResult => ({
    repo: '/code', command: 'pnpm test', status: 'fail', exitCode: 1, durationMs: 1, tail: '', signature, failures, flaky: false
  })

  it('leaves out what was already failing before the task', () => {
    expect(newCheckFailures([result(['new'], 'sig-new')], ['sig-old'])).toEqual(['new'])
    expect(newCheckFailures([result(['old'], 'sig-old')], ['sig-old'])).toEqual([])
  })

  it('does not block on an optional check failure', () => {
    expect(newCheckFailures([{ ...result(['warn'], 'sig-optional'), required: false }])).toEqual([])
  })

  it('keeps every failure when there is no baseline', () => {
    expect(newCheckFailures([result(['a'], 'a'), result(['b'], 'b')])).toEqual(['a', 'b'])
  })
})
