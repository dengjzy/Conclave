import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { PluginManifest } from '@conclave/protocol'
import { PluginProcess } from './plugin-process'

it('loads SDK plugins through the v1 host and completes login, list and fetch', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-sdk-host-'))
  const manifest = PluginManifest.parse({
    id: 'test.sdk', version: '0.1.0', engines: { conclave: '>=0.0.1-0 <1.0.0' },
    contributes: { sources: [{ id: 'demo', name: 'Demo', settings: [] }] },
    entry: { runtime: 'node', main: 'main.mjs' }
  })
  try {
    const artifact = await build({
      stdin: {
        contents: `import { runSourcePlugin } from '@conclave/plugin-sdk'
const issue = { key: 'DEMO-1', title: 'Example', url: 'https://example.com/1', status: 'Open', statusCategory: 'todo', type: 'Issue', priority: null, updatedAt: null }
runSourcePlugin({ manifest: ${JSON.stringify(manifest)}, sources: [{
  id: 'demo', normalizeSettings: (settings) => settings,
  login: async (session) => {
    session.notify({ message: 'Signing in' })
    const account = await session.prompt({ kind: 'text', label: 'Account' })
    const token = await session.prompt({ kind: 'secret', label: 'Token' })
    return { account, credential: { kind: 'token', payload: { token } } }
  },
  list: async () => [issue], fetch: async () => ({ ...issue, markdown: '# Original', images: [{ name: 'screenshot.png', bytes: new Uint8Array(7 * 1024 * 1024).fill(7) }] })
}] })`,
        resolveDir: fileURLToPath(new URL('../../plugin-sdk/', import.meta.url)), loader: 'ts'
      },
      bundle: true, platform: 'node', format: 'esm', target: 'node22', write: false
    })
    const output = artifact.outputFiles[0]
    if (!output) throw new Error('Missing plugin build')
    const main = path.join(directory, 'main.mjs')
    await writeFile(main, output.contents)
    const runtime = new PluginProcess(manifest, main, {})
    try {
      const provider = (await runtime.providers())[0]
      if (!provider) throw new Error('Missing source')
      const questions: string[] = []
      const notices: string[] = []
      const login = await provider.login({
        prompt: async (prompt) => { questions.push(prompt.kind); return prompt.kind === 'secret' ? 'token' : 'ann' },
        notify: (notice) => { notices.push(notice.message) }
      }, {}, new AbortController().signal)
      expect(questions).toEqual(['text', 'secret'])
      expect(notices).toEqual(['Signing in'])
      expect(login.account).toBe('ann')
      const issues = await provider.list({}, login.credential, new AbortController().signal)
      expect(issues).toMatchObject([{ key: 'DEMO-1' }])
      const detail = await provider.fetch({}, login.credential, 'DEMO-1', new AbortController().signal)
      expect(detail).toMatchObject({ ...issues[0], markdown: '# Original' })
      expect(detail.images).toHaveLength(1)
      expect(detail.images?.[0]?.name).toBe('screenshot.png')
      expect(detail.images?.[0]?.bytes.length).toBe(7 * 1024 * 1024)
      expect(detail.images?.[0]?.bytes.every((byte) => byte === 7)).toBe(true)
    } finally { runtime.stop() }
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 20_000)
