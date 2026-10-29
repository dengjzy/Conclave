import http from 'node:http'
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { fetch } from 'undici'
import { bypassed, envProxy, parseMacProxy, parseWindowsProxy, proxyFor, readProxySettings, systemProxyDispatcher, type ProxySettings } from './system-proxy'

const REG = (lines: string) => `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n${lines}\r\n`

describe('reading the system proxy', () => {
  it('reads Windows Internet Settings, one server for all schemes or per scheme, off when disabled', () => {
    expect(parseWindowsProxy(REG('    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    127.0.0.1:7890\r\n    ProxyOverride    REG_SZ    localhost;127.*;10.*;<local>')))
      .toEqual({ http: 'http://127.0.0.1:7890', https: 'http://127.0.0.1:7890', bypass: ['localhost', '127.*', '10.*', '<local>'] })
    expect(parseWindowsProxy(REG('    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    http=127.0.0.1:8080;https=127.0.0.1:8443;socks=127.0.0.1:1080')))
      .toEqual({ http: 'http://127.0.0.1:8080', https: 'http://127.0.0.1:8443', bypass: [] })
    expect(parseWindowsProxy(REG('    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    socks=127.0.0.1:1080'))).toEqual({ http: null, https: null, bypass: [] })
    expect(parseWindowsProxy(REG('    ProxyEnable    REG_DWORD    0x0\r\n    ProxyServer    REG_SZ    127.0.0.1:7890'))).toEqual({ http: null, https: null, bypass: [] })
  })

  it('reads macOS proxy settings with their exceptions', () => {
    const text = `<dictionary> {
  ExceptionsList : <array> {
    0 : 192.168.0.0/16
    1 : *.local
  }
  ExcludeSimpleHostnames : 1
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 0
}`
    expect(parseMacProxy(text)).toEqual({ http: 'http://127.0.0.1:7890', https: 'http://127.0.0.1:7890', bypass: ['192.168.0.0/16', '*.local', '<local>'] })
    expect(parseMacProxy('<dictionary> {\n  HTTPEnable : 0\n  HTTPSEnable : 0\n}')).toEqual({ http: null, https: null, bypass: [] })
  })

  it('lets environment variables the user set win over the system', async () => {
    expect(envProxy({ https_proxy: 'proxy.corp:3128', NO_PROXY: '.corp, intranet' })).toEqual({ http: null, https: 'http://proxy.corp:3128', bypass: ['.corp', 'intranet'] })
    expect(envProxy({})).toBeNull()
    const settings = await readProxySettings({ platform: 'win32', env: { HTTPS_PROXY: 'http://env:1' }, run: async () => { throw new Error('not asked') } })
    expect(settings.https).toBe('http://env:1')
    expect(await readProxySettings({ platform: 'win32', env: {}, run: async () => { throw new Error('no reg') } })).toEqual({ http: null, https: null, bypass: [] })
  })

  it('sends loopback and listed hosts direct, the rest through the proxy for their scheme', () => {
    const bypass = ['*.local', '<local>', '.corp', '10.0.0.0/8', 'example.org']
    for (const host of ['localhost', '127.0.0.1', '::1', 'printer.local', 'intranet', 'git.corp', '10.2.3.4', 'example.org', 'api.example.org']) expect(bypassed(host, bypass)).toBe(true)
    for (const host of ['github.com', '11.0.0.1', 'notexample.org']) expect(bypassed(host, bypass)).toBe(false)
    const settings: ProxySettings = { http: 'http://p:1', https: 'http://p:2', bypass }
    expect(proxyFor(settings, new URL('https://github.com/x'))).toBe('http://p:2')
    expect(proxyFor(settings, new URL('http://github.com/x'))).toBe('http://p:1')
    expect(proxyFor(settings, new URL('https://git.corp/x'))).toBeNull()
  })
})

describe('routing requests', () => {
  const servers: { close(): void }[] = []
  afterEach(() => { for (const server of servers.splice(0)) server.close() })

  function listen<T extends net.Server>(server: T): Promise<number> {
    servers.push(server)
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    }))
  }

  it('tunnels a request through the proxy the settings name, and goes direct when they name none', async () => {
    const target = await listen(http.createServer((_request, response) => response.end('hello')))
    const tunnelled: string[] = []
    // Any host it is asked for, it reaches the local target: the client never resolves it itself.
    const proxy = http.createServer()
    proxy.on('connect', (request: http.IncomingMessage, socket: net.Socket) => {
      tunnelled.push(request.url ?? '')
      const upstream = net.connect(target, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        upstream.pipe(socket)
        socket.pipe(upstream)
      })
    })
    const proxyPort = await listen(proxy)
    let settings: ProxySettings = { http: `http://127.0.0.1:${proxyPort}`, https: null, bypass: [] }
    const dispatcher = systemProxyDispatcher(() => settings)
    expect(await (await fetch('http://plugins.example:80/zip', { dispatcher })).text()).toBe('hello')
    expect(tunnelled).toEqual(['plugins.example:80'])
    settings = { http: null, https: null, bypass: [] }
    expect(await (await fetch(`http://127.0.0.1:${target}/`, { dispatcher })).text()).toBe('hello')
    expect(tunnelled).toHaveLength(1)
    await dispatcher.close()
  })
})
