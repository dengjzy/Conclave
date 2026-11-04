import type { AgentAdapter } from '../agent-adapter'
import { AcpDriver } from '../acp/acp-driver'
import { grokDialect } from './grok-dialect'
import { detectGrok, grokCatalog, grokInstallation, requireGrok } from './grok-cli'

export const grok: AgentAdapter = {
  kind: 'grok',
  maintenance: { native: { roots: { darwin: ['.grok/bin'], linux: ['.grok/bin'], win32: ['.grok/bin'] }, args: ['update'] } },
  createDriver: (stageId, options) => new AcpDriver(grokDialect, stageId, options),
  command: (launch) => ({
    command: 'grok',
    args: [
      ...[...launch.extraProjects, ...(launch.knowledgeBase?.write ? [launch.knowledgeBase.path] : []), ...(launch.skills ? [launch.skills.dir] : [])].flatMap((dir) => ['--add-dir', dir]),
      'agent',
      'stdio'
    ]
  }),
  permissionModes: Object.keys(grokDialect.modes),
  fallbackMode: 'ask',
  session: { preassignedId: false, folderBound: true, nativeFork: 'none' },
  startTimeoutMs: 60_000,
  mcpApproval: 'conclave',
  catalog: grokCatalog,
  detect: detectGrok,
  installation: grokInstallation,
  installWithoutApplication: true,
  launch: {
    mcp: (server) => server,
    prepare: async () => ({ command: await requireGrok() }),
    ready: async () => {}
  },
  turns: { serialized: true, stopAfterCancel: { cancelGraceMs: 3000, termGraceMs: 2000 }, retryByRestart: true, denialAsMessage: true },
  optionsFromState: true,
  discovery: { commands: ['grok'], applications: {} }
}
