import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { planLaunch } from '@conclave/protocol/node'

const CACHE_TTL_MS = 60_000
const TOKEN_PATTERN = /^[^\s\x00-\x1f\x7f]+$/

type CachedToken = { token: string | null; expiresAt: number }
const cache = new Map<string, CachedToken>()

function readCached(key: string, compute: () => string | null): string | null {
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && hit.expiresAt > now) return hit.token
  const token = compute()
  cache.set(key, { token, expiresAt: now + CACHE_TTL_MS })
  return token
}

function cleanToken(raw: string | undefined | null): string | null {
  const trimmed = raw?.trim() ?? ''
  return trimmed && TOKEN_PATTERN.test(trimmed) ? trimmed : null
}

export function normalizeHost(raw: string | undefined, fallback: string): string {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return fallback
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      return new URL(trimmed).host.toLowerCase()
    }
  } catch {
    // Fall through to plain hostname cleanup
  }
  return trimmed.replace(/^\/+|\/+$/g, '').toLowerCase() || fallback
}

export function readGhCliToken(host: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const normalized = normalizeHost(host, 'github.com')
  return readCached(`gh:${normalized}`, () => {
    try {
      const safeEnv = { ...env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' }
      const launch = planLaunch('gh', ['auth', 'token', '--hostname', normalized], os.homedir(), safeEnv)
      const stdout = execFileSync(launch.file, launch.args, {
        env: launch.env,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 3_000,
        maxBuffer: 16 * 1024,
        stdio: ['ignore', 'pipe', 'ignore']
      })
      return cleanToken(stdout)
    } catch {
      return null
    }
  })
}

const GlabHostConfig = z.object({
  token: z.string().nullish(),
  job_token: z.string().nullish(),
  user: z.string().nullish(),
  use_keyring: z.union([z.boolean(), z.string()]).nullish(),
  api_protocol: z.string().nullish(),
  git_protocol: z.string().nullish(),
  api_host: z.string().nullish(),
  skip_tls_verify: z.union([z.boolean(), z.string()]).nullish()
}).passthrough()

const GlabConfig = z.object({
  hosts: z.record(z.string(), GlabHostConfig.nullish()).nullish()
}).passthrough()

export type GlabEndpoint = {
  protocol: 'http' | 'https'
  apiHost: string
  skipTlsVerify: boolean
}

type GlabHostEntry = {
  token: string | null
  authenticated: boolean
  endpoint: GlabEndpoint
}

function glabConfigCandidates(env: NodeJS.ProcessEnv): string[] {
  const home = os.homedir()
  const dirs: string[] = []
  if (env.GLAB_CONFIG_DIR) dirs.push(env.GLAB_CONFIG_DIR)
  if (env.XDG_CONFIG_HOME) dirs.push(path.join(env.XDG_CONFIG_HOME, 'glab-cli'))
  dirs.push(path.join(home, '.config', 'glab-cli'))
  if (process.platform === 'darwin') {
    dirs.push(path.join(home, 'Library', 'Application Support', 'glab-cli'))
  }
  if (process.platform === 'win32' && env.APPDATA) {
    dirs.push(path.join(env.APPDATA, 'glab-cli'))
  }
  return dirs.map((dir) => path.join(dir, 'config.yml'))
}

function readGlabConfigEntries(env: NodeJS.ProcessEnv): Map<string, GlabHostEntry> {
  const found = new Map<string, GlabHostEntry>()
  for (const file of glabConfigCandidates(env)) {
    try {
      const parsed = GlabConfig.safeParse(parseYaml(readFileSync(file, 'utf8')))
      if (!parsed.success || !parsed.data.hosts) continue
      for (const [hostKey, entry] of Object.entries(parsed.data.hosts)) {
        if (!entry) continue
        const normalized = normalizeHost(hostKey, '')
        if (!normalized) continue
        const apiHost = normalizeHost(entry.api_host ?? undefined, normalized)
        const rawProtocol = (entry.api_protocol ?? entry.git_protocol ?? '').trim().toLowerCase()
        const protocol: 'http' | 'https' = rawProtocol === 'http' ? 'http' : 'https'
        const skipTlsVerify =
          entry.skip_tls_verify === true ||
          String(entry.skip_tls_verify ?? '').trim().toLowerCase() === 'true'
        const useKeyring =
          entry.use_keyring === true ||
          String(entry.use_keyring ?? '').trim().toLowerCase() === 'true'
        const token = cleanToken(entry.token) ?? cleanToken(entry.job_token)
        const authenticated = Boolean(token || useKeyring || entry.user?.trim())
        const record: GlabHostEntry = {
          token,
          authenticated,
          endpoint: { protocol, apiHost, skipTlsVerify }
        }
        const existing = found.get(normalized)
        if (!existing || (!existing.authenticated && authenticated) || (!existing.token && token)) {
          found.set(normalized, record)
        }
        if (apiHost !== normalized && !found.has(apiHost)) {
          found.set(apiHost, record)
        }
      }
    } catch {
      // Ignore missing or unreadable config files
    }
  }
  return found
}

export function listGlabCliHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const hosts: string[] = []
  for (const [host, entry] of readGlabConfigEntries(env)) {
    if (entry.authenticated) hosts.push(host)
  }
  return hosts
}

export function readGlabCliEndpoint(host: string, env: NodeJS.ProcessEnv = process.env): GlabEndpoint | null {
  const normalized = normalizeHost(host, 'gitlab.com')
  const fromFile = readGlabConfigEntries(env).get(normalized)?.endpoint
  if (fromFile) return fromFile
  const cliProto = readCached(`glab-proto:${normalized}`, () => {
    try {
      const safeEnv = { ...env, GIT_TERMINAL_PROMPT: '0', NO_PROMPT: '1' }
      const launch = planLaunch('glab', ['config', 'get', 'api_protocol', '--host', normalized], os.homedir(), safeEnv)
      const stdout = execFileSync(launch.file, launch.args, {
        env: launch.env,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 3_000,
        maxBuffer: 16 * 1024,
        stdio: ['ignore', 'pipe', 'ignore']
      })
      const proto = stdout.trim().toLowerCase()
      return proto === 'http' || proto === 'https' ? proto : null
    } catch {
      return null
    }
  })
  if (cliProto === 'http' || cliProto === 'https') {
    return { protocol: cliProto, apiHost: normalized, skipTlsVerify: false }
  }
  return null
}

export function readGlabCliToken(host: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const normalized = normalizeHost(host, 'gitlab.com')
  const fromFile = readGlabConfigEntries(env).get(normalized)?.token
  if (fromFile) return fromFile
  return readCached(`glab:${normalized}`, () => {
    try {
      const safeEnv = { ...env, GIT_TERMINAL_PROMPT: '0', NO_PROMPT: '1' }
      const launch = planLaunch('glab', ['config', 'get', 'token', '--host', normalized], os.homedir(), safeEnv)
      const stdout = execFileSync(launch.file, launch.args, {
        env: launch.env,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 3_000,
        maxBuffer: 16 * 1024,
        stdio: ['ignore', 'pipe', 'ignore']
      })
      return cleanToken(stdout)
    } catch {
      return null
    }
  })
}
