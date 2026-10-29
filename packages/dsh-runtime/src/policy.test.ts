import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { DSH_CONFIG_ENV, DSH_MODE_ENV, DshRuntimeConfig } from '@conclave/protocol'
import ConclaveFileSystem from './filesystem'
import { modes, operationPolicy, toolRefusal } from './policy'

let root: string
let project: string
let extra: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'conclave-dsh-policy-')))
  project = path.join(root, 'project')
  extra = path.join(root, 'extra')
  await mkdir(project)
  await mkdir(extra)
})
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })

describe('DSH policy enforcement', () => {
  it('permits actual edits in an additional project and denies siblings, links, protected folders and read-only calls', async () => {
    const config = DshRuntimeConfig.parse({ workDirs: [project, extra], noEdit: [path.join(extra, 'protected')] })
    vi.stubEnv(DSH_CONFIG_ENV, JSON.stringify(config))
    const policy = { mode: 'workspace-write' as const, workspaceRoot: project }
    const ctx = new Context().extend({ sandboxPolicy: { defaultMode: 'workspace-write', resolve: () => policy } })
    const fs = new ConclaveFileSystem(ctx, { cwd: project, diffBasisMaxBytes: 1024 * 1024 })
    const file = await fs.resolve(path.join(extra, 'file.txt'))
    await fs.writeText(file, 'first', undefined, undefined, policy)
    expect(await readFile(path.join(extra, 'file.txt'), 'utf8')).toBe('first')
    await fs.writeText(file, 'second', undefined, undefined, policy)
    expect(await readFile(path.join(extra, 'file.txt'), 'utf8')).toBe('second')
    const outside = path.join(root, 'outside')
    await mkdir(outside)
    await symlink(outside, path.join(extra, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    for (const denied of [path.join(outside, 'a'), path.join(extra, 'escape', 'b'), path.join(extra, 'protected', 'c')]) {
      await expect(fs.writeText(await fs.resolve(denied), 'no', undefined, undefined, policy)).rejects.toThrow(/Conclave/)
    }
    vi.stubEnv(DSH_MODE_ENV, 'readOnly')
    await expect(fs.writeText(file, 'no', undefined, undefined, { ...policy, mode: 'danger-full-access' })).rejects.toThrow(/read-only/)
    expect(await readFile(path.join(extra, 'file.txt'), 'utf8')).toBe('second')
  })

  it('uses an exact project root for a command and never trusts a child-provided workspace root', () => {
    const config = DshRuntimeConfig.parse({ workDirs: [project, extra] })
    const policy = { mode: 'workspace-write' as const, workspaceRoot: root }
    expect(operationPolicy(policy, extra, config, true).workspaceRoot).toBe(extra)
    expect(() => operationPolicy(policy, root, config, true)).toThrow(/outside/)
    const locked = { ...config, lock: 'plan' as const }
    expect(operationPolicy({ ...policy, mode: 'danger-full-access' }, project, locked, true).mode).toBe('read-only')
  })

  it('keeps planning and read-only modes fenced, including tools nested in other calls', () => {
    const config = DshRuntimeConfig.parse({ readTools: ['mcp__conclave__user_todo_list'] })
    expect(toolRefusal('plan', 'read', {}, config)).toBeUndefined()
    expect(toolRefusal('readOnly', 'read_image', {}, config)).toBeUndefined()
    expect(toolRefusal('plan', 'bash', { command: 'git diff' }, config)).toBeUndefined()
    expect(toolRefusal('readOnly', 'mcp__conclave__user_todo_list', {}, config)).toBeUndefined()
    for (const [name, args] of [['write', {}], ['run_code', {}], ['mcp__remote__update', {}], ['bash', { command: 'cat a; touch b' }], ['bash', { command: 'cat a', sandbox_permissions: 'danger-full-access' }]] as const) {
      expect(toolRefusal('plan', name, args, config)).toBeTruthy()
    }
    expect(modes({ ...config, lock: 'readOnly', allowBypass: true })).toEqual(['readOnly'])
    expect(modes({ ...config, allowBypass: true, noEdit: [extra] })).not.toContain('bypass')
  })
})
