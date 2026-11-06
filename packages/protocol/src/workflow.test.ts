import { describe, expect, it } from 'vitest'
import { rpcSchemas } from './rpc'

const fields = { title: 'Fix login', details: 'Acceptance criteria', repos: ['/code/app'], lanes: [{ name: 'Minimal', agent: 'claude' }, { name: 'Refactor', agent: 'codex' }] }

describe('workflow RPC contracts', () => {
  it('rejects duplicate names, empty projects and unbounded fan-out', () => {
    const schema = rpcSchemas['tasks.createWorkflow'].params
    expect(schema.safeParse(fields).success).toBe(true)
    expect(schema.safeParse({ ...fields, lanes: [{ name: ' X ', agent: null }, { name: 'x', agent: null }] }).success).toBe(false)
    expect(schema.safeParse({ ...fields, repos: [] }).success).toBe(false)
    expect(schema.safeParse({ ...fields, lanes: Array.from({ length: 13 }, (_, i) => ({ name: String(i), agent: null })) }).success).toBe(false)
  })
})
