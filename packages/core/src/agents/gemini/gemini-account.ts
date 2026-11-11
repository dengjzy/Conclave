import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { linkShared } from '../../agent-account-home'
import { parseJson } from '../../usage-source'
import type { AccountSupport } from '../agent-adapter'
import { acpAccountLogin } from '../acp-account'
import { geminiHome, requireGemini } from './gemini-cli'

const homeOf = (home?: string) => home ? geminiHome({ GEMINI_CLI_HOME: home }) : geminiHome()
const credentialFiles = (home?: string) => ['oauth_creds.json', 'google_accounts.json'].map((name) => path.join(homeOf(home), name))

export const geminiAccounts: AccountSupport = {
  env: (home) => ({
    GEMINI_CLI_HOME: home, GEMINI_API_KEY: '', GOOGLE_API_KEY: '',
    GOOGLE_APPLICATION_CREDENTIALS: '', GOOGLE_GENAI_USE_VERTEXAI: '',
    GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'false', GEMINI_FORCE_FILE_STORAGE: 'true'
  }),
  prepare: async (home) => {
    const directory = homeOf(home)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await linkShared(directory, geminiHome(), [{ name: 'GEMINI.md' }, { name: 'skills' }])
    const settings = z.record(z.string(), z.unknown()).safeParse(parseJson(await readFile(path.join(geminiHome(), 'settings.json'), 'utf8').catch(() => null))).data ?? {}
    const security = z.record(z.string(), z.unknown()).safeParse(settings.security).data ?? {}
    await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ ...settings, security: { ...security, auth: { selectedType: 'oauth-personal' } } }), { flag: 'wx', mode: 0o600 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
  },
  identity: async (home) => {
    const account = z.object({ active: z.string().nullable().optional() }).safeParse(parseJson(await readFile(credentialFiles(home)[1]!, 'utf8').catch(() => null))).data
    return { email: account?.active ?? null }
  },
  login: [], logout: [],
  loginCommand: async (home) => acpAccountLogin(await requireGemini(), ['--acp', '--skip-trust'], credentialFiles(home)),
  logoutAccount: async (home) => { await Promise.all(credentialFiles(home).map((file) => rm(file, { force: true }))) }
}
