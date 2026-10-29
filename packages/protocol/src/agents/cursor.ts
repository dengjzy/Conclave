import type { AgentDescriptor } from './agent-descriptor'
import { CURSOR_PRICES } from './model-prices'

// Conclave's modes carry Cursor's own names: ask is its Agent mode, readOnly its Ask mode.
export const cursor: AgentDescriptor = {
  translations: { en: {
    modes: {
      ask: { label: 'Agent', description: 'Native Cursor Agent mode, using approval choices from its CLI' },
      plan: { label: 'Plan', description: 'Explore code and plan first; execute after approval' },
      readOnly: { label: 'Ask', description: 'Native Cursor Ask mode for questions and code understanding' }
    },
    nativePlanRun: { hint: 'Execute in native Cursor Agent mode' },
    environment: { role: 'Runs Cursor CLI in ACP mode. The Cursor editor alone cannot execute tasks.', install: 'Install the latest Cursor CLI from cursor.com/docs/cli/installation', signIn: 'Run agent login in a terminal', outdated: { status: 'Upgrade required for ACP', hint: ', using a version that supports ACP' } },
    usageWhere: 'View in Cursor usage settings'
  } },
  label: 'Cursor',
  cli: 'agent',
  setup: 'account',
  modes: {
    ask: { label: 'Agent', description: 'Cursor 原生 Agent 模式，审批按 CLI 提供的选项处理' },
    plan: { label: 'Plan', description: '先探索代码并制定计划，确认后执行' },
    readOnly: { label: 'Ask', description: 'Cursor 原生 Ask 模式，用于提问和理解代码' }
  },
  startModes: ['ask', 'plan', 'readOnly'],
  defaultStartMode: 'ask',
  discussionMode: 'readOnly',
  readOnlyMode: 'readOnly',
  capabilities: { unattended: false, bypass: false, autoMode: false, pathMentions: false, optionsWhileBusy: false, skills: true, userMcp: true, modelProviders: [], accounts: false },
  nativePlanRun: { hint: '使用 Cursor 原生 Agent 模式执行' },
  environment: {
    role: '聊天界面以 Cursor CLI 的 ACP 模式运行它；仅安装 Cursor 编辑器还不能执行任务。',
    install: '按照 cursor.com/docs/cli/installation 安装最新 Cursor CLI',
    signIn: '在终端里运行 agent login',
    outdated: { status: '需要升级以支持 ACP', hint: '，并使用支持 ACP 的版本' }
  },
  usageWhere: '在 Cursor 的用量设置里查看',
  resetTracker: 'cursor',
  windowsPathDirs: ['cursor-agent'],
  quickModels: [/flash/, /haiku/, /nano/, /mini/],
  prices: CURSOR_PRICES
}
