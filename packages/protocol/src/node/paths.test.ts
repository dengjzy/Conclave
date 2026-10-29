import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { conclaveHome, conclavePaths } from './paths'

describe.skipIf(process.platform === 'win32')('daemon socket path', () => {
  it('lives in the home when short enough', () => {
    expect(conclavePaths('/home/me/.conclave').daemonSocket).toBe('/home/me/.conclave/daemon-v3.sock')
  })

  it('falls back to a hashed temp path when the home is too deep for sun_path', () => {
    const deep = `/${'nested/'.repeat(20)}conclave`
    const socket = conclavePaths(deep).daemonSocket
    expect(path.dirname(socket)).toBe(os.tmpdir())
    expect(socket).not.toBe(conclavePaths(`${deep}-other`).daemonSocket)
  })
})

describe('home directory', () => {
  it('takes CONCLAVE_HOME where it is set', () => {
    expect(conclaveHome({ CONCLAVE_HOME: '/a' }, '/home/me')).toBe(path.resolve('/a'))
  })

  it('defaults to ~/.conclave', () => {
    expect(conclaveHome({}, '/home/me')).toBe(path.join('/home/me', '.conclave'))
  })

  it('keeps installed skills under home', () => {
    expect(conclavePaths('/home/me/.conclave').skills).toBe(path.join('/home/me/.conclave', 'skills'))
  })
})
