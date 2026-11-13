import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execute = promisify(execFile)
const entry = fileURLToPath(new URL('./acp-account-login.mjs', import.meta.url))
let root: string
let credentials: string
let business: string
let log: string
let children: ChildProcess[]
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'conclave-acp-login-'))
  credentials = path.join(root, 'account', 'antigravity-acp', 'acp_token.json')
  business = path.join(path.dirname(credentials), 'acp_business_token.json')
  log = path.join(root, 'requests.jsonl')
  children = []
  await mkdir(path.dirname(credentials), { recursive: true })
  await writeFile(credentials, 'previous-login', { mode: 0o600 })
  await writeFile(business, 'previous-business-login', { mode: 0o600 })
})
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((resolve) => child.once('exit', resolve))
      child.kill('SIGKILL')
      await closed
    }
  }
  await rm(root, { recursive: true, force: true })
})

async function server(mode: string, token = credentials, requests = log) {
  const file = path.join(root, 'fake-server.mjs')
  await writeFile(file, `import { createInterface } from 'node:readline'; import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'; import path from 'node:path';
const [active, log, mode, previous] = process.argv.slice(2);
const staged = path.join(process.env.GEMINI_HOME, 'antigravity-acp', 'acp_token.json');
createInterface({ input: process.stdin }).on('line', line => {
 const frame=JSON.parse(line); appendFileSync(log, frame.method+'\\n');
 const result = frame.method === 'initialize' ? {authMethods:[{id:'oauth-personal'}]} : {};
 if(frame.method === 'authenticate') {
   if(staged === active || existsSync(staged)) throw new Error('login reused active credentials');
   if((existsSync(active) ? readFileSync(active,'utf8') : null) !== JSON.parse(previous)) throw new Error('active credentials changed before login completed');
   if(mode !== 'missing') {
     mkdirSync(path.dirname(staged),{recursive:true});
     writeFileSync(staged,'new-login',{mode:0o600});
   }
   if(mode === 'hang') return;
   if(mode === 'fail') { console.log(JSON.stringify({id:frame.id,error:{code:-32000,message:'fixture rejected'}})); return; }
 }
 console.log(JSON.stringify({id:frame.id,result}));
});`)
  const previous = await readFile(token, 'utf8').catch(() => null)
  return [entry, JSON.stringify({ file: process.execPath, args: [file, token, requests, mode, JSON.stringify(previous)], credentials: [token, path.join(path.dirname(token), 'acp_business_token.json')] })]
}

async function hangingLogin() {
  const child = spawn(process.execPath, await server('hang'), { stdio: 'ignore' })
  children.push(child)
  const closed = new Promise<number | null>((resolve) => child.once('exit', resolve))
  await vi.waitFor(async () => expect(await readFile(log, 'utf8')).toContain('authenticate'), { timeout: 5000, interval: 10 })
  return { child, closed }
}

async function expectPreviousLogin() {
  expect(await readFile(credentials, 'utf8')).toBe('previous-login')
  expect(await readFile(business, 'utf8')).toBe('previous-business-login')
}

describe('ACP account login', () => {
  it('authenticates in a separate home and atomically replaces credentials before clearing the old business login', async () => {
    const result = await execute(process.execPath, await server('ok'), { timeout: 10000, env: { ...process.env, GEMINI_HOME: path.join(root, 'account') } })
    expect(await readFile(log, 'utf8')).toBe('initialize\nauthenticate\n')
    expect(await readFile(credentials, 'utf8')).toBe('new-login')
    await expect(readFile(business, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(path.join(path.dirname(credentials), '.conclave-login'))).toEqual([])
    expect(result.stdout).toContain('登录成功')
    expect(result.stdout + result.stderr).not.toContain('new-login')
  })

  it('also signs in a default account without a GEMINI_HOME override or previous token', async () => {
    await rm(credentials)
    await execute(process.execPath, await server('ok'), { timeout: 10000, env: { ...process.env, GEMINI_HOME: '' } })
    expect(await readFile(credentials, 'utf8')).toBe('new-login')
  })

  it('keeps the previous login when authentication fails after writing staged credentials', async () => {
    await expect(execute(process.execPath, await server('fail'), { timeout: 10000 })).rejects.toMatchObject({ code: 1 })
    await expectPreviousLogin()
  })

  it('keeps the previous login when a server succeeds without saving credentials', async () => {
    await expect(execute(process.execPath, await server('missing'), { timeout: 10000 })).rejects.toMatchObject({ code: 1 })
    await expectPreviousLogin()
  })

  it('reports a failure to clear the business login without rolling back a committed personal login', async () => {
    await rm(business)
    await mkdir(business)
    await expect(execute(process.execPath, await server('ok'), { timeout: 10000 })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('新账号凭据已保存') })
    expect(await readFile(credentials, 'utf8')).toBe('new-login')
  })

  it.skipIf(process.platform === 'win32').each([['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const)('preserves credentials when the terminal sends %s', async (signal, code) => {
    const { child, closed } = await hangingLogin()
    await expectPreviousLogin()
    child.kill(signal)
    expect(await closed).toBe(code)
    await expectPreviousLogin()
    expect(await readdir(path.join(path.dirname(credentials), '.conclave-login'))).toEqual([])
  })

  it('keeps credentials after a forced kill and reclaims the dead login on the next attempt', async () => {
    const { child, closed } = await hangingLogin()
    child.kill('SIGKILL')
    await closed
    await expectPreviousLogin()
    expect(await readdir(path.join(path.dirname(credentials), '.conclave-login'))).toHaveLength(1)
    await execute(process.execPath, await server('ok'), { timeout: 10000 })
    expect(await readFile(credentials, 'utf8')).toBe('new-login')
    expect(await readdir(path.join(path.dirname(credentials), '.conclave-login'))).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('rejects a concurrent login without changing the first one and releases its claim afterwards', async () => {
    const { child, closed } = await hangingLogin()
    await expect(execute(process.execPath, await server('ok'), { timeout: 10000 })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('此账号正在登录') })
    expect(await readFile(log, 'utf8')).toBe('initialize\nauthenticate\n')
    await expectPreviousLogin()
    child.kill('SIGTERM')
    await closed
    await execute(process.execPath, await server('ok'), { timeout: 10000 })
    expect(await readFile(credentials, 'utf8')).toBe('new-login')
  })

  it.skipIf(process.platform === 'win32')('allows different accounts to sign in concurrently', async () => {
    const { child, closed } = await hangingLogin()
    const other = path.join(root, 'other', 'antigravity-acp', 'acp_token.json')
    await execute(process.execPath, await server('ok', other, path.join(root, 'other-requests.jsonl')), { timeout: 10000 })
    expect(await readFile(other, 'utf8')).toBe('new-login')
    child.kill('SIGTERM')
    await closed
    await expectPreviousLogin()
  })

  it('stages agy 1.5+ --gemini-dir logins with a keyring bypass marker and publishes companion state', async () => {
    const accountHome = path.join(root, 'cli-account')
    const cliToken = path.join(accountHome, 'antigravity-cli', 'antigravity-oauth-token')
    const fakeAgy = path.join(root, 'fake-agy.mjs')
    await writeFile(fakeAgy, `import { createInterface } from 'node:readline'; import { existsSync, mkdirSync, writeFileSync } from 'node:fs'; import path from 'node:path';
const idx = process.argv.indexOf('--gemini-dir');
const geminiDir = idx >= 0 ? process.argv[idx + 1] : '';
if (!geminiDir) throw new Error('expected --gemini-dir');
const marker = path.join(geminiDir, 'antigravity-cli', 'cache', 'antigravity-keyring-unavailable');
if (!existsSync(marker)) throw new Error('expected keyring bypass marker before spawn');
createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line);
  if (frame.method === 'initialize') {
    console.log(JSON.stringify({ id: frame.id, result: { authMethods: [{ id: 'oauth-personal' }] } }));
    return;
  }
  if (frame.method === 'authenticate') {
    const cliDir = path.join(geminiDir, 'antigravity-cli');
    mkdirSync(path.join(cliDir, 'cache'), { recursive: true });
    writeFileSync(path.join(cliDir, 'antigravity-oauth-token'), 'cli-token-payload', { mode: 0o600 });
    writeFileSync(path.join(cliDir, 'cache', 'default_project_id.txt'), 'proj-156', { mode: 0o600 });
    writeFileSync(path.join(cliDir, 'cache', 'acp-auth-state.json'), '{"methodId":"oauth-personal"}', { mode: 0o600 });
    console.log(JSON.stringify({ id: frame.id, result: {} }));
  }
});`)
    await execute(process.execPath, [
      entry,
      JSON.stringify({
        file: process.execPath,
        args: [fakeAgy, 'acp', '--stdio'],
        credentials: [cliToken, credentials],
        geminiDir: true
      })
    ], { timeout: 10000 })

    expect(await readFile(cliToken, 'utf8')).toBe('cli-token-payload')
    expect(await readFile(path.join(accountHome, 'antigravity-cli', 'cache', 'default_project_id.txt'), 'utf8')).toBe('proj-156')
    expect(await readFile(path.join(accountHome, 'antigravity-cli', 'cache', 'antigravity-keyring-unavailable'), 'utf8')).toBe('')
    await expect(readFile(credentials, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('writes antigravity-keyring-unavailable for directDefault agy logins before spawning', async () => {
    const defaultHome = path.join(root, 'direct-default')
    const cliToken = path.join(defaultHome, 'antigravity-cli', 'antigravity-oauth-token')
    const fakeAgy = path.join(root, 'fake-agy-default.mjs')
    await writeFile(fakeAgy, `import { createInterface } from 'node:readline'; import { existsSync, mkdirSync, writeFileSync } from 'node:fs'; import path from 'node:path';
if (process.argv.includes('--gemini-dir')) throw new Error('unexpected --gemini-dir for directDefault');
const home = process.env.GEMINI_HOME;
const marker = path.join(home, 'antigravity-cli', 'cache', 'antigravity-keyring-unavailable');
if (!existsSync(marker)) throw new Error('expected keyring bypass marker before spawn');
createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line);
  if (frame.method === 'initialize') { console.log(JSON.stringify({ id: frame.id, result: { authMethods: [{ id: 'oauth-personal' }] } })); return; }
  if (frame.method === 'authenticate') {
    mkdirSync(path.join(home, 'antigravity-cli'), { recursive: true });
    writeFileSync(path.join(home, 'antigravity-cli', 'antigravity-oauth-token'), 'default-cli-token', { mode: 0o600 });
    console.log(JSON.stringify({ id: frame.id, result: {} }));
  }
});`)
    await execute(process.execPath, [
      entry,
      JSON.stringify({
        file: process.execPath,
        args: [fakeAgy, 'acp', '--stdio'],
        credentials: [cliToken],
        directDefault: true
      })
    ], { timeout: 10000, env: { ...process.env, GEMINI_HOME: defaultHome } })
    expect(await readFile(cliToken, 'utf8')).toBe('default-cli-token')
    expect(await readFile(path.join(defaultHome, 'antigravity-cli', 'cache', 'antigravity-keyring-unavailable'), 'utf8')).toBe('')
  })
})
