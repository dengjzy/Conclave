import { readdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { linkShared, type SharedEntry } from '../../agent-account-home'
import { parseJson } from '../../usage-source'
import type { AccountSupport } from '../agent-adapter'

// The user's own folder, as Codex finds it without Conclave.
export function codexDefaultHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME || path.join(os.homedir(), '.codex')
}

// The sign-in is the account's own; a database's journal goes where its database's link leads.
const OWN = /^(auth\.json|.*\.lock|.*-(wal|shm|journal))$/
// History, made in the user's folder first so a thread opened on any account is found on every other.
const HISTORY: readonly SharedEntry[] = [{ name: 'sessions', create: 'dir' }, { name: 'archived_sessions', create: 'dir' }, { name: 'history.jsonl', create: 'file' }]

// Everything else in the user's folder is linked: config.toml, AGENTS.md, skills, its databases.
async function prepare(home: string): Promise<void> {
  const own = codexDefaultHome()
  const names = await readdir(own).catch(() => [])
  const rest = names.filter((name) => !OWN.test(name) && !HISTORY.some((entry) => entry.name === name)).map((name) => ({ name }))
  await linkShared(home, own, [...HISTORY, ...rest])
}

const Auth = z.object({ tokens: z.object({ id_token: z.string().nullish() }).nullish() })
const Claims = z.object({ email: z.string().nullish() })

// The email its sign-in's id token names. Read only, never verified: it is a label.
export function codexEmail(auth: unknown): string | null {
  const token = Auth.safeParse(auth).data?.tokens?.id_token
  const payload = token?.split('.')[1]
  if (!payload) return null
  const claims = Claims.safeParse(parseJson(Buffer.from(payload, 'base64url').toString('utf8')))
  return claims.data?.email ?? null
}

async function identity(home: string | undefined): Promise<{ email: string | null }> {
  return { email: codexEmail(parseJson(await readFile(path.join(home ?? codexDefaultHome(), 'auth.json'), 'utf8').catch(() => null))) }
}

export const codexAccounts: AccountSupport = {
  env: (home) => ({ CODEX_HOME: home }),
  prepare,
  identity,
  login: ['login'],
  logout: ['logout']
}
