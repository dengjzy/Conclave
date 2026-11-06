import type { ChatCatalog } from '@conclave/protocol'
import type { AgentAdapter } from '../agent-adapter'
import type { NativeSession, NativeSessionExecutor } from '../../native-session'
import { AcpDriver } from '../acp/acp-driver'
import { antigravityDialect } from './antigravity-dialect'
import { antigravityAccounts, antigravityAccountToken, antigravityArgs, prepareAntigravitySession } from './antigravity-account'
import { readAntigravityUsage } from './antigravity-usage'
import { antigravityTranscripts } from './antigravity-transcripts'
import { antigravityNativeSessions } from './antigravity-native-sessions'
import { antigravityInstallation, antigravityServer, antigravitySignedIn, detectAntigravity, requireAntigravity } from './antigravity-runtime'

// Its sign-in goes to a file Conclave can read for usage (antigravity-usage.ts), not the keychain.
const command = (env?: Record<string, string>) => ({ command: antigravityServer() ?? 'agy_acp_server', args: antigravityArgs(), env: { PYTHONUNBUFFERED: '1', AGY_ACP_FORCE_FILE_STORAGE: '1', ...env } })

// Its models come only with a session, which needs its Google sign-in: signed out, a probe would
// open the sign-in page in the browser with nobody having asked.
async function antigravityCatalog(cwd: string, executor?: NativeSessionExecutor, env?: Record<string, string>): Promise<ChatCatalog | null> {
  if (!executor?.catalog || !executor.register || !executor.cleanup || !await antigravitySignedIn(antigravityAccountToken(env?.GEMINI_HOME))) return null
  const native = antigravityNativeSessions()
  const captured: { session: NativeSession | null } = { session: null }
  try {
    return await executor.catalog(new AcpDriver(antigravityDialect, 'catalog', { cwd, extraDirs: [], resume: null }), { ...command(env), command: await requireAntigravity() }, cwd, async (id, processSessionId) => {
      const initial = { providerSessionId: id, cwd, home: env?.GEMINI_HOME }
      captured.session = await native.resolve(native.capture?.(initial) ?? initial)
      if (captured.session) await executor.register?.('antigravity', captured.session, processSessionId)
    })
  } finally {
    if (captured.session) await executor.cleanup('antigravity', captured.session)
  }
}

export const antigravity: AgentAdapter = {
  kind: 'antigravity',
  createDriver: (stageId, options) => new AcpDriver(antigravityDialect, stageId, options),
  // Conclave's MCP servers and the user's go in session/new; extra projects ride in the first
  // prompt's note, as its session takes no additional directories.
  command: (launch) => command(launch.account?.env),
  permissionModes: Object.keys(antigravityDialect.modes),
  fallbackMode: 'ask',
  session: { preassignedId: false, folderBound: true, nativeFork: 'none' },
  // Its first start unpacks itself, and a first sign-in waits up to five minutes on the browser.
  startTimeoutMs: 360_000,
  mcpApproval: 'conclave',
  accounts: antigravityAccounts,
  signedIn: (home) => antigravitySignedIn(antigravityAccountToken(home)),
  catalog: antigravityCatalog,
  detect: detectAntigravity,
  usage: readAntigravityUsage,
  transcripts: antigravityTranscripts(),
  nativeSessions: antigravityNativeSessions(),
  installation: antigravityInstallation,
  installWithoutApplication: true,
  launch: {
    mcp: (server) => server,
    prepare: async (_stage, _mcp, launch) => {
      if (launch.resume && launch.providerSessionId) await prepareAntigravitySession(launch.account?.env.GEMINI_HOME, launch.providerSessionId, launch.sessionArtifacts)
      return { command: await requireAntigravity() }
    },
    ready: async () => {}
  },
  turns: {
    serialized: true, stopAfterCancel: { cancelGraceMs: 3000, termGraceMs: 2000 },
    firstFrameNoticeMs: 30_000, firstFrameTimeoutMs: 360_000,
    retryByRestart: true, denialAsMessage: true
  },
  optionsFromState: true,
  discovery: { commands: ['agy'], applications: { darwin: ['Antigravity.app'] } }
}
