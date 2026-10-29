import type { AgentDescriptor } from './agent-descriptor'

// Conclave's modes are OpenCode's primary agents: ask is its Build agent, which allows every tool
// unless the user's config says otherwise, plan its Plan agent; acceptEdits, readOnly and bypass
// are agents Conclave adds at launch (its Plan agent still runs shell commands, so is no readOnly).
export const opencode: AgentDescriptor = {
  translations: { en: {
    modes: {
      ask: { label: 'Build', description: "OpenCode's Build agent, under your OpenCode permission rules (by default it asks nothing)" },
      acceptEdits: { label: 'Automatic', description: 'Edit and run commands in the project; anything outside it is refused, not asked' },
      plan: { label: 'Plan', description: 'Explore code and plan without editing files' },
      readOnly: { label: 'Read only', description: 'Read files without modifying them; asks before running commands' },
      bypass: { label: 'Allow everything', description: 'No approval prompts, whatever your OpenCode rules say' }
    },
    environment: { role: 'Runs with `opencode acp` in chat. Other Agents can be used without it.', install: 'npm install -g @opencode/cli', signIn: 'Run opencode auth login in a terminal to add a model provider', outdated: { status: 'Requires OpenCode 2', hint: ', version 2 or later' } },
    usageWhere: "Check with your model provider"
  } },
  label: 'OpenCode',
  cli: 'opencode',
  setup: 'provider',
  modes: {
    ask: { label: 'Build', description: 'OpenCode 的 Build agent，按你的 OpenCode 权限配置执行（默认什么都不问）' },
    acceptEdits: { label: '自动', description: '在项目里自由修改、运行命令；项目外的操作直接拒绝，不会停下来问' },
    plan: { label: 'Plan', description: '探索代码、制定计划，不修改文件' },
    readOnly: { label: '只读', description: '只能读，不能修改文件；运行命令前先问你' },
    bypass: { label: '全部放行', description: '什么都不问，不管你的 OpenCode 权限配置' }
  },
  startModes: ['ask', 'acceptEdits', 'plan', 'readOnly'],
  defaultStartMode: 'ask',
  discussionMode: 'readOnly',
  readOnlyMode: 'readOnly',
  capabilities: { unattended: true, bypass: true, autoMode: false, pathMentions: false, optionsWhileBusy: false, skills: true, userMcp: true, modelProviders: ['openai-chat', 'openai-responses', 'anthropic'], accounts: false },
  environment: {
    role: '聊天界面以 `opencode acp` 运行它；没装也可以使用其他 Agent。',
    install: 'npm install -g @opencode/cli',
    signIn: '在终端里运行 opencode auth login 添加模型服务商',
    outdated: { status: '需要 OpenCode 2', hint: '，并使用 2.0 以上版本' }
  },
  usageWhere: '在所用模型服务商处查看'
}
