import { randomUUID } from 'node:crypto'
import type { CheckResult, EnvironmentDemand, Flow } from '@conclave/protocol'

export type FailureKind = 'compile' | 'test' | 'environment' | 'unknown'

// A check's text is the only thing the engine has to go on. The classes are deliberately coarse:
// they decide whether to retry the same agent, switch, or stop, not what the bug is.
export function classifyFailure(results: readonly CheckResult[]): FailureKind {
  if (results.some((result) => result.status === 'blocked')) return 'environment'
  const text = results.map((result) => `${result.failures.join('\n')}\n${result.tail}`).join('\n').toLowerCase()
  if (/enoent|command not found|permission denied|eaddrinuse|econnrefused|network|timed out|timeout/.test(text)) return 'environment'
  if (/error ts\d|syntaxerror|compilation|build failed|cannot find module|type error|\btsc\b/.test(text)) return 'compile'
  if (/assertion|expect\(|failing|failed|failure|test|spec/.test(text)) return 'test'
  return 'unknown'
}

export function detectEnvironmentDemand(results: readonly CheckResult[]): EnvironmentDemand | null {
  const text = results.map((result) => `${result.failures.join('\n')}\n${result.tail}`).join('\n')

  const cmdMatch = text.match(/(?:command not found|not found|cannot find command)[:\s]+['"`]?([a-zA-Z0-9_.-]+)['"`]?/i)
    ?? text.match(/['"`]?([a-zA-Z0-9_.-]+)['"`]?:\s*(?:command not found|not found)/i)
  if (cmdMatch && cmdMatch[1] && !/node|npm|pnpm|sh|bash/.test(cmdMatch[1])) {
    const cmd = cmdMatch[1]
    return {
      id: randomUUID(),
      type: 'command',
      target: cmd,
      reason: `缺少命令或 CLI 工具: ${cmd}`,
      suggestion: `在系统中安装 ${cmd}，或配置对应的 MCP Server 提供该工具`
    }
  }

  const envMatch = text.match(/\b([A-Z0-9_]{3,}_(?:KEY|TOKEN|SECRET|URL|PATH|HOST))\b/)
  if (envMatch && envMatch[1]) {
    const envVar = envMatch[1]
    return {
      id: randomUUID(),
      type: 'env_var',
      target: envVar,
      reason: `缺少必要的环境变量: ${envVar}`,
      suggestion: `在设置或任务中配置环境变量 ${envVar}`
    }
  }

  const serviceMatch = text.match(/(?:ECONNREFUSED|ETIMEDOUT|EADDRINUSE)\s+([\d.]+:\d+|localhost:\d+)/i)
  if (serviceMatch && serviceMatch[1]) {
    return {
      id: randomUUID(),
      type: 'service',
      target: serviceMatch[1],
      reason: `无法连接到本地服务或端口被占用: ${serviceMatch[1]}`,
      suggestion: `启动对应后台服务 (${serviceMatch[1]}) 或配置对应代理`
    }
  }

  if (/adb|device not found|no devices\/emulators found/i.test(text)) {
    return {
      id: randomUUID(),
      type: 'mcp',
      target: 'android-tools',
      reason: '未检测到可用 Android 设备或 ADB 环境',
      suggestion: '连接设备或启用 android/servo MCP 插件'
    }
  }
  if (/playwright|puppeteer|browser is not running|devtools/i.test(text)) {
    return {
      id: randomUUID(),
      type: 'mcp',
      target: 'chrome-devtools',
      reason: '缺少浏览器或 Chrome DevTools 控制端',
      suggestion: '提供 chrome-devtools MCP 或启动本地无头浏览器'
    }
  }

  return {
    id: randomUUID(),
    type: 'command',
    target: 'environment',
    reason: results[0]?.failures[0] || '环境依赖未满足，等待外部补给',
    suggestion: '检查运行环境并提供必要工具或 MCP'
  }
}

// A failure that repeats with the same output is not progress; retrying it again is just spending.
export function failureSignature(results: readonly CheckResult[]): string {
  return results.map((result) => result.signature || `${result.repo}\n${result.command}\n${result.exitCode ?? 'null'}`).join('|')
}

// The last few attempts, in the order they happened. A retry prompt carries this so the next agent
// can avoid repeating a dead end rather than seeing only the newest failure.
export function attemptHistory(flow: Pick<Flow, 'attempts'>, limit = 5): string {
  return flow.attempts.slice(-limit).map((attempt) => {
    const outcome = attempt.result ?? attempt.state
    const kind = attempt.failureKind ? ` · ${attempt.failureKind}` : ''
    return `#${attempt.number} ${attempt.agent ?? '—'} · ${outcome}${kind}`
  }).join('\n')
}
