import { describe, expect, it } from 'vitest'
import { runAgentSmokeTest } from './agent-smoke-test'
import type { EnvironmentService } from './environment-check'
import type { Environment } from '@conclave/protocol'

describe('agent smoke test', () => {
  it('reports missing when CLI is not detected', async () => {
    const fakeEnv: Environment = {
      checks: [
        { tool: 'git', status: 'ok', version: '2.40.0', path: '/usr/bin/git', signedIn: null },
        { tool: 'claude', status: 'missing', version: null, path: null, signedIn: null },
        { tool: 'codex', status: 'missing', version: null, path: null, signedIn: null }
      ],
      searchPath: ['/usr/bin'],
      checkedAt: Date.now()
    }

    const service = {
      check: async () => fakeEnv
    } as unknown as EnvironmentService

    const result = await runAgentSmokeTest('codex', service)
    expect(result.reports).toHaveLength(1)
    const report = result.reports[0]!
    expect(report.agent).toBe('codex')
    expect(report.installed).toBe(false)
    expect(report.ok).toBe(false)
    expect(report.checks.some((c) => c.id === 'cli' && c.status === 'error')).toBe(true)
    expect(report.checks.some((c) => c.id === 'auth' && c.status === 'skipped')).toBe(true)
  })

  it('reports ok when CLI is detected with valid version and signedIn', async () => {
    const fakeEnv: Environment = {
      checks: [
        { tool: 'git', status: 'ok', version: '2.40.0', path: '/usr/bin/git', signedIn: null },
        { tool: 'claude', status: 'ok', version: '2.1.263', path: '/usr/local/bin/claude', signedIn: true }
      ],
      searchPath: ['/usr/local/bin'],
      checkedAt: Date.now()
    }

    const service = {
      check: async () => fakeEnv
    } as unknown as EnvironmentService

    const result = await runAgentSmokeTest('claude', service)
    expect(result.reports).toHaveLength(1)
    const report = result.reports[0]!
    expect(report.agent).toBe('claude')
    expect(report.installed).toBe(true)
    expect(report.ok).toBe(true)
    expect(report.version).toBe('2.1.263')
    expect(report.checks.find((c) => c.id === 'cli')?.status).toBe('ok')
    expect(report.checks.find((c) => c.id === 'protocol')?.status).toBe('ok')
  })
})
