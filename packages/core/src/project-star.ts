import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { PROJECT_GITHUB_REPOSITORY, type ProjectStarIdentity, type ProjectStarResult, type ProjectStarStatus } from '@conclave/protocol'
import { planLaunch } from '@conclave/protocol/node'
import type { SourceService } from './source-service'

const execFileAsync = promisify(execFile)
const API = 'https://api.github.com'
const ENDPOINT = `/user/starred/${PROJECT_GITHUB_REPOSITORY}`
const TIMEOUT_MS = 15_000
const Viewer = z.object({ login: z.string().min(1).max(100) })
// The official GitHub source plugin stores a token credential in this form.
const TokenCredential = z.object({ kind: z.literal('token'), payload: z.object({ token: z.string().min(1).max(16_384).regex(/^[^\s\x00-\x1f\x7f]+$/) }) })

type Credential = { source: ProjectStarIdentity['source']; instance: string | null; token: string }
type Dependencies = { ghToken?: (signal: AbortSignal) => Promise<string | null>; fetch?: typeof fetch }

async function ghToken(signal: AbortSignal): Promise<string | null> {
  try {
    const env = { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' }
    const launch = planLaunch('gh', ['auth', 'token', '--hostname', 'github.com'], process.cwd(), env)
    const { stdout } = await execFileAsync(launch.file, launch.args, {
      env: launch.env, encoding: 'utf8', windowsHide: true, timeout: 5_000, maxBuffer: 16 * 1024, signal
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

// Authentication stays in core, and every write is pinned to the last detected account.
export class ProjectStar {
  private checking: Promise<ProjectStarStatus> | null = null
  private readonly readGhToken: NonNullable<Dependencies['ghToken']>
  private readonly fetch: typeof fetch

  constructor(private readonly sources: Pick<SourceService, 'credentialsFor'>, dependencies: Dependencies = {}) {
    this.readGhToken = dependencies.ghToken ?? ghToken
    this.fetch = dependencies.fetch ?? fetch
  }

  check(): Promise<ProjectStarStatus> {
    this.checking ??= this.checkInner().catch((): ProjectStarStatus => ({ state: 'unavailable' })).finally(() => { this.checking = null })
    return this.checking
  }

  async star(identity: ProjectStarIdentity): Promise<ProjectStarResult> {
    const signal = AbortSignal.timeout(TIMEOUT_MS)
    try {
      const credential = identity.source === 'gh'
        ? await this.cliCredential(signal)
        : this.pluginCredentials().find((entry) => entry.instance === identity.instance)
      if (!credential) return { ok: false, problem: 'unavailable' }
      const account = await this.viewer(credential, signal)
      if (!account) return { ok: false, problem: 'unavailable' }
      if (account !== identity.account) return { ok: false, problem: 'account-changed' }
      const response = await this.request(credential, ENDPOINT, 'PUT', signal)
      await response.body?.cancel()
      if (response.status === 204) return { ok: true }
      return { ok: false, problem: response.status === 403 ? 'permission-denied' : response.status === 401 ? 'unavailable' : 'request-failed' }
    } catch {
      return { ok: false, problem: 'request-failed' }
    }
  }

  private async checkInner(): Promise<ProjectStarStatus> {
    const signal = AbortSignal.timeout(TIMEOUT_MS)
    const cli = await this.cliCredential(signal)
    if (cli) {
      const status = await this.inspect(cli, signal)
      if (status) return status
    }
    for (const credential of this.pluginCredentials()) {
      if (signal.aborted) break
      const status = await this.inspect(credential, signal)
      if (status) return status
    }
    return { state: 'unavailable' }
  }

  private async cliCredential(signal: AbortSignal): Promise<Credential | null> {
    const token = await this.readGhToken(signal).catch(() => null)
    return token ? { source: 'gh', instance: null, token } : null
  }

  private pluginCredentials(): Credential[] {
    return this.sources.credentialsFor('github').flatMap(({ instance, credential }) => {
      const parsed = TokenCredential.safeParse(credential)
      return parsed.success ? [{ source: 'github-plugin' as const, instance, token: parsed.data.payload.token }] : []
    })
  }

  private async inspect(credential: Credential, signal: AbortSignal): Promise<ProjectStarStatus | null> {
    try {
      const account = await this.viewer(credential, signal)
      if (!account) return null
      const response = await this.request(credential, ENDPOINT, 'GET', signal)
      await response.body?.cancel()
      if (response.status !== 204 && response.status !== 404) return null
      return { state: 'ready', identity: { source: credential.source, instance: credential.instance, account }, starred: response.status === 204 }
    } catch {
      return null
    }
  }

  private async viewer(credential: Credential, signal: AbortSignal): Promise<string | null> {
    const response = await this.request(credential, '/user', 'GET', signal)
    if (!response.ok) { await response.body?.cancel(); return null }
    const parsed = Viewer.safeParse(await response.json())
    return parsed.success ? parsed.data.login : null
  }

  private request(credential: Credential, path: string, method: 'GET' | 'PUT', signal: AbortSignal): Promise<Response> {
    return this.fetch(`${API}${path}`, {
      method, signal, redirect: 'error',
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${credential.token}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'Conclave' }
    })
  }
}
