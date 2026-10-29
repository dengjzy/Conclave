import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { commandExists, parseWindowsShim, planLaunch, resolveCommand, type LaunchHost } from './command-launch'

// What npm's cmd-shim writes today, for codex.
const NPM_SHIM = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*'
].join('\r\n')

// What pnpm writes for a global install.
const PNPM_SHIM = [
  '@SETLOCAL', '@IF NOT DEFINED NODE_PATH (', '  @SET "NODE_PATH=C:\\pnpm\\global\\5\\.pnpm\\node_modules"', ') ELSE (',
  '  @SET "NODE_PATH=C:\\pnpm\\global\\5\\.pnpm\\node_modules;%NODE_PATH%"', ')', '@IF EXIST "%~dp0\\node.exe" (',
  '  "%~dp0\\node.exe"  "%~dp0\\..\\@anthropic-ai\\claude-code\\cli.js" %*', ') ELSE (', '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
  '  node  "%~dp0\\..\\@anthropic-ai\\claude-code\\cli.js" %*', ')'
].join('\r\n')

// A Windows machine in memory: a file is its path, with contents.
function windows(files: Record<string, string>): LaunchHost {
  const has = (file: string) => Object.keys(files).some((each) => each.toLowerCase() === file.toLowerCase())
  return { platform: 'win32', isFile: has, isExecutable: has, read: (file) => files[file] ?? null }
}

describe('parseWindowsShim', () => {
  it('reads the script an npm or pnpm shim runs with node', () => {
    expect(parseWindowsShim(NPM_SHIM)).toEqual({ kind: 'node', script: 'node_modules\\@openai\\codex\\bin\\codex.js' })
    expect(parseWindowsShim(PNPM_SHIM)).toEqual({ kind: 'node', script: '..\\@anthropic-ai\\claude-code\\cli.js', nodePath: 'C:\\pnpm\\global\\5\\.pnpm\\node_modules' })
  })

  it('reads a shim that runs an exe directly', () => {
    expect(parseWindowsShim('@ECHO off\r\n"%~dp0\\bin\\tool.exe"   %*\r\n')).toEqual({ kind: 'direct', target: 'bin\\tool.exe' })
  })

  it('refuses anything it does not recognise exactly', () => {
    expect(parseWindowsShim('@echo off\r\n')).toBeNull()
    expect(parseWindowsShim('@ECHO off\r\n"%~dp0\\%OTHER%\\tool.exe" %*')).toBeNull()
    expect(parseWindowsShim('@ECHO off\r\n"%~dp0\\D:evil.exe" %*')).toBeNull()
    expect(parseWindowsShim(NPM_SHIM.replace('codex.js" %*', 'codex.js" %* & calc'))).toBeNull()
  })
})

describe('planLaunch on Windows', () => {
  const env = { Path: 'C:\\npm;C:\\Program Files\\nodejs', PATHEXT: '.COM;.EXE;.BAT;.CMD' }

  it('runs an npm shim through node, without cmd', () => {
    const host = windows({
      'C:\\npm\\codex': '#!/bin/sh',
      'C:\\npm\\codex.cmd': NPM_SHIM,
      'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js': '',
      'C:\\Program Files\\nodejs\\node.exe': ''
    })
    expect(planLaunch('codex', ['app-server', 'a "quoted"\nprompt'], 'C:\\work', env, host)).toEqual({
      file: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js', 'app-server', 'a "quoted"\nprompt'],
      env
    })
  })

  it('prefers the node beside the shim, and adds what pnpm prepends to NODE_PATH', () => {
    const host = windows({
      'C:\\pnpm\\claude.cmd': PNPM_SHIM,
      'C:\\pnpm\\node.exe': '',
      'C:\\@anthropic-ai\\claude-code\\cli.js': ''
    })
    const launch = planLaunch('claude', ['-p'], 'C:\\', { Path: 'C:\\pnpm', NODE_PATH: 'C:\\mine' }, host)
    expect(launch.file).toBe('C:\\pnpm\\node.exe')
    expect(launch.args).toEqual(['C:\\@anthropic-ai\\claude-code\\cli.js', '-p'])
    expect(launch.env.NODE_PATH).toBe('C:\\pnpm\\global\\5\\.pnpm\\node_modules;C:\\mine')
  })

  it('does not run a node.exe that a node.cmd earlier on PATH would shadow', () => {
    const host = windows({
      'C:\\npm\\codex.cmd': NPM_SHIM,
      'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js': '',
      'C:\\npm\\node.cmd': '',
      'C:\\Program Files\\nodejs\\node.exe': ''
    })
    expect(() => planLaunch('codex', [], 'C:\\', env, host)).toThrow('command-needs-shell')
  })

  it('runs a .cmd that has a PowerShell script beside it through -File', () => {
    const host = windows({
      'C:\\npm\\cursor-agent.cmd': '@echo off\r\npowershell -File "%~dp0cursor-agent.ps1" %*',
      'C:\\npm\\cursor-agent.ps1': '',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe': ''
    })
    expect(planLaunch('cursor-agent', ['acp'], 'C:\\', { ...env, SystemRoot: 'C:\\Windows' }, host)).toMatchObject({
      file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\npm\\cursor-agent.ps1', 'acp']
    })
    // Windows PowerShell would drop the quotes.
    expect(() => planLaunch('cursor-agent', ['say "hi"'], 'C:\\', { ...env, SystemRoot: 'C:\\Windows' }, host)).toThrow('command-needs-shell')
  })

  it('refuses a shim it cannot read, and reports a missing command', () => {
    const host = windows({ 'C:\\npm\\tool.bat': '@echo off\r\nset X=1\r\ntool.exe %*' })
    expect(() => planLaunch('tool', [], 'C:\\', env, host)).toThrow('command-needs-shell')
    expect(() => planLaunch('missing', [], 'C:\\', env, host)).toThrow('command-not-found')
  })

  it('starts an exe as it is, found by PATHEXT or by an explicit path', () => {
    const host = windows({ 'C:\\Program Files\\nodejs\\node.exe': '', 'C:\\work\\bin\\tool.exe': '' })
    expect(planLaunch('node', ['-v'], 'C:\\', env, host)).toEqual({ file: 'C:\\Program Files\\nodejs\\node.exe', args: ['-v'], env })
    expect(resolveCommand('bin\\tool', 'C:\\work', env, host)).toBe('C:\\work\\bin\\tool.exe')
    expect(resolveCommand('node.exe', 'C:\\', env, host)).toBe('C:\\Program Files\\nodejs\\node.exe')
  })
})

describe.skipIf(process.platform === 'win32')('commandExists', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('finds only an executable file on PATH', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'conclave-command-'))
    const file = path.join(dir, 'agent')
    writeFileSync(file, '#!/bin/sh\n')
    const env = { PATH: `/nowhere${path.delimiter}${dir}` }
    expect(commandExists('agent', '/', env)).toBe(false)
    chmodSync(file, 0o755)
    expect(commandExists('agent', '/', env)).toBe(true)
    expect(commandExists('claude-not-installed', '/', env)).toBe(false)
  })

  it('checks a path as it is, relative to the working directory', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'conclave-command-'))
    expect(commandExists(process.execPath, '/', {})).toBe(true)
    expect(commandExists('./missing', dir, {})).toBe(false)
  })
})
