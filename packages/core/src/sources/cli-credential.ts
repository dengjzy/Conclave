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
  token: z.string().optional(),
  job_token: z.string().optional()
}).passthrough()

const GlabConfig = z.object({
  hosts: z.record(z.string(), GlabHostConfig).optional()
}).passthrough()

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

function readGlabConfigHosts(env: NodeJS.ProcessEnv): Map<string, string> {
  const found = new Map<string, string>()
  for (const file of glabConfigCandidates(env)) {
    try {
      const parsed = GlabConfig.safeParse(parseYaml(readFileSync(file, 'utf8')))
      if (!parsed.success || !parsed.data.hosts) continue
      for (const [hostKey, entry] of Object.entries(parsed.data.hosts)) {
        const token = cleanToken(entry.token) ?? cleanToken(entry.job_token)
        const normalized = normalizeHost(hostKey, '')
        if (normalized && token && !found.has(normalized)) {
          found.set(normalized, token)
        }
      }
    } catch {
      // Ignore missing or unreadable config files
    }
  }
  return found
}

export function listGlabCliHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...readGlabConfigHosts(env).keys()]
}

export function readGlabCliToken(host: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const normalized = normalizeHost(host, 'gitlab.com')
  const fromFile = readGlabConfigHosts(env).get(normalized)
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
