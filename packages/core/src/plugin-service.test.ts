import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as privateFiles from '@conclave/protocol/node'
import { AttachmentStore } from './attachment-store'
import { CredentialStore } from './credential-store'
import { LoginFlows } from './source-login-flow'
import { SourceConfigStore } from './source-config'
import { SourceService } from './source-service'
import { PluginService } from './plugin-service'
import app from '../../../package.json' with { type: 'json' }
import { pluginFixture, pluginZip } from './plugin-fixtures'

describe('plugin installation and activation', () => {
  let root: string
  let config: SourceConfigStore
  let credentials: CredentialStore
  let sources: SourceService
  let plugins: PluginService
  const createService = (version = '0.15.11') => new PluginService(path.join(root, 'plugins'), version, sources, config, [])

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'conclave-plugin-service-'))
    config = new SourceConfigStore(path.join(root, 'sources.json'))
    await config.load()
    credentials = new CredentialStore(path.join(root, 'credentials.json'))
    await credentials.load()
    sources = new SourceService([], config, credentials, new LoginFlows(), {
      importedKeys: () => new Set(), importTask: () => { throw new Error('unused') }, get: () => { throw new Error('unused') }, setSnapshot: () => { throw new Error('unused') }
    }, { dismissedIssues: () => new Set(), dismissIssue: () => {}, restoreIssue: () => {} }, new AttachmentStore(root), { inboxChanged: () => {}, listChanged: () => {} })
    plugins = createService()
    await plugins.load()
  })
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); sources.stop(); await plugins.close(); await rm(root, { recursive: true, force: true }) })

  const install = async (version: string, behavior: Record<string, unknown> = {}) => {
    const from = path.join(root, `input-${version}`)
    await pluginFixture(from, { version, behavior })
    return plugins.install({ kind: 'local', path: from })
  }

  it('loads an installed plugin after upgrading from a stable host to a beta, preserving settings', async () => {
    await install('1.0.0')
    await config.save({ provider: 'demo', instance: 'default', enabled: true, settings: { query: 'mine' } })
    await plugins.close()
    plugins = createService('0.19.6-beta.2')
    await plugins.load()
    expect(plugins.list()[0]).toMatchObject({ id: 'demo.source', enabled: true, problem: null })
    expect(sources.list()[0]?.instances[0]?.settings.query).toBe('mine')
    await plugins.setEnabled('demo.source', true)
    expect(plugins.list()[0]?.problem).toBeNull()
  })

  const release = async (id: string, source: string, version = '1.0.0') => {
    const directory = path.join(root, `release-${id}-${version}`)
    await pluginFixture(directory, { id, source, version })
    const files: Record<string, string> = {}
    for (const name of ['main.mjs', 'manifest.json', 'behavior.json']) files[name] = await readFile(path.join(directory, name), 'utf8')
    const archive = pluginZip(files)
    const repository = `dengjzy/conclave-plugin-${source}`
    const url = `https://github.com/${repository}/releases/download/v${version}/plugin.zip`
    const fetch = vi.fn(async (input: string) => {
      if (input === `https://api.github.com/repos/${repository}/releases/latest`) return new Response(JSON.stringify({ tag_name: `v${version}`, assets: [{ name: 'plugin.zip', browser_download_url: url }] }))
      if (input === url) return new Response(new Uint8Array(archive))
      throw new Error(`Unexpected download: ${input}`)
    })
    vi.stubGlobal('fetch', fetch)
    return fetch
  }

  it('lists four GitHub recommendations and makes no downloads or installations at startup', async () => {
    const fetch = vi.fn(() => { throw new Error('No startup downloads') })
    vi.stubGlobal('fetch', fetch)
    await plugins.close()
    plugins = createService(app.version)
    await plugins.load()
    expect(plugins.recommended().map((entry) => entry.repository)).toEqual([
      'dengjzy/conclave-plugin-github', 'dengjzy/conclave-plugin-jira',
      'dengjzy/conclave-plugin-linear', 'dengjzy/conclave-plugin-zentao'
    ])
    expect(plugins.list()).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
    expect(JSON.stringify(plugins.recommended())).not.toMatch(/directory|autoInstall|bundled/)
  })

  it.each(['github', 'jira', 'linear', 'zentao'])('downloads a recommended %s plugin only on installation', async (source) => {
    const fetch = await release(`conclave.${source}`, source)
    expect(fetch).not.toHaveBeenCalled()
    const result = await plugins.installRecommended(`conclave.${source}`)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ id: `conclave.${source}`, enabled: true, problem: null, origin: { kind: 'github', repository: `dengjzy/conclave-plugin-${source}` } })
    await plugins.installRecommended(`conclave.${source}`)
    expect(fetch).toHaveBeenCalledTimes(2)
    await expect(plugins.installRecommended('other.plugin')).rejects.toThrow('推荐列表')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('keeps an existing bundled GitHub installation working and updates it from its independent repository', async () => {
    const installedPath = path.join(root, 'plugins/conclave.github/1.0.0')
    const manifest = await pluginFixture(installedPath, { id: 'conclave.github', source: 'github' })
    const saved = { version: 1, plugins: [{ manifest, enabled: true, versions: ['1.0.0'], origin: { kind: 'bundled' } }], owners: { jira: 'builtin', github: 'conclave.github' } }
    await writeFile(path.join(root, 'plugins/active.json'), JSON.stringify(saved))
    await config.save({ provider: 'github', instance: 'default', enabled: false, settings: { query: 'org:acme is:issue' } })
    const record = { kind: 'token', payload: { token: 'existing-token' }, account: 'ann', updatedAt: 1 }
    await credentials.set('github', 'default', record)
    const beforeConfig = await readFile(path.join(root, 'sources.json'), 'utf8')
    const beforeCredentials = await readFile(path.join(root, 'credentials.json'), 'utf8')
    const fetch = await release('conclave.github', 'github', '1.0.1')
    await plugins.close()
    plugins = createService(app.version)
    await plugins.load()
    expect(plugins.list()[0]).toMatchObject({ id: 'conclave.github', enabled: true, problem: null, origin: { kind: 'bundled' } })
    expect(fetch).not.toHaveBeenCalled()
    const next = await plugins.update('conclave.github')
    expect(next).toMatchObject({ version: '1.0.1', origin: { kind: 'github', repository: 'dengjzy/conclave-plugin-github' } })
    expect(next.versions).toEqual(['1.0.1', '1.0.0'])
    expect(await readFile(path.join(root, 'sources.json'), 'utf8')).toBe(beforeConfig)
    expect(await readFile(path.join(root, 'credentials.json'), 'utf8')).toBe(beforeCredentials)
  })

  it('keeps old Jira data untouched until an explicit install, then reuses all instances and credentials', async () => {
    await config.save({ provider: 'jira', instance: 'default', enabled: false, settings: { site: 'https://acme.atlassian.net', jql: 'project = ACME' } })
    await config.save({ provider: 'jira', instance: 'other', enabled: true, settings: { site: 'https://other.atlassian.net', jql: 'assignee = currentUser()' } })
    await credentials.set('jira', 'default', { kind: 'basic', payload: { email: 'ann@acme.com', token: 'saved-token' }, account: 'Ann', updatedAt: 1 })
    const beforeConfig = await readFile(path.join(root, 'sources.json'), 'utf8')
    const beforeCredentials = await readFile(path.join(root, 'credentials.json'), 'utf8')
    const pointer = JSON.stringify({ version: 1, plugins: [], owners: { jira: 'builtin', github: 'conclave.github' } })
    await writeFile(path.join(root, 'plugins/active.json'), pointer)
    const fetch = await release('conclave.jira', 'jira')
    await plugins.close()
    plugins = createService(app.version)
    await plugins.load()
    expect(plugins.list()).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
    expect(await readFile(path.join(root, 'plugins/active.json'), 'utf8')).toBe(pointer)
    await plugins.installRecommended('conclave.jira')
    expect(sources.list().find((entry) => entry.provider === 'jira')?.instances).toHaveLength(2)
    await plugins.setEnabled('conclave.jira', false)
    await plugins.close()
    plugins = createService(app.version)
    await plugins.load()
    expect(plugins.list()[0]?.enabled).toBe(false)
    await plugins.uninstall('conclave.jira')
    await plugins.close()
    plugins = createService(app.version)
    await plugins.load()
    expect(plugins.list()).toEqual([])
    expect(fetch).toHaveBeenCalledTimes(2)
    await plugins.installRecommended('conclave.jira')
    expect(plugins.list()).toMatchObject([{ id: 'conclave.jira', problem: null }])
    expect(await readFile(path.join(root, 'sources.json'), 'utf8')).toBe(beforeConfig)
    expect(await readFile(path.join(root, 'credentials.json'), 'utf8')).toBe(beforeCredentials)
  })

  it('leaves installation and existing data unchanged when a release is not published or its ID is wrong', async () => {
    await install('1.0.0')
    const pointer = await readFile(path.join(root, 'plugins/active.json'), 'utf8')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
    await expect(plugins.installRecommended('conclave.jira')).rejects.toThrow('Release')
    expect(await readFile(path.join(root, 'plugins/active.json'), 'utf8')).toBe(pointer)
    await release('other.plugin', 'jira')
    await expect(plugins.installRecommended('conclave.jira')).rejects.toThrow('ID')
    expect(await readFile(path.join(root, 'plugins/active.json'), 'utf8')).toBe(pointer)
  })

  it('copies local artifacts, switches versions, rolls back and persists disabled state', async () => {
    const first = await install('1.0.0')
    expect(first.enabled).toBe(true)
    expect(sources.list().map((source) => source.provider)).toEqual(['demo'])
    await writeFile(path.join(root, 'input-1.0.0/main.mjs'), 'throw new Error("edited development directory")')
    await plugins.setEnabled('demo.source', true)
    await install('1.1.0')
    expect(plugins.list()[0]?.versions).toEqual(['1.1.0', '1.0.0'])
    await plugins.rollback('demo.source', '1.0.0')
    expect(plugins.list()[0]?.version).toBe('1.0.0')
    await plugins.setEnabled('demo.source', false)
    expect(sources.list()).toEqual([])
    await plugins.close()
    plugins = createService()
    await plugins.load()
    expect(plugins.list()[0]?.enabled).toBe(false)
    expect(sources.list()).toEqual([])
  })

  it('keeps the previous active pointer on failed handshake or incompatible settings', async () => {
    await install('1.0.0')
    await config.save({ provider: 'demo', instance: 'default', enabled: true, settings: { query: 'mine' } })
    const pointer = await readFile(path.join(root, 'plugins/active.json'), 'utf8')
    await expect(install('1.1.0', { badHandshake: true })).rejects.toThrow('协议')
    await expect(install('1.2.0', { changeSettings: true })).rejects.toThrow('已有设置')
    expect(await readFile(path.join(root, 'plugins/active.json'), 'utf8')).toBe(pointer)
    expect(plugins.list()[0]?.version).toBe('1.0.0')
    expect(sources.list()[0]?.instances[0]?.settings.query).toBe('mine')
  })

  it('preserves source settings on uninstall and retains ownership against another package', async () => {
    await install('1.0.0')
    await config.save({ provider: 'demo', instance: 'default', enabled: true, settings: { query: 'mine' } })
    await plugins.uninstall('demo.source')
    expect(plugins.list()).toEqual([])
    expect(config.get('demo', 'default')?.settings.query).toBe('mine')
    const from = path.join(root, 'other')
    await pluginFixture(from, { id: 'other.source' })
    await expect(plugins.install({ kind: 'local', path: from })).rejects.toThrow('已被占用')
    await plugins.close()
    plugins = createService()
    await plugins.load()
    expect(plugins.list()).toEqual([])
  })

  it('reserves the GitHub source for its designated package', async () => {
    const from = path.join(root, 'github')
    await pluginFixture(from, { source: 'github' })
    await expect(plugins.install({ kind: 'local', path: from })).rejects.toThrow('已被占用')
  })

  it('resumes the old provider when writing the active pointer fails, and permits retry', async () => {
    await install('1.0.0')
    const pointer = await readFile(path.join(root, 'plugins/active.json'), 'utf8')
    const write = vi.spyOn(privateFiles, 'writePrivateJson').mockRejectedValueOnce(new Error('disk full'))
    await expect(install('1.1.0')).rejects.toThrow('disk full')
    write.mockRestore()
    expect(await readFile(path.join(root, 'plugins/active.json'), 'utf8')).toBe(pointer)
    expect(plugins.list()[0]?.version).toBe('1.0.0')
    expect(sources.list()[0]?.provider).toBe('demo')
    await install('1.1.0')
    expect(plugins.list()[0]?.version).toBe('1.1.0')
  })

  it('recovers an unreferenced version directory left before pointer commit', async () => {
    await install('1.0.0')
    await pluginFixture(path.join(root, 'plugins/demo.source/1.1.0'), { version: '1.1.0', behavior: { badHandshake: true } })
    await install('1.1.0')
    expect(plugins.list()[0]?.version).toBe('1.1.0')
  })

  it('installs a ZIP without an npm install step', async () => {
    const from = path.join(root, 'zip-input')
    await pluginFixture(from)
    const files: Record<string, string> = {}
    for (const name of ['main.mjs', 'manifest.json', 'behavior.json']) files[name] = await readFile(path.join(from, name), 'utf8')
    const zip = path.join(root, 'plugin.zip')
    await writeFile(zip, pluginZip(files))
    await plugins.install({ kind: 'local', path: zip })
    expect(sources.list()[0]?.provider).toBe('demo')
  })
})
