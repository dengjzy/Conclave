import type { AgentDescriptor } from './agent-descriptor'

export const dsh: AgentDescriptor = {
  label: 'DeepSeek Harness',
  cli: 'dsh',
  setup: 'provider',
  modes: {
    ask: { label: '默认', description: '在项目沙箱内编辑和运行命令；扩大权限前先问你' },
    acceptEdits: { label: '自动', description: '在项目里编辑和运行命令；越界操作直接拒绝，不会停下来问' },
    plan: { label: '规划', description: '只读探索并提交计划，你批准后才执行' },
    readOnly: { label: '只读', description: '只读和搜索文件，拒绝修改及有副作用的工具' },
    bypass: { label: '全部放行', description: '不限制文件访问，也不请求工具审批' }
  },
  startModes: ['ask', 'acceptEdits', 'plan', 'readOnly'],
  defaultStartMode: 'ask',
  discussionMode: 'readOnly',
  readOnlyMode: 'readOnly',
  agentPresets: {
    defaultPreset: 'standard',
    options: [
      { id: 'standard', label: '标准模式', description: '功能完整的全能编码 Agent，支持文件编辑、Shell、检索、Skills、目标规划等' },
      { id: 'cordis', label: '创造模式', description: '用于创建自定义 Agent preset，具备标准模式全部能力，并提供运行时检查与插件实验' },
      { id: 'ptc', label: 'PTC 模式', description: '通过 TypeScript 脚本编排多步工具调用' },
      { id: 'minimal', label: '极简模式', description: '仅提供持久化 Shell 的单工具极简模式' }
    ]
  },
  capabilities: { unattended: true, bypass: true, autoMode: false, pathMentions: false, optionsWhileBusy: false, skills: true, userMcp: true, modelProviders: ['openai-chat', 'openai-responses', 'anthropic'], accounts: false },
  environment: {
    role: '通过 Conclave 专用 profile 运行；首次使用时准备随应用提供的运行时插件。',
    install: 'npm install -g @deepseek-ai/dsh@0.2.2-rc.1',
    signIn: '在 DSH 中配置模型服务商，或在 Conclave 的服务商设置中添加 API Key',
    outdated: { status: '需要 DSH 0.2.2-rc.1', hint: '，请使用 0.2.2-rc.1 以上版本' }
  },
  usageWhere: 'DeepSeek 官方余额可在底部状态栏查看；其他服务商请到对应平台查看',
  translations: { en: {
    modes: {
      ask: { label: 'Default', description: 'Edit and run commands in project sandboxes; ask before widening permissions' },
      acceptEdits: { label: 'Automatic', description: 'Edit and run commands in projects; refuse operations outside them without prompting' },
      plan: { label: 'Plan', description: 'Explore read-only and submit a plan; execute after approval' },
      readOnly: { label: 'Read only', description: 'Read and search files; refuse edits and tools with side effects' },
      bypass: { label: 'Allow everything', description: 'Unrestricted file access without tool approval prompts' }
    },
    agentPresets: {
      options: [
        { id: 'standard', label: 'Standard', description: 'Full coding agent with editing, shell, search, skills, and planning' },
        { id: 'cordis', label: 'Creator', description: 'For authoring custom agent presets with runtime inspection and plugin experimentation' },
        { id: 'ptc', label: 'PTC', description: 'Orchestrates multi-step tool calls via TypeScript scripts' },
        { id: 'minimal', label: 'Minimal', description: 'Single-tool persistent shell agent' }
      ]
    },
    environment: {
      role: 'Runs in an Conclave profile; prepares the bundled runtime plugin on first use.',
      install: 'npm install -g @deepseek-ai/dsh@0.2.2-rc.1',
      signIn: 'Configure a model provider in DSH, or add an API key in Conclave provider settings',
      outdated: { status: 'Requires DSH 0.2.2-rc.1', hint: '; use 0.2.2-rc.1 or later' }
    },
    usageWhere: 'DeepSeek API balances appear in the status bar; check other providers on their own platforms'
  } }
}
