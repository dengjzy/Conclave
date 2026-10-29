import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectOpenCode, opencodeCompatible, parseOpenCodeModels } from './opencode-cli'

let root: string
const executable = (body: string) => writeFileSync(path.join(root, 'opencode'), `#!${process.execPath}\n${body}`, { mode: 0o755 })

beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'conclave-opencode-cli-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('OpenCode CLI', () => {
  it('takes version 2 and later, whose config and ACP Conclave speaks', () => {
    expect(opencodeCompatible('2.1.1')).toBe(true)
    expect(opencodeCompatible('10.0.0')).toBe(true)
    expect(opencodeCompatible('1.18.31')).toBe(false)
    expect(opencodeCompatible(null)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('finds it on the path and tells an old release from a ready one', async () => {
    expect(await detectOpenCode(root, process.platform)).toEqual({ status: 'missing', version: null, path: null, signedIn: null })
    executable("console.log('1.18.31')")
    expect(await detectOpenCode(root, process.platform)).toMatchObject({ status: 'unknown', version: '1.18.31', path: path.join(root, 'opencode'), problem: 'incompatible-version' })
    executable("process.exit(1)")
    expect(await detectOpenCode(root, process.platform)).toMatchObject({ status: 'unknown', problem: 'probe-failed' })
    executable("console.log('2.1.1')")
    expect(await detectOpenCode(root, process.platform)).toMatchObject({ status: 'ok', version: '2.1.1' })
  })

  it('reads the enabled models from its API as its session names them, with their effort levels', () => {
    const listed = JSON.stringify({ location: { directory: '/work' }, data: [
      { providerID: 'opencode', id: 'big-pickle', name: 'Big Pickle', enabled: true, variants: [] },
      { providerID: 'opencode', id: 'glm-5.3-flash-free', name: 'GLM-5.3-Flash Free', enabled: true, variants: [{ id: 'low' }, { id: 'high' }] },
      { providerID: 'github-copilot', id: 'gpt-6', name: 'GPT-6', enabled: false, variants: [] }
    ] })
    expect(parseOpenCodeModels(listed)).toEqual({ models: [
      { id: 'opencode/big-pickle', label: 'opencode/Big Pickle', description: null, efforts: [], isDefault: false },
      { id: 'opencode/glm-5.3-flash-free', label: 'opencode/GLM-5.3-Flash Free', description: null, efforts: ['low', 'high', 'default'], isDefault: false }
    ] })
    expect(parseOpenCodeModels('not json')).toBeNull()
    expect(parseOpenCodeModels(JSON.stringify({ data: [] }))).toBeNull()
  })
})
