import type { ChatCatalog } from '@conclave/protocol'
import type { AgentCommand } from '../../agent-command'
import type { AgentAdapter } from '../agent-adapter'
import type { NativeSession, NativeSessionExecutor } from '../../native-session'
import { AcpDriver } from '../acp/acp-driver'
import { antigravityDialect } from './antigravity-dialect'
import { antigravityAccounts, antigravityDefaultHome, antigravityLaunchArgs, markAntigravityKeyringBypass, prepareAntigravitySession } from './antigravity-account'
import { readAntigravityUsage } from './antigravity-usage'
import { antigravityTranscripts } from './antigravity-transcripts'
import { antigravityNativeSessions } from './antigravity-native-sessions'
import { antigravityHomeSignedIn, antigravityInstallation, detectAntigravity, requireAntigravity } from './antigravity-runtime'

const command = (env?: Record<string, string>): AgentCommand => ({
  command: 'agy',
  args: [],
  env: { ...env }
})

async function prepareServerLaunch(geminiHome?: string): Promise<{ command: string; args: string[] }> {
  const server = await requireAntigravity()
  if (geminiHome && geminiHome !== antigravityDefaultHome()) {
    await markAntigravityKeyringBypass(geminiHome)
  }
  return { command: server, args: antigravityLaunchArgs(geminiHome) }
}

// Its models come only with a session, which needs its Google sign-in: signed out, a probe would
// open the sign-in page in the browser with nobody having asked.
async function antigravityCatalog(cwd: string, executor?: NativeSessionExecutor, env?: Record<string, string>): Promise<ChatCatalog | null> {
  if (!executor?.catalog || !executor.register || !executor.cleanup || !await antigravityHomeSignedIn(env?.GEMINI_HOME)) return null
  const native = antigravityNativeSessions()
  const captured: { session: NativeSession | null } = { session: null }
  const resolved = await prepareServerLaunch(env?.GEMINI_HOME)
  try {
    return await executor.catalog(
      new AcpDriver(antigravityDialect, 'catalog', { cwd, extraDirs: [], resume: null }),
      { ...command(env), ...resolved },
      cwd,
      async (id, processSessionId) => {
        const initial = { providerSessionId: id, cwd, home: env?.GEMINI_HOME }
        captured.session = await native.resolve(native.capture?.(initial) ?? initial)
        if (captured.session) await executor.register?.('antigravity', captured.session, processSessionId)
      }
    )
  } finally {
    if (captured.session) await executor.cleanup('antigravity', captured.session)
  }
}

export const antigravity: AgentAdapter = {
  kind: 'antigravity',
  maintenance: {
    native: {
      roots: {
        darwin: ['.local/bin', '/usr/local/bin'],
        linux: ['.local/bin', '/usr/local/bin'],
        win32: ['AppData/Local/agy/bin']
      },
      args: ['update']
    }
  },
  createDriver: (stageId, options) => new AcpDriver(antigravityDialect, stageId, options),
  command: (launch) => command(launch.account?.env),
  permissionModes: Object.keys(antigravityDialect.modes),
  fallbackMode: 'ask',
  session: { preassignedId: false, folderBound: true, nativeFork: 'none' },
  // Its first start unpacks itself, and a first sign-in waits up to five minutes on the browser.
  startTimeoutMs: 360_000,
  mcpApproval: 'conclave',
  accounts: antigravityAccounts,
  signedIn: (home) => antigravityHomeSignedIn(home),
  validStageCatalog: (items) => Boolean(items.findLast((item) => item.kind === 'state')?.permissionModes.includes('plan')),
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
      const geminiHome = launch.account?.env.GEMINI_HOME
      if (launch.resume && launch.providerSessionId) {
        await prepareAntigravitySession(geminiHome, launch.providerSessionId, launch.sessionArtifacts)
      }
      return prepareServerLaunch(geminiHome)
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
