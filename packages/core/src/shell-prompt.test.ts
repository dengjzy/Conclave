import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ShellPrompt, terminalEnv } from './shell-prompt'

const zsh = ['/bin/zsh', '/usr/bin/zsh'].find((candidate) => existsSync(candidate))
let root: string
let home: string

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'conclave-shell-prompt-'))
  home = path.join(root, 'home')
  mkdirSync(home)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

// What a login shell started as Conclave's terminal ends up with, read from inside it.
async function started(files: Record<string, string>, userZdotdir?: string): Promise<Record<string, string>> {
  const dir = userZdotdir ?? home
  mkdirSync(dir, { recursive: true })
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text)
  const env = await new ShellPrompt(path.join(root, 'conclave', 'shell')).env(zsh!, userZdotdir ? { ZDOTDIR: userZdotdir } : {})
  const printed = execFileSync(zsh!, ['-l', '-i', '-c', 'print -r -- "$PROMPT"; print -r -- "${ZDOTDIR-unset}"; print -r -- "${CONCLAVE_USER_ZDOTDIR-unset}"; print -r -- "$READ"'], {
    env: { PATH: process.env.PATH, HOME: home, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  })
  const [prompt = '', zdotdir = '', user = '', read = ''] = printed.split('\n')
  return { prompt, zdotdir, user, read }
}

const READS = { '.zshenv': 'READ=env', '.zprofile': 'READ="$READ profile"', '.zshrc': 'READ="$READ rc"', '.zlogin': 'READ="$READ login"' }

describe('terminalEnv', () => {
  it('says the terminal takes colour, and turns on ls colours unless the user set them', () => {
    expect(terminalEnv({})).toEqual({ COLORTERM: 'truecolor', TERM_PROGRAM: 'Conclave', CLICOLOR: '1' })
    expect(terminalEnv({ CLICOLOR: '0' })).toEqual({ COLORTERM: 'truecolor', TERM_PROGRAM: 'Conclave' })
  })
})

describe.skipIf(!zsh)('ShellPrompt', () => {
  it('reads every startup file of the user\'s, then gives a prompt left as it came colour', async () => {
    const shell = await started(READS)
    expect(shell).toMatchObject({ read: 'env profile rc login', zdotdir: 'unset', user: 'unset' })
    expect(shell.prompt).toContain('%F{cyan}%1~%f')
  })

  it('leaves a prompt the user set alone', async () => {
    expect((await started({ '.zshrc': "PROMPT='mine> '" })).prompt).toBe('mine> ')
  })

  it('reads them from a ZDOTDIR of the user\'s, and hands it back', async () => {
    const own = path.join(root, 'dotfiles')
    expect(await started(READS, own)).toMatchObject({ read: 'env profile rc login', zdotdir: own, user: 'unset' })
  })

  it('is only for zsh', async () => {
    expect(await new ShellPrompt(path.join(root, 'conclave')).env('/bin/bash')).toBeNull()
  })
})
