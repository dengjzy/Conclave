import type { AgentDescriptor } from './agent-descriptor'

// omp's ACP session has only Default and Plan. Default edits files without asking and sends
// commands through ACP's permission gate, which is Conclave's acceptEdits. Plan is not offered:
// omp approves its own plan and leaves plan mode in the same turn, so it cannot keep a stage
// read-only. Without a read-only mode, neither discussions nor squad read-only work include it.
export const omp: AgentDescriptor = {
  translations: { en: {
    modes: {
      acceptEdits: { label: 'Default', description: 'Edit files directly; asks before running commands' }
    },
    environment: {
      role: 'Runs with `omp acp` in chat. Other Agents can be used without it.',
      install: 'curl -fsSL https://omp.sh/install | sh',
      signIn: 'Run omp in a terminal and use /login, or set your model provider API key',
      outdated: { status: 'Requires omp 18.18.8', hint: ', version 18.18.8 or later' }
    },
    usageWhere: 'Check with your model provider; `omp usage` reads supported limits'
  } },
  label: 'omp',
  cli: 'omp',
  setup: 'account',
  modes: {
    acceptEdits: { label: '默认', description: '直接改文件；运行命令前先问你' }
  },
  startModes: ['acceptEdits'],
  defaultStartMode: 'acceptEdits',
  discussionMode: 'acceptEdits',
  readOnlyMode: 'acceptEdits',
  capabilities: { readOnly: false, unattended: false, bypass: false, autoMode: false, pathMentions: true, optionsWhileBusy: false, skills: false, userMcp: true, modelProviders: [], accounts: false },
  environment: {
    role: '聊天界面以 `omp acp` 运行它；没装也可以使用其他 Agent。',
    install: 'curl -fsSL https://omp.sh/install | sh',
    signIn: '在终端运行 omp，用 /login 登录模型服务商，或设置服务商的 API key',
    outdated: { status: '需要 omp 18.18.8', hint: '，并使用 18.18.8 以上版本' }
  },
  usageWhere: '在所用模型服务商处查看；`omp usage` 可读取支持的额度'
}
