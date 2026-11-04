import type { AgentDescriptor } from './agent-descriptor'

export const grok: AgentDescriptor = {
  translations: { en: {
    modes: {
      ask: { label: 'Default', description: 'Ask for confirmation before making edits or running commands' },
      plan: { label: 'Plan', description: 'Explore code and propose a plan first; execute after approval' },
      auto: { label: 'Auto', description: 'Grok automatically approves safe tool calls; prompts on risky actions' },
      bypass: { label: 'YOLO', description: 'Auto-approve all actions without prompts' }
    },
    environment: {
      role: 'Runs Grok CLI in ACP stdio mode for task execution and chat.',
      install: 'curl -fsSL https://x.ai/cli/install.sh | bash',
      signIn: 'Run grok login in a terminal, or set GROK_DEPLOYMENT_KEY / XAI_API_KEY',
      outdated: { status: 'Requires Grok 1.0.70 or later', hint: ', using a version that supports ACP stdio' }
    },
    usageWhere: 'View in Grok account settings or console'
  } },
  label: 'Grok',
  cli: 'grok',
  setup: 'account',
  modes: {
    ask: { label: 'Default', description: '执行命令或修改前逐项询问确认' },
    plan: { label: 'Plan', description: '先探索代码并制定计划，确认后再修改' },
    auto: { label: 'Auto', description: '由 Grok 自动批准安全操作，关键操作仍会询问' },
    bypass: { label: 'YOLO', description: '直接运行所有工具与操作，不再询问' }
  },
  startModes: ['ask', 'plan', 'auto'],
  defaultStartMode: 'ask',
  discussionMode: 'plan',
  readOnlyMode: 'plan',
  capabilities: { unattended: true, bypass: true, autoMode: true, pathMentions: false, optionsWhileBusy: false, skills: true, userMcp: true, modelProviders: [], accounts: false },
  environment: {
    role: '聊天界面以 `grok agent stdio` 模式运行 Grok CLI 执行任务。',
    install: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    signIn: '在终端运行 grok login 或配置 GROK_DEPLOYMENT_KEY / XAI_API_KEY',
    outdated: { status: '需要 Grok 1.0.70 或更高版本', hint: '，并使用支持 ACP stdio 的版本' }
  },
  usageWhere: '在 Grok 账号或控制台查看'
}
