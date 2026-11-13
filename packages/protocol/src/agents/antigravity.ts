import type { AgentDescriptor } from './agent-descriptor'

// Google's Antigravity ACP server, the one its Zed and JetBrains extensions run: its three session
// modes are Conclave's ask, acceptEdits and bypass. Group discussions run it in ask mode.
export const antigravity: AgentDescriptor = {
  translations: { en: {
    modes: {
      ask: { label: 'Default', description: "Antigravity's default review: asks before editing files and running commands" },
      acceptEdits: { label: 'Accept Edits', description: 'Edits files without asking; still asks before running commands' },
      plan: { label: 'Plan', description: 'Plans carefully before executing a task' },
      bypass: { label: 'Auto', description: 'Approves edits and safe commands automatically' }
    },
    environment: {
      role: 'Runs the official `agy acp --stdio` CLI directly (following `agy update` automatically).',
      install: 'Install the `agy` CLI (`>= 1.5.0`) from Settings → Local agents',
      signIn: 'Reuses your local `agy` login or opens Google sign-in in the browser on first chat',
      missing: { status: 'Not installed', hint: 'Install the official `agy` CLI (`>= 1.5.0`) here or run its installer manually.' }
    },
    usageWhere: 'Send /usage in an Antigravity chat'
  } },
  label: 'Antigravity',
  cli: 'agy',
  setup: 'first-use',
  modes: {
    ask: { label: 'Default', description: 'Antigravity 默认的审批流程：修改文件和运行命令前先问你' },
    acceptEdits: { label: 'Accept Edits', description: '直接修改文件，运行命令前仍先问你' },
    plan: { label: 'Plan', description: '先仔细规划方案，确认后再执行' },
    bypass: { label: 'Auto', description: '自动批准文件修改与常规命令' }
  },
  startModes: ['ask', 'acceptEdits', 'plan', 'bypass'],
  defaultStartMode: 'ask',
  discussionMode: 'ask',
  readOnlyMode: 'ask',
  // Signed in with a personal account, its file tools refuse anything outside its cwd.
  primaryOnlyFiles: true,
  capabilities: { unattended: false, bypass: true, autoMode: false, pathMentions: false, optionsWhileBusy: false, skills: false, userMcp: true, modelProviders: [], accounts: true },
  environment: {
    role: '直接运行官方 `agy acp --stdio` CLI（跟随 `agy update` 自动获得最新模型与能力）。',
    install: '在 设置 → 外部智能体 安装 `agy` CLI（`>= 1.5.0`）',
    signIn: '自动复用本机 `agy` 登录态，或首次对话时在浏览器打开 Google 登录页',
    missing: { status: '未安装', hint: '请在此安装官方 `agy` CLI（`>= 1.5.0`，可通过 `agy update` 自动跟进最新能力）。' }
  },
  usageWhere: '在 Antigravity 会话里发送 /usage 查看'
}
