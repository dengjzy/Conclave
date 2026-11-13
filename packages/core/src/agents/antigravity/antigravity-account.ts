import { homedir } from 'node:os'
import path from 'node:path'
import { cp, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { missingSessionFile, storedSessionPath } from '../../native-session-files'
import type { NativeArtifact } from '../../native-session'
import { linkShared } from '../../agent-account-home'
import type { AccountSupport } from '../agent-adapter'
import { acpAccountLogin } from '../acp-account'
import { antigravityCliAuthStateFile, antigravityCliTokenFile, requireAntigravity } from './antigravity-runtime'
import { readAntigravityAccountEmail } from './antigravity-usage'

export const antigravityDefaultHome = () => process.env.GEMINI_HOME || path.join(homedir(), '.gemini')
const legacyCredentialFiles = (home?: string) => ['acp_token.json', 'acp_business_token.json'].map((name) => path.join(home ?? antigravityDefaultHome(), 'antigravity-acp', name))

export function antigravityLaunchArgs(geminiHome?: string): string[] {
  const isolated = Boolean(geminiHome && geminiHome !== antigravityDefaultHome())
  return isolated && geminiHome ? ['acp', '--stdio', '--gemini-dir', geminiHome] : ['acp', '--stdio']
}

// Forces `agy 1.5+` to store and read OAuth tokens in `<home>/antigravity-cli/antigravity-oauth-token`
// rather than the OS keyring (`composite_token_storage.go` honors a marker touched within 1 hour).
export async function markAntigravityKeyringBypass(home: string): Promise<void> {
  const cacheDir = path.join(home, 'antigravity-cli', 'cache')
  await mkdir(cacheDir, { recursive: true, mode: 0o700 })
  await writeFile(path.join(cacheDir, 'antigravity-keyring-unavailable'), '', { mode: 0o600 })
}

const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const preparingBrains = new Map<string, Promise<void>>()

async function privateBrain(home: string, subdir: 'antigravity-acp' | 'antigravity-cli' = 'antigravity-acp'): Promise<void> {
  const brain = path.join(home, subdir, 'brain')
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

async function restoreBrainSession(
  current: string,
  home: string | undefined,
  subdir: 'antigravity-acp' | 'antigravity-cli',
  id: string,
  sources: readonly NativeArtifact[]
): Promise<void> {
  if (home) await privateBrain(current, subdir)
  else await mkdir(path.join(current, subdir, 'brain'), { recursive: true, mode: 0o700 })
  const brain = await realpath(path.join(current, subdir, 'brain'))
  const destination = path.join(brain, id)
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

export async function prepareAntigravitySession(home: string | undefined, id: string, artifacts: readonly NativeArtifact[] = []): Promise<void> {
  if (!SESSION.test(id)) throw new Error('Antigravity 会话标识无效')
  const defaultHome = antigravityDefaultHome()
  const current = home ?? defaultHome
  const legacyAcp = path.join(defaultHome, 'antigravity-acp', 'brain')
  const legacyCli = path.join(defaultHome, 'antigravity-cli', 'brain')
  const sources = [
    ...artifacts,
    { root: legacyAcp, locator: path.join(legacyAcp, id) },
    { root: legacyCli, locator: path.join(legacyCli, id) }
  ]
  await restoreBrainSession(current, home, 'antigravity-cli', id, sources)
}

async function isBrainLink(home: string, subdir: 'antigravity-acp' | 'antigravity-cli'): Promise<boolean> {
  const stat = await lstat(path.join(home, subdir, 'brain')).catch((error: unknown) => {
    if (missingSessionFile(error)) return null
    throw error
  })
  return stat?.isSymbolicLink() ?? false
}

export const antigravityAccounts: AccountSupport = {
  requiresIdleCredentials: true,
  preserveHistoryHome: true,
  needsIdlePreparation: async (home) => (await isBrainLink(home, 'antigravity-acp')) || (await isBrainLink(home, 'antigravity-cli')),
  env: (home) => ({ GEMINI_HOME: home }),
  prepare: async (home) => {
    const own = antigravityDefaultHome()
    await linkShared(home, own, [{ name: 'config' }])
    await linkShared(path.join(home, 'antigravity-cli'), path.join(own, 'antigravity-cli'), [
      { name: 'skills' },
      { name: 'conversations', create: 'dir' },
      { name: 'settings.json' }
    ])
    await privateBrain(home, 'antigravity-cli')
    if (await isBrainLink(home, 'antigravity-acp')) await privateBrain(home, 'antigravity-acp')
    await markAntigravityKeyringBypass(home)
  },
  // Read the signed-in Google account email via the OAuth userinfo endpoint.
  identity: async (home?: string) => {
    const email = await readAntigravityAccountEmail(home).catch(() => null)
    return { email }
  },
  login: [], logout: [],
  loginCommand: async (home) => {
    const server = await requireAntigravity()
    return home && home !== antigravityDefaultHome()
      ? acpAccountLogin(server, ['acp', '--stdio'], [antigravityCliTokenFile(home), ...legacyCredentialFiles(home)], { geminiDir: true })
      : acpAccountLogin(server, ['acp', '--stdio'], [antigravityCliTokenFile(), antigravityCliAuthStateFile(), ...legacyCredentialFiles()], { directDefault: true })
  },
  logoutAccount: async (home) => {
    await Promise.all([
      ...legacyCredentialFiles(home),
      antigravityCliTokenFile(home),
      path.join(home, 'antigravity-cli', 'jetski_state.pbtxt'),
      antigravityCliAuthStateFile(home),
      path.join(home, 'antigravity-cli', 'cache', 'default_project_id.txt')
    ].map((file) => rm(file, { force: true })))
    await rm(path.join(home, 'antigravity-acp', '.conclave-login'), { recursive: true, force: true })
    await rm(path.join(home, 'antigravity-cli', '.conclave-login'), { recursive: true, force: true })
  }
}

export const antigravityAccountToken = (home?: string) => antigravityCliTokenFile(home ?? antigravityDefaultHome())
