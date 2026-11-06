import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import type { RemoteAccessStatus } from '@conclave/protocol'
import { setLocale } from '../i18n'
import { RemoteSettingsPanel } from './RemoteSettings'

const disabled: RemoteAccessStatus = { supported: true, state: 'disabled', clientUrl: null, problem: null, access: 'control', devices: [] }
const device = { id: 'phone', name: 'Pixel', createdAt: 1000, lastSeenAt: 2000, online: true }
const render = (status: RemoteAccessStatus, busy = false) => renderToStaticMarkup(createElement(RemoteSettingsPanel, {
  status, busy, onToggle: () => {}, onInvite: () => {}, onRevoke: () => {}, onWebToggle: () => {}
}))
beforeEach(() => setLocale('zh-CN'))

describe('remote access settings', () => {
  it('keeps unsupported hosts from offering an unusable start action', () => {
    const html = render({ ...disabled, supported: false })
    expect(html).toContain('Linux x64')
    expect(html).toContain('打开连接端')
    expect(html).not.toContain('role="switch"')
    expect(html).not.toContain('添加设备')
  })

  it.each(['preparing', 'starting'] as const)('allows %s to be stopped without offering pairing too early', (state) => {
    const html = render({ ...disabled, state })
    expect(html).toContain('role="switch"')
    expect(html).toContain('checked=""')
    expect(html).not.toContain('disabled=""')
    expect(html).not.toContain('添加设备')
  })

  it('retains paired devices as offline after remote access is stopped', () => {
    const html = render({ ...disabled, devices: [device] })
    expect(html).toContain('Pixel')
    expect(html).toContain('离线')
    expect(html).not.toContain('data-online')
    expect(html).not.toContain('checked=""')
    expect(html).not.toContain('添加设备')
  })

  it('identifies the device affected by revocation and shows pairing only while ready', () => {
    const html = render({ ...disabled, state: 'ready', devices: [device] })
    expect(html).toContain('添加设备')
    expect(html).toContain('在线')
    expect(html).toContain('aria-label="撤销 Pixel 的访问权限"')
    expect(html).not.toContain('data:')
  })

  it('offers APK pairing independently of the browser publisher', () => {
    const html = render({ ...disabled, state: 'ready', clientUrl: null })
    expect(html).toContain('App 通道已就绪')
    expect(html).toContain('打开 agents-go')
    expect(html).toContain('添加设备')
    expect(html).not.toContain('role="alert"')
  })

  it('keeps App pairing available when browser publication fails and offers an independent retry', () => {
    const html = render({ ...disabled, state: 'ready', webState: 'error', webProblem: '网页发布失败，App 可继续使用。' })
    expect(html).toContain('添加设备')
    expect(html).toContain('发布失败')
    expect(html).toContain('重新发布')
    expect(html).toContain('网页发布失败，App 可继续使用。')
    expect(html).not.toContain('复制网页地址')
  })

  it('offers cancellation while publishing and the actual URL only when ready', () => {
    const pending = render({ ...disabled, state: 'ready', webState: 'preparing' })
    expect(pending).toContain('取消发布')
    expect(pending).not.toContain('复制网页地址')
    const ready = render({ ...disabled, state: 'ready', webState: 'ready', clientUrl: 'https://client.example.test' })
    expect(ready).toContain('href="https://client.example.test"')
    expect(ready).toContain('复制网页地址')
    expect(ready).toContain('停止发布')
  })

  it('offers a desktop client without requiring this machine to publish its own node', () => {
    const html = render(disabled)
    expect(html).toContain('href="/conclave?node=connect"')
    expect(html).toContain('打开连接端')
    expect(html).not.toContain('发布网页')
  })

  it('does not offer unknown publisher RPCs on an older host', () => {
    const html = render({ ...disabled, state: 'ready' })
    expect(html).not.toContain('发布网页')
    expect(html).not.toContain('重新发布')
  })

  it('offers retry after failure without treating stale devices as online', () => {
    const html = render({ ...disabled, state: 'error', problem: '连接不可用', devices: [device] })
    expect(html).toContain('role="alert">连接不可用')
    expect(html).toContain('重试')
    expect(html).toContain('离线')
    expect(html).not.toContain('data-online')
    expect(html).not.toContain('添加设备')
  })

  it('prevents competing actions while a request is pending and localizes the controls', () => {
    setLocale('en')
    const html = render({ ...disabled, state: 'ready', devices: [device] }, true)
    expect(html).toContain('Add device')
    expect(html).toContain('Revoke access for Pixel')
    expect(html.match(/disabled=""/g)).toHaveLength(3)
  })
})
