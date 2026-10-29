import { EnvironmentService } from '../packages/core/src/environment-check.ts'
import { runAgentSmokeTest } from '../packages/core/src/agent-smoke-test.ts'

const environment = new EnvironmentService({
  pathEnv: process.env.PATH ?? '',
  platform: process.platform,
  signedIn: {}
})

console.log('正在探测系统环境与 Agent 连通性...\n')
const result = await runAgentSmokeTest(undefined, environment)

const rows = result.reports.map((r) => {
  const cliCheck = r.checks.find((c) => c.id === 'cli')
  const authCheck = r.checks.find((c) => c.id === 'auth')
  const protoCheck = r.checks.find((c) => c.id === 'protocol')

  const statusSymbol = !r.installed
    ? '⚪ 未安装'
    : r.ok
    ? '🟢 就绪'
    : '🟡 告警'

  const cliSummary = cliCheck?.status === 'ok'
    ? `🟢 ${r.version ? `v${r.version}` : '正常'}`
    : cliCheck?.status === 'warn'
    ? `🟡 ${cliCheck.message}`
    : `🔴 ${cliCheck?.message ?? '缺失'}`

  const authSummary = authCheck?.status === 'ok'
    ? `🟢 有效`
    : authCheck?.status === 'warn'
    ? `🟡 需配置`
    : authCheck?.status === 'skipped'
    ? `⚪ 跳过`
    : `🔴 失败`

  const protoSummary = protoCheck?.status === 'ok'
    ? `🟢 就绪`
    : protoCheck?.status === 'skipped'
    ? `⚪ 跳过`
    : `🔴 异常`

  return {
    Agent: `${r.name} (${r.agent})`,
    状态: statusSymbol,
    CLI执行: cliSummary,
    鉴权凭证: authSummary,
    协议与MCP: protoSummary
  }
})

console.table(rows)

const installedCount = result.reports.filter((r) => r.installed).length
const readyCount = result.reports.filter((r) => r.ok).length

console.log(`\n体检汇总: 共检测 ${result.reports.length} 个 Agent，已安装 ${installedCount} 个，可立即使用 ${readyCount} 个。`)
if (readyCount === 0) {
  console.log('提示: 暂无完全就绪的 Agent，请根据上方表格提示安装对应 CLI 或完成登录。')
} else {
  console.log('提示: 可直接在 Web 界面选择就绪的 Agent 开启对话或多智能体讨论。')
}
