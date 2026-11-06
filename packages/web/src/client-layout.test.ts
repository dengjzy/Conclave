import { describe, expect, it } from 'vitest'
import { clientLayout, localNodeAvailable } from './client-layout'

describe('node client entry', () => {
  it('keeps computer browsers in the original UI even in a narrow window', () => {
    expect(clientLayout({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })).toBe('desktop')
    expect(clientLayout({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })).toBe('desktop')
  })
  it('routes Android, iPhone and iPad browsers to agents-go', () => {
    for (const userAgent of ['Mozilla/5.0 (Linux; Android 14)', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)', 'Mozilla/5.0 (iPad; CPU OS 18_0)']) {
      expect(clientLayout({ userAgent })).toBe('mobile')
    }
    expect(clientLayout({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', touchPoints: 5 })).toBe('mobile')
    expect(clientLayout({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', touchPoints: 0 })).toBe('desktop')
  })
  it('honors an explicit layout and keeps a native desktop shell on desktop', () => {
    expect(clientLayout({ userAgent: 'Android', override: 'desktop' })).toBe('desktop')
    expect(clientLayout({ userAgent: 'Linux', override: 'mobile' })).toBe('mobile')
    expect(clientLayout({ userAgent: 'Android', desktopBridge: true })).toBe('desktop')
  })
  it('never assumes a public origin has a local core', () => {
    expect(localNodeAvailable('node.example.com')).toBe(false)
    expect(localNodeAvailable('10.0.0.2')).toBe(false)
    expect(localNodeAvailable('127.0.0.1')).toBe(true)
    expect(localNodeAvailable('localhost')).toBe(true)
    expect(localNodeAvailable('[::1]')).toBe(true)
    expect(localNodeAvailable('', true)).toBe(true)
  })
})
