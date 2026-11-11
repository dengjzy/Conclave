import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeSessionExecutor } from '../../native-session'
import { ompNativeSessions, ompSessionsRoot } from './omp-native-sessions'
import { adapterOf } from '../index'

const MAIN = '01a1c9f9-274d-7384-9e16-631844a62c68'
const OTHER = '01a1ca01-87b4-7225-8845-2b4f3a3e9440'

let root: string
const executor: NativeSessionExecutor = { command: async () => '', acp: async () => ({}) }

const write = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`)
}

beforeEach(() => { root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'conclave-omp-native-'))) })
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })

describe('omp native sessions', () => {
  it('is registered on the omp adapter', () => {
    expect(adapterOf('omp').nativeSessions).toBeDefined()
  })

  it('determines sessions root with PI_CODING_AGENT_DIR or default ~/.omp/agent/sessions', () => {
    expect(ompSessionsRoot({ PI_CODING_AGENT_DIR: '/custom/agent' }, '/home/user')).toBe(path.join('/custom/agent', 'sessions'))
    expect(ompSessionsRoot({ PI_CODING_AGENT_DIR: '~/custom/agent' }, '/home/user')).toBe(path.join('/home/user', 'custom', 'agent', 'sessions'))
    expect(ompSessionsRoot({}, '/home/user')).toBe(path.join('/home/user', '.omp', 'agent', 'sessions'))
  })

  it('captures storage and resolves a session by providerSessionId', async () => {
    const sessionsDir = path.join(root, 'sessions')
    const sessionFile = path.join(sessionsDir, '-project', `2026-11-11T09-00-00-000Z_${MAIN}.jsonl`)
    write(sessionFile, `{"type":"title","v":1,"title":"Test"}\n{"type":"session","id":"${MAIN}","cwd":"/project"}`)
    const support = ompNativeSessions(() => sessionsDir)

    const target = support.capture?.({ providerSessionId: MAIN, cwd: '/project' })
    expect(target?.home).toBe(sessionsDir)

    const resolved = await support.resolve(target!)
    expect(resolved).toEqual({
      id: MAIN,
      root: sessionsDir,
      locator: sessionFile,
      cwd: '/project'
    })
  })

  it('resolves a session when providerSessionId is an absolute path', async () => {
    const sessionsDir = path.join(root, 'sessions')
    const sessionFile = path.join(sessionsDir, '-project', `2026-11-11T09-00-00-000Z_${MAIN}.jsonl`)
    write(sessionFile, `{"type":"title","v":1,"title":"Test"}\n{"type":"session","id":"${MAIN}","cwd":"/project"}`)
    const support = ompNativeSessions(() => sessionsDir)

    const resolved = await support.resolve({ providerSessionId: sessionFile, cwd: '/project' })
    expect(resolved).toEqual({
      id: MAIN,
      root: sessionsDir,
      locator: sessionFile,
      cwd: '/project'
    })
  })

  it('deletes session file and companion directory on remove', async () => {
    const sessionsDir = path.join(root, 'sessions')
    const sessionFile = path.join(sessionsDir, '-project', `2026-11-11T09-00-00-000Z_${MAIN}.jsonl`)
    const companionDir = path.join(sessionsDir, '-project', `2026-11-11T09-00-00-000Z_${MAIN}`)
    const otherFile = path.join(sessionsDir, '-project', `2026-11-11T09-00-00-000Z_${OTHER}.jsonl`)

    write(sessionFile, `{"type":"title","v":1,"title":"Test"}\n{"type":"session","id":"${MAIN}","cwd":"/project"}`)
    write(path.join(companionDir, '1.bash.log'), 'echo hello')
    write(otherFile, `{"type":"title","v":1,"title":"Other"}\n{"type":"session","id":"${OTHER}","cwd":"/project"}`)

    const support = ompNativeSessions(() => sessionsDir)
    const resolved = await support.resolve({ providerSessionId: MAIN, cwd: '/project' })
    expect(resolved).not.toBeNull()

    await support.remove(resolved!, executor)
    expect(existsSync(sessionFile)).toBe(false)
    expect(existsSync(companionDir)).toBe(false)
    expect(existsSync(otherFile)).toBe(true)
  })

  it('rejects damaged session files that match the requested session', async () => {
    const sessionsDir = path.join(root, 'sessions')
    const sessionFile = path.join(sessionsDir, '-project', `2026-11-11T09-00-00-000Z_${MAIN}.jsonl`)
    write(sessionFile, `{"type":"title","v":1}\n{"type":"invalid"}`)
    const support = ompNativeSessions(() => sessionsDir)

    await expect(support.resolve({ providerSessionId: MAIN, cwd: '/project' })).rejects.toThrow('omp 会话文件缺少有效标识')
  })

  it('rejects access outside the storage root', async () => {
    const sessionsDir = path.join(root, 'sessions')
    const outsideFile = path.join(root, 'outside.jsonl')
    write(outsideFile, `{"type":"session","id":"${MAIN}","cwd":"/project"}`)
    const support = ompNativeSessions(() => sessionsDir)

    await expect(support.resolve({ providerSessionId: outsideFile, cwd: '/project' })).rejects.toThrow('历史目录')
  })

  it('rejects remove if session id changed in the file', async () => {
    const sessionsDir = path.join(root, 'sessions')
    const sessionFile = path.join(sessionsDir, '-project', `2026-11-11T09-00-00-000Z_${MAIN}.jsonl`)
    write(sessionFile, `{"type":"session","id":"changed-id","cwd":"/project"}`)
    const support = ompNativeSessions(() => sessionsDir)

    await expect(support.remove({ id: MAIN, root: sessionsDir, locator: sessionFile, cwd: '/project' }, executor)).rejects.toThrow('omp 会话标识已经改变')
  })

  it('returns empty children list as forks cannot prove ownership', async () => {
    const support = ompNativeSessions(() => root)
    expect(await support.children({ id: MAIN, root, locator: 'test', cwd: '/project' })).toEqual([])
  })
})
