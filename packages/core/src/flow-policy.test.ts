import { describe, expect, it } from 'vitest'
import type { CheckResult } from '@conclave/protocol'
import { attemptHistory, classifyFailure, detectEnvironmentDemand, failureSignature } from './flow-policy'

const result = (tail: string, signature = 'sig', status: 'fail' | 'blocked' = 'fail'): CheckResult => ({
  repo: '/code', command: 'pnpm test', status, exitCode: 1, durationMs: 1, tail, signature, failures: [tail], flaky: false
})

describe('classifyFailure', () => {
  it('reads a compile error', () => {
    expect(classifyFailure([result('src/a.ts(1,2): error TS2322: Type string is not assignable')])).toBe('compile')
  })

  it('reads a failing test', () => {
    expect(classifyFailure([result('FAIL src/a.test.ts\nAssertionError: expected 1 to be 2')])).toBe('test')
  })

  it('reads an environment failure even when the output looks like a test', () => {
    expect(classifyFailure([result('spawn pnpm ENOENT', 'sig', 'blocked')])).toBe('environment')
    expect(classifyFailure([result('connect ECONNREFUSED 127.0.0.1:5432\ntest failed')])).toBe('environment')
  })

  it('leaves what it cannot read unknown', () => {
    expect(classifyFailure([result('boom')])).toBe('unknown')
  })
})

describe('failureSignature', () => {
  it('joins the stable signatures of every check', () => {
    expect(failureSignature([result('a', 'one'), result('b', 'two')])).toBe('one|two')
  })

  it('falls back to the command when a check has no signature', () => {
    expect(failureSignature([result('a', '')])).toContain('/code')
  })
})

describe('attemptHistory', () => {
  it('lists the last attempts with their agent, outcome and failure kind', () => {
    const flow = {
      attempts: [
        { number: 1, agent: 'claude', result: 'fail', failureKind: 'test', state: 'failed' },
        { number: 2, agent: 'codex', result: 'fail', failureKind: 'compile', state: 'failed' }
      ]
    }
    expect(attemptHistory(flow as never)).toContain('#1 claude · fail · test')
    expect(attemptHistory(flow as never)).toContain('#2 codex · fail · compile')
  })
})

describe('detectEnvironmentDemand', () => {
  it('detects missing command tool', () => {
    const demand = detectEnvironmentDemand([result('/bin/sh: line 1: adb: command not found')])
    expect(demand).toMatchObject({
      type: 'command',
      target: 'adb'
    })
  })

  it('detects missing environment variable', () => {
    const demand = detectEnvironmentDemand([result('Error: GITHUB_TOKEN is not defined in environment')])
    expect(demand).toMatchObject({
      type: 'env_var',
      target: 'GITHUB_TOKEN'
    })
  })

  it('detects service connection failure', () => {
    const demand = detectEnvironmentDemand([result('connect ECONNREFUSED 127.0.0.1:5432')])
    expect(demand).toMatchObject({
      type: 'service',
      target: '127.0.0.1:5432'
    })
  })
})
