import type { AgentAdapter } from '../agent-adapter'
import { AcpDriver } from '../acp/acp-driver'
import { ompDialect } from './omp-dialect'
import { detectOmp, ompCatalog, ompInstallation, requireOmp } from './omp-cli'
import { ompNativeSessions } from './omp-native-sessions'

export const omp: AgentAdapter = {
  kind: 'omp',
  maintenance: { native: { roots: { darwin: ['.local/bin', '.omp/bin'], linux: ['.local/bin', '.omp/bin'], win32: ['AppData/Local/omp'] }, args: ['update'], latestUrl: 'https://api.github.com/repos/can1357/oh-my-pi/releases/latest', tagPrefix: 'v' } },
  createDriver: (stageId, options) => new AcpDriver(ompDialect, stageId, options),
  // ACP's client gate covers commands and destructive edits, but ordinary writes follow omp's own
  // approval mode. Pin that to write so the process behaves as acceptEdits whatever the user's
  // global omp config says; a yolo config would otherwise skip edits Conclave expects to approve.
  command: (launch) => ({
    command: 'omp',
    args: ['acp', '--approval-mode', 'write', ...[...launch.extraProjects, ...(launch.knowledgeBase?.write ? [launch.knowledgeBase.path] : [])].flatMap((dir) => ['--add-dir', dir])]
  }),
  permissionModes: Object.keys(ompDialect.modes),
  fallbackMode: 'acceptEdits',
  // Its sessions are stored under the folder they ran in; a fork copies the whole session, which
  // Conclave does not need, and a handoff gives a new stage its own permissions and tools.
  session: { preassignedId: false, folderBound: true, nativeFork: 'none' },
  nativeSessions: ompNativeSessions(),
  startTimeoutMs: 60_000,
  mcpApproval: 'conclave',
  catalog: ompCatalog,
  detect: detectOmp,
  installation: ompInstallation,
  installWithoutApplication: true,
  launch: {
    mcp: (server) => server,
    prepare: async () => ({ command: await requireOmp() }),
    ready: async () => {}
  },
  turns: { serialized: true, stopAfterCancel: { cancelGraceMs: 3000, termGraceMs: 2000 }, retryByRestart: true, denialAsMessage: true },
  optionsFromState: true,
  discovery: { commands: ['omp'], applications: {} }
}
