import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const attempts: string[] = []
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    rename: async (from: string, to: string) => {
      attempts.push(from)
      // The first two tries meet a scanner still holding the folder.
      if (from.includes('held') && attempts.length <= 2) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
      return fs.rename(from, to)
    }
  }
})
const { renameWhenFree } = await import('./patient-rename')

describe('renaming a folder just written', () => {
  const dirs: string[] = []
  afterEach(() => { attempts.length = 0; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  it('waits out a scanner holding it on Windows', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'conclave-rename-')); dirs.push(root)
    mkdirSync(path.join(root, 'held'))
    await renameWhenFree(path.join(root, 'held'), path.join(root, 'done'), 'win32')
    expect(attempts).toHaveLength(3)
    expect(existsSync(path.join(root, 'done'))).toBe(true)
  })

  it('fails at once elsewhere, where EPERM means what it says', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'conclave-rename-')); dirs.push(root)
    mkdirSync(path.join(root, 'held'))
    await expect(renameWhenFree(path.join(root, 'held'), path.join(root, 'done'), 'darwin')).rejects.toThrow('operation not permitted')
    expect(attempts).toHaveLength(1)
  })
})
