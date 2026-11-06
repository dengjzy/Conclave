import { homedir } from 'node:os'
import path from 'node:path'
import { cp, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, unlink } from 'node:fs/promises'
import { missingSessionFile, storedSessionPath } from '../../native-session-files'
import type { NativeArtifact } from '../../native-session'
import { linkShared } from '../../agent-account-home'
import type { AccountSupport } from '../agent-adapter'
import { acpAccountLogin } from '../acp-account'
import { antigravityTokenFile, requireAntigravity } from './antigravity-runtime'
import { readAntigravityUserEmail } from './antigravity-usage'

export const antigravityDefaultHome = () => process.env.GEMINI_HOME || path.join(homedir(), '.gemini')
const credentialFiles = (home?: string) => ['acp_token.json', 'acp_business_token.json'].map((name) => path.join(home ?? antigravityDefaultHome(), 'antigravity-acp', name))
export const antigravityArgs = (): string[] => process.platform === 'linux' ? ['--uid='] : []
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const preparingBrains = new Map<string, Promise<void>>()

async function privateBrain(home: string): Promise<void> {
  const brain = path.join(home, 'antigravity-acp', 'brain')
  const known = preparingBrains.get(brain)
  if (known) return known
  const prepare = (async () => {
    const found = await lstat(brain).catch((error: unknown) => { if (missingSessionFile(error)) return null; throw error })
    if (!found?.isSymbolicLink()) { await mkdir(brain, { recursive: true, mode: 0o700 }); return }
    const replacement = await mkdtemp(path.join(path.dirname(brain), '.brain-'))
    const previous = `${replacement}.previous`
    try {
      await rename(brain, previous)
      try { await rename(replacement, brain) } catch (error) { await rename(previous, brain); throw error }
      // Remove only the link; its shared historical artifacts stay at their original paths.
      await unlink(previous)
    } finally { await rm(replacement, { recursive: true, force: true }) }
  })().finally(() => preparingBrains.delete(brain))
  preparingBrains.set(brain, prepare)
  return prepare
}

async function copyArtifacts(source: string, destination: string): Promise<void> {
  const present = await lstat(destination).catch((error: unknown) => { if (missingSessionFile(error)) return null; throw error })
  if (present?.isSymbolicLink()) throw new Error('Antigravity 产物目录不能是链接')
  await mkdir(destination, { recursive: true, mode: 0o700 })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), into = path.join(destination, entry.name)
    // Artifact links must not turn files outside their registered scope into readable copies.
    if (entry.isSymbolicLink()) continue
    const existing = await lstat(into).catch((error: unknown) => { if (missingSessionFile(error)) return null; throw error })
    if (existing && (!entry.isDirectory() || !existing.isDirectory() || existing.isSymbolicLink())) continue
    if (entry.isDirectory()) await copyArtifacts(from, into)
    else if (entry.isFile()) await cp(from, into, { force: false, errorOnExist: false })
  }
}

export async function prepareAntigravitySession(home: string | undefined, id: string, artifacts: readonly NativeArtifact[] = []): Promise<void> {
  if (!SESSION.test(id)) throw new Error('Antigravity 会话标识无效')
  const current = home ?? antigravityDefaultHome()
  if (home) await privateBrain(current)
  else await mkdir(path.join(current, 'antigravity-acp', 'brain'), { recursive: true, mode: 0o700 })
  const brain = await realpath(path.join(current, 'antigravity-acp', 'brain'))
  const destination = path.join(brain, id)
  const legacy = path.join(antigravityDefaultHome(), 'antigravity-acp', 'brain')
  const sources = [...artifacts, { root: legacy, locator: path.join(legacy, id) }]
  const seen = new Set<string>()
  const present = await lstat(destination).catch((error: unknown) => { if (missingSessionFile(error)) return null; throw error })
  if (present?.isSymbolicLink()) throw new Error('Antigravity 产物目录不能是链接')
  const temporary = present ? null : await mkdtemp(path.join(brain, `.restore-${id}-`))
  try {
    for (const artifact of sources) {
      if (artifact.locator !== path.join(artifact.root, id)) throw new Error('Antigravity 产物定位无效')
      const scope = await realpath(artifact.root).catch((error: unknown) => { if (missingSessionFile(error)) return artifact.root; throw error })
      const source = await storedSessionPath(scope, path.join(scope, id))
      if (!source || source === destination || seen.has(source)) continue
      seen.add(source)
      await copyArtifacts(source, temporary ?? destination)
    }
    if (temporary && seen.size) await rename(temporary, destination)
  } finally { if (temporary) await rm(temporary, { recursive: true, force: true }) }
}

export const antigravityAccounts: AccountSupport = {
  requiresIdleCredentials: true,
  preserveHistoryHome: true,
  needsIdlePreparation: async (home) => (await lstat(path.join(home, 'antigravity-acp', 'brain')).catch((error: unknown) => { if (missingSessionFile(error)) return null; throw error }))?.isSymbolicLink() ?? false,
  env: (home) => ({ GEMINI_HOME: home, AGY_ACP_FORCE_FILE_STORAGE: '1' }),
  prepare: async (home) => {
    const own = antigravityDefaultHome()
    await linkShared(home, own, [{ name: 'config' }])
    await linkShared(path.join(home, 'antigravity-cli'), path.join(own, 'antigravity-cli'), [{ name: 'skills' }])
    await linkShared(path.join(home, 'antigravity-acp'), path.join(own, 'antigravity-acp'), [
      { name: 'conversations', create: 'dir' },
      { name: 'settings.json' }, { name: 'trusted_workspaces.json' }
    ])
    await privateBrain(home)
  },
  // Read the signed-in Google account email via the OAuth userinfo endpoint using the refresh token.
  identity: async (home?: string) => {
    const email = await readAntigravityUserEmail(antigravityAccountToken(home)).catch(() => null)
    return { email }
  },
  login: [], logout: [],
  loginCommand: async (home) => {
    const login = acpAccountLogin(await requireAntigravity(), antigravityArgs(), credentialFiles(home))
    return { ...login, env: { ...login.env, AGY_ACP_FORCE_FILE_STORAGE: '1' } }
  },
  logoutAccount: async (home) => {
    await Promise.all(credentialFiles(home).map((file) => rm(file, { force: true })))
    await rm(path.join(home, 'antigravity-acp', '.conclave-login'), { recursive: true, force: true })
  }
}

export const antigravityAccountToken = (home?: string) => antigravityTokenFile(home ?? antigravityDefaultHome())
