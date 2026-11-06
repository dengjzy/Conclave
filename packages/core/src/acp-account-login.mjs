import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'

const { file, args, credentials } = JSON.parse(process.argv[2])
const loginRoot = path.join(path.dirname(credentials[0]), '.conclave-login')
let home
let child
let finished = false
let timer
let cancelled

async function finish(code) {
  if (finished) return
  finished = true
  clearTimeout(timer)
  let committed = false
  try {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((resolve) => child.once('close', resolve))
      child.kill('SIGTERM')
      const kill = setTimeout(() => child.kill('SIGKILL'), 2000)
      await closed
      clearTimeout(kill)
    }
    code = cancelled ?? code
    if (code === 0) {
      // The temporary home is on the same filesystem; a failed or interrupted login
      // never removes the live token, and publishing it is one atomic replacement.
      await rename(path.join(home, path.basename(path.dirname(credentials[0])), path.basename(credentials[0])), credentials[0])
      committed = true
      await Promise.all(credentials.slice(1).map((file) => rm(file, { force: true })))
      console.log('Google 账号登录成功，终端即将关闭。')
    }
  } catch {
    console.error(committed ? '新账号凭据已保存，但未能清除旧企业登录' : '客户端未保存账号凭据或无法保存，请重试')
    code = 1
  } finally {
    if (home) await rm(home, { recursive: true, force: true }).catch(() => {})
  }
  process.exit(code)
}

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.once(signal, () => { cancelled = code; if (child) void finish(code) })
}

try {
  await mkdir(loginRoot, { recursive: true, mode: 0o700 })
  // Publish a unique PID claim before looking for competitors. Claims are never
  // reused, so reclaiming a dead owner cannot remove a newer login's lock.
  home = await mkdtemp(path.join(loginRoot, `${process.pid}-`))
  for (const name of await readdir(loginRoot)) {
    if (name === path.basename(home)) continue
    const owner = Number(/^(\d+)-/.exec(name)?.[1])
    if (!owner) continue
    try { process.kill(owner, 0) } catch (error) {
      if (error.code === 'ESRCH') {
        await rm(path.join(loginRoot, name), { recursive: true, force: true })
        continue
      }
    }
    throw new Error('login-busy')
  }
  if (cancelled) throw new Error('cancelled')
  child = spawn(file, args, { env: { ...process.env, GEMINI_HOME: home }, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
  const send = (id, method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  child.once('error', () => { console.error('无法启动登录进程'); void finish(1) })
  child.once('close', () => { if (!finished) { console.error('登录进程提前退出'); void finish(1) } })
  child.stdin.on('error', () => { if (!finished) void finish(1) })
  timer = setTimeout(() => { console.error('登录超时，请重试'); void finish(1) }, 360_000)
  createInterface({ input: child.stdout }).on('line', async (line) => {
    if (finished) return
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      if (line.trim()) console.log(line)
      return
    }
    if (frame.method && frame.id !== undefined) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Not supported during sign-in' } })}\n`)
      return
    }
    if (frame.id !== 1 && frame.id !== 2) return
    if (frame.error) {
      const msg = frame.error.message || ''
      const detail = frame.error.data ? (typeof frame.error.data === 'string' ? frame.error.data : JSON.stringify(frame.error.data)) : ''
      console.error(`Google 登录未完成: ${msg} ${detail}`.trim())
      await finish(1)
      return
    }
    if (frame.id === 1) {
      if (!frame.result?.authMethods?.some((method) => method.id === 'oauth-personal')) {
        console.error('此客户端不支持 Google OAuth 登录')
        await finish(1)
        return
      }
      send(2, 'authenticate', { methodId: 'oauth-personal' })
    } else {
      await finish(0)
    }
  })
  console.log('请在浏览器中选择要添加的 Google 账号；如未自动打开，请打开下方登录链接。')
  send(1, 'initialize', { protocolVersion: 1, clientInfo: { name: 'conclave', version: '1' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
} catch (error) {
  if (!cancelled) console.error(error.message === 'login-busy' ? '此账号正在登录，请先完成或关闭已有登录终端' : '无法准备账号登录，请检查目录权限')
  await finish(cancelled ?? 1)
}
