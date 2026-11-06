import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRemoteStaticServer } from './remote-static'
import { startRemoteProcess } from './remote-process'

const roots: string[] = []
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map((close) => close())); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function directory() { const root = await mkdtemp(path.join(os.tmpdir(), 'conclave-remote-runtime-')); roots.push(root); return root }
async function fixture() {
  const root = await directory()
  const webDirectory = path.join(root, 'web')
  const assetsDirectory = path.join(root, 'runtime')
  await mkdir(path.join(webDirectory, 'assets'), { recursive: true })
  await mkdir(assetsDirectory)
  await Promise.all([
    writeFile(path.join(webDirectory, 'mobile.html'), '<html>mobile only</html>'),
    writeFile(path.join(webDirectory, 'remote.html'), '<html>remote desktop client</html>'),
    writeFile(path.join(webDirectory, 'index.html'), 'private desktop management'),
    writeFile(path.join(webDirectory, 'core.json'), 'private token'),
    writeFile(path.join(webDirectory, 'assets/app-123.js'), 'mobile javascript'),
    writeFile(path.join(webDirectory, 'assets/app-123.js.map'), 'private source map'),
    writeFile(path.join(assetsDirectory, 'main.wasm.gz'), 'wasm fixture'),
    writeFile(path.join(assetsDirectory, 'wasm_exec.js'), 'runtime fixture'),
  ])
  return { root, webDirectory, assetsDirectory }
}
function status(origin: string, pathname: string, host?: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const call = request(`${origin}${pathname}`, { headers: host ? { host } : undefined }, (response) => { response.resume(); resolve(response.statusCode) })
    call.on('error', reject)
    call.end()
  })
}

describe('remote static boundary', () => {
  it('serves desktop and mobile clients and immutable flat assets, with browser security headers', async () => {
    const options = await fixture()
    const server = await createRemoteStaticServer(options)
    cleanup.push(server.close)
    const response = await fetch(server.origin)
    expect(await response.text()).toBe('<html>remote desktop client</html>')
    expect(await (await fetch(`${server.origin}/conclave`)).text()).toBe('<html>remote desktop client</html>')
    expect(await (await fetch(`${server.origin}/mobile.html`)).text()).toBe('<html>mobile only</html>')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(response.headers.get('x-conclave-static-instance')).toBe(server.instance)
    expect(await status(server.origin, '/mobile.html')).toBe(200)
    expect(await status(server.origin, '/assets/app-123.js')).toBe(200)
    expect(await status(server.origin, '/assets/main.wasm.gz')).toBe(200)
    for (const denied of ['/index.html', '/api/auth/session', '/host', '/core.json', '/assets/app-123.js.map', '/assets/%2e%2e%2fcore.json', '/assets/%252e%252e%252fcore.json']) {
      expect(await status(server.origin, denied), denied).toBe(404)
    }
    expect((await fetch(server.origin, { method: 'POST' })).status).toBe(404)
    expect(await status(server.origin, '/', 'untrusted.example')).toBe(404)
    server.setPublicOrigin('https://mobile-test.trycloudflare.com')
    expect(await status(server.origin, '/', 'mobile-test.trycloudflare.com')).toBe(200)
    await writeFile(path.join(options.webDirectory, 'assets/app-123.js'), 'replaced after startup')
    expect(await (await fetch(`${server.origin}/assets/app-123.js`)).text()).toBe('mobile javascript')
  })

  it('caches hashed build assets but refreshes unversioned runtime files', async () => {
    const server = await createRemoteStaticServer(await fixture())
    cleanup.push(server.close)
    for (const pathname of ['/', '/conclave', '/remote.html', '/mobile.html', '/assets/missing.js']) {
      const response = await fetch(`${server.origin}${pathname}`)
      expect(response.headers.get('cache-control'), pathname).toBe('no-store')
      await response.arrayBuffer()
    }
    for (const pathname of ['/assets/main.wasm.gz', '/assets/wasm_exec.js', '/assets/app-123.js']) {
      for (const method of ['GET', 'HEAD']) {
        const response = await fetch(`${server.origin}${pathname}`, { method })
        expect(response.status).toBe(200)
        expect(response.headers.get('cache-control'), `${method} ${pathname}`).toBe(pathname === '/assets/app-123.js' ? 'public, max-age=31536000, immutable' : 'no-store')
        await response.arrayBuffer()
      }
    }
    const rejected = await fetch(`${server.origin}/assets/main.wasm.gz`, { method: 'POST' })
    expect(rejected.status).toBe(404)
    expect(rejected.headers.get('cache-control')).toBe('no-store')
    await rejected.arrayBuffer()
  })

  it('accepts a bundled runtime only when it matches the verified runtime', async () => {
    const options = await fixture()
    const builtRuntime = path.join(options.webDirectory, 'assets/wasm_exec.js')
    await writeFile(builtRuntime, 'runtime fixture')
    const server = await createRemoteStaticServer(options)
    cleanup.push(server.close)
    expect(await (await fetch(`${server.origin}/assets/wasm_exec.js`)).text()).toBe('runtime fixture')
    await writeFile(builtRuntime, 'different runtime')
    await expect(createRemoteStaticServer(options)).rejects.toThrow('不匹配')
  })

  it('does not follow a build asset symlink outside the static root', async () => {
    const options = await fixture()
    const secret = path.join(options.root, 'secret.js')
    await writeFile(secret, 'private data')
    await symlink(secret, path.join(options.webDirectory, 'assets/leak.js'))
    const server = await createRemoteStaticServer(options)
    cleanup.push(server.close)
    expect(await status(server.origin, '/assets/leak.js')).toBe(404)
  })

  it('refuses a mobile entry that resolves outside the build directory', async () => {
    const options = await fixture()
    const entry = path.join(options.webDirectory, 'mobile.html')
    await rm(entry)
    const secret = path.join(options.root, 'secret.html')
    await writeFile(secret, 'private data')
    await symlink(secret, entry)
    await expect(createRemoteStaticServer(options)).rejects.toThrow('允许目录')
  })
})

describe('remote child lifecycle', () => {
  it('reports unexpected termination once and keeps subprocess output private', async () => {
    const root = await directory()
    const exited = vi.fn()
    const logFile = path.join(root, 'process.log')
    const child = await startRemoteProcess({ executable: process.execPath, args: ['-e', 'process.stderr.write("private child output"); process.exitCode = 7'], directory: root, logFile, env: process.env, onExit: exited })
    cleanup.push(child.close)
    await vi.waitFor(() => expect(exited).toHaveBeenCalledTimes(1))
    await child.close()
    expect(await readFile(logFile, 'utf8')).toBe('private child output')
    expect((await stat(logFile)).mode & 0o777).toBe(0o600)
    expect(exited).toHaveBeenCalledTimes(1)
  })

  it('terminates a running child exactly once without reporting a deliberate stop', async () => {
    const root = await directory()
    const exited = vi.fn()
    let output = ''
    const child = await startRemoteProcess({ executable: process.execPath, args: ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'], directory: root, logFile: path.join(root, 'process.log'), env: process.env, onOutput: (text) => { output += text }, onExit: exited })
    cleanup.push(child.close)
    await vi.waitFor(() => expect(output).toContain('ready'))
    await Promise.all([child.close(), child.close()])
    await delay(20)
    expect(exited).not.toHaveBeenCalled()
  })
})
