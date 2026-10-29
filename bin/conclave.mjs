#!/usr/bin/env node
import { spawn, execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

function conclaveHome() {
  return process.env.CONCLAVE_HOME ? path.resolve(process.env.CONCLAVE_HOME) : path.join(os.homedir(), '.conclave')
}

function conclavePaths(home = conclaveHome()) {
  const socketName = 'daemon-v3.sock'
  return {
    home,
    coreEndpoint: path.join(home, 'core.json'),
    daemonSocket: path.join(home, socketName)
  }
}

async function readCoreEndpoint(home = conclaveHome()) {
  try {
    const file = path.join(home, 'core.json')
    const text = await readFile(file, 'utf8')
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function removeCoreEndpoint(pid, home = conclaveHome()) {
  try {
    const file = path.join(home, 'core.json')
    const current = await readCoreEndpoint(home)
    if (!pid || current?.pid === pid) {
      await rm(file, { force: true })
    }
  } catch {}
}

function probeSocket(socketPath) {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath)
    socket.setTimeout(1000, () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      resolve(false)
    })
  })
}

function getLanIp() {
  const interfaces = os.networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address
      }
    }
  }
  return null
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function startServer(args) {
  let targetPort = 43551
  let targetHost = process.env.CONCLAVE_HOST ?? '127.0.0.1'
  let openBrowser = false
  let withDaemon = true

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      targetPort = Number(args[i + 1])
      i++
    } else if (args[i] === '--host') {
      const next = args[i + 1]
      targetHost = (next && !next.startsWith('-')) ? next : '0.0.0.0'
      if (next && !next.startsWith('-')) i++
    } else if (args[i] === '--open') {
      openBrowser = true
    } else if (args[i] === '--no-daemon') {
      withDaemon = false
    }
  }

  if (process.env.CONCLAVE_PORT) targetPort = Number(process.env.CONCLAVE_PORT)
  else if (process.env.PORT) targetPort = Number(process.env.PORT)

  // 1. Ensure Web assets are built
  const webDist = path.join(ROOT, 'packages/web/dist/index.html')
  if (!existsSync(webDist)) {
    console.log('[conclave] 未检测到 Web 编译资源，正在执行首次生产构建...')
    execSync('pnpm --filter @conclave/web run build', { cwd: ROOT, stdio: 'inherit' })
  }

  // 2. Ensure Daemon is alive
  const paths = conclavePaths()
  if (withDaemon) {
    const daemonLive = await probeSocket(paths.daemonSocket)
    if (!daemonLive) {
      console.log('[conclave] 正在拉起 Conclave 守护进程 (Daemon)...')
      const daemonProc = spawn(process.execPath, ['--import', 'tsx', 'packages/daemon/src/main.ts'], {
        cwd: ROOT,
        detached: true,
        stdio: 'ignore'
      })
      daemonProc.unref()

      // Wait up to 5s for daemon socket
      let ready = false
      for (let attempt = 0; attempt < 25; attempt++) {
        await new Promise((r) => setTimeout(r, 200))
        if (await probeSocket(paths.daemonSocket)) {
          ready = true
          break
        }
      }
      if (ready) {
        console.log('[conclave] Conclave Daemon 守护进程就绪')
      } else {
        console.warn('[conclave] 守护进程启动超时，尝试继续启动 Core...')
      }
    } else {
      console.log('[conclave] Daemon 守护进程已就绪 (复用已有连接)')
    }
  }

  // 3. Start Core
  console.log(`[conclave] 正在启动 Conclave Core (端口: ${targetPort}, 监听: ${targetHost})...`)
  const coreArgs = ['--import', 'tsx', 'packages/core/src/main.ts', '--port', String(targetPort), '--host', targetHost]
  const coreProc = spawn(process.execPath, coreArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      CONCLAVE_PORT: String(targetPort),
      CONCLAVE_HOST: targetHost
    }
  })

  if (openBrowser) {
    setTimeout(async () => {
      const endpoint = await readCoreEndpoint()
      if (endpoint?.port) {
        const url = `http://127.0.0.1:${endpoint.port}/conclave?token=${endpoint.token}`
        const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
        spawn(openCmd, [url], { detached: true, stdio: 'ignore' }).unref()
      }
    }, 1500)
  }

  const handleExit = (signal) => {
    if (coreProc.pid) {
      try {
        process.kill(coreProc.pid, signal)
      } catch {}
    }
  }

  process.on('SIGINT', () => handleExit('SIGINT'))
  process.on('SIGTERM', () => handleExit('SIGTERM'))

  coreProc.on('exit', (code) => {
    process.exit(code ?? 0)
  })
}

async function stopServer() {
  const paths = conclavePaths()
  const endpoint = await readCoreEndpoint()
  let stoppedCore = false

  if (endpoint?.pid && isPidAlive(endpoint.pid)) {
    console.log(`[conclave] 发现正在运行的 Core 进程 (PID: ${endpoint.pid})，正在发送停止信号...`)
    try {
      process.kill(endpoint.pid, 'SIGTERM')
      stoppedCore = true
    } catch {}
    await removeCoreEndpoint(endpoint.pid)
  } else if (endpoint) {
    await removeCoreEndpoint(endpoint.pid)
  }

  const daemonLive = await probeSocket(paths.daemonSocket)
  if (daemonLive) {
    console.log(`[conclave] Daemon 守护进程仍在监听 (${paths.daemonSocket})`)
  }

  if (stoppedCore) {
    console.log('[conclave] Conclave Core 进程已成功停止')
  } else {
    console.log('[conclave] 未发现运行中的 Conclave Core 进程')
  }
}

async function checkStatus() {
  const paths = conclavePaths()
  const endpoint = await readCoreEndpoint()
  const daemonLive = await probeSocket(paths.daemonSocket)
  const lanIp = getLanIp()

  console.log('\n=== Conclave 状态概览 ===')
  console.log(`版本: ${pkg.version}`)
  console.log(`数据目录: ${paths.home}`)

  console.log('\n[Daemon 守护进程]')
  if (daemonLive) {
    console.log(`  状态: 🟢 运行中`)
    console.log(`  Socket: ${paths.daemonSocket}`)
  } else {
    console.log(`  状态: ⚪ 未运行`)
  }

  console.log('\n[Core 协调内核]')
  if (endpoint && isPidAlive(endpoint.pid)) {
    console.log(`  状态: 🟢 运行中 (PID: ${endpoint.pid})`)
    console.log(`  端口: ${endpoint.port}`)
    console.log(`  Local:   http://127.0.0.1:${endpoint.port}/conclave?token=${endpoint.token}`)
    if (lanIp) {
      console.log(`  Network: http://${lanIp}:${endpoint.port}/conclave?token=${endpoint.token}`)
    }
  } else {
    console.log(`  状态: ⚪ 未运行`)
  }

  const webDist = path.join(ROOT, 'packages/web/dist/index.html')
  console.log('\n[Web 静态包]')
  console.log(`  状态: ${existsSync(webDist) ? '🟢 已编译' : '🟡 未编译 (首次 start 会自动构建)'}`)
  console.log()
}

async function runDoctor() {
  console.log('\n=== Conclave Agent 连通性健康自检 (Doctor) ===\n')
  try {
    execSync(`node --import tsx scripts/run-doctor.mjs`, { cwd: ROOT, stdio: 'inherit' })
  } catch (err) {
    console.error('[conclave] 执行体检时出错:', err.message)
  }
}

function printHelp() {
  console.log(`
Conclave - 异构多智能体协作与代码编排平台 (v${pkg.version})

用法:
  conclave <命令> [选项]

命令:
  start     一键启动 Conclave (包含守护进程、内核及自托管 Web UI)
  stop      优雅停止运行中的 Conclave 进程
  status    检查 Conclave 守护进程、内核状态与访问地址
  doctor    运行本地 Agent 连通性与健康体检 (Smoke Test)
  help      显示此帮助信息

选项:
  --port <端口>    指定 Core 服务监听端口 (默认: 43551)
  --host [IP]      指定绑定地址 (默认: 127.0.0.1；不带 IP 或 0.0.0.0 允许局域网/手机访问)
  --open           启动完成后自动在默认浏览器中打开 Web UI
  --no-daemon      不拉起 Daemon 守护进程 (用于单独调试 Core)
`)
}

async function main() {
  const args = process.argv.slice(2)
  const command = args[0]

  switch (command) {
    case 'start':
      await startServer(args.slice(1))
      break
    case 'stop':
      await stopServer()
      break
    case 'status':
      await checkStatus()
      break
    case 'doctor':
    case 'test':
      await runDoctor()
      break
    case '--version':
    case '-v':
    case 'version':
      console.log(`Conclave v${pkg.version}`)
      break
    case 'help':
    case '--help':
    case '-h':
    default:
      printHelp()
      break
  }
}

main().catch((err) => {
  console.error('[conclave] 异常退出:', err)
  process.exit(1)
})
