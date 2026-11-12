import { Agent, fetch as undiciFetch } from 'undici'
import { z } from 'zod'
import type { SettingField, SourceIssue } from '@conclave/protocol'
import { SourceError } from '../source-error'
import type { LoginSession, SourceCredential, SourceIssueDetail, SourceProvider, SourceSettings } from '../source-provider'
import { listGlabCliHosts, normalizeHost, readGlabCliEndpoint, readGlabCliToken, type GlabEndpoint } from './cli-credential'

const FALLBACK_HOST = 'gitlab.com'
const KEY_PATTERN = /^([A-Za-z0-9_./-]+)([#!])(\d+)$/

const GitlabUser = z.object({ id: z.number(), username: z.string().min(1) })

const GitlabItem = z.object({
  iid: z.number().int().positive(),
  title: z.string(),
  web_url: z.string().url(),
  state: z.string(),
  draft: z.boolean().optional(),
  work_in_progress: z.boolean().optional(),
  updated_at: z.string().optional(),
  description: z.string().nullable().optional(),
  labels: z.array(z.string()).default([]),
  references: z.object({ full: z.string().optional() }).optional(),
  author: z.object({ username: z.string() }).nullable().optional(),
  source_branch: z.string().optional(),
  target_branch: z.string().optional()
})

const GitlabNote = z.object({
  system: z.boolean().optional(),
  author: z.object({ username: z.string() }).nullable().optional(),
  created_at: z.string().optional(),
  body: z.string().nullable().optional(),
  position: z.object({
    new_path: z.string().nullable().optional(),
    old_path: z.string().nullable().optional(),
    new_line: z.number().nullable().optional(),
    old_line: z.number().nullable().optional()
  }).nullable().optional()
})

const TokenPayload = z.object({ token: z.string().min(1) })

type GitlabTarget = {
  origin: string
  host: string
  skipTlsVerify: boolean
  explicitScheme: boolean
}

function projectPathFromWebUrl(webUrl: string): string | null {
  try {
    const pathname = new URL(webUrl).pathname
    const marker = pathname.indexOf('/-/')
    if (marker > 1) return pathname.slice(1, marker)
    const parts = pathname.split('/').filter(Boolean)
    const idx = parts.findIndex((seg) => seg === 'issues' || seg === 'merge_requests')
    return idx > 0 ? parts.slice(0, idx).join('/') : null
  } catch {
    return null
  }
}

function extractPriority(labels: readonly string[]): string | null {
  const match = labels.find((name) => /^(?:p[0-4]|priority[:/\s-]*\w+|severity[:/\s-]*\w+|urgent|critical|high|medium|low)$/i.test(name.trim()))
  return match ? match.slice(0, 40) : null
}

function describeFetchError(error: unknown, target: GitlabTarget): string {
  const base = error instanceof Error ? error.message : String(error)
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : ''
  const detail = cause && cause !== base ? `${base} (${cause})` : base
  if (!target.explicitScheme && target.origin.startsWith('https://')) {
    return `${detail}；若该自建实例使用 HTTP，请填写 http://${target.host}`
  }
  return detail
}

export type GitlabSourceDependencies = {
  fetch?: typeof fetch
  glabToken?: (host: string, env: NodeJS.ProcessEnv) => string | null
  glabEndpoint?: (host: string, env: NodeJS.ProcessEnv) => GlabEndpoint | null
  glabHosts?: (env: NodeJS.ProcessEnv) => string[]
  configuredHost?: () => string | undefined
  hasStoredCredential?: () => boolean
}

export function createGitlabSource(dependencies: GitlabSourceDependencies = {}): SourceProvider {
  const http = dependencies.fetch ?? fetch
  const readGlab = dependencies.glabToken ?? readGlabCliToken
  const readEndpoint = dependencies.glabEndpoint ?? readGlabCliEndpoint
  const detectHosts = dependencies.glabHosts ?? listGlabCliHosts
  const configuredHost = dependencies.configuredHost ?? (() => undefined)
  const hasStoredCredential = dependencies.hasStoredCredential ?? (() => false)
  const defaultHost = detectHosts(process.env)[0] ?? FALLBACK_HOST
  let insecureAgent: Agent | null = null

  function resolveTarget(rawHost: string | undefined): GitlabTarget {
    const trimmed = (rawHost ?? '').trim()
    if (/^https?:\/\//i.test(trimmed)) {
      let parsed: URL
      try {
        parsed = new URL(trimmed)
      } catch {
        throw new SourceError('invalid-settings', `无效的 GitLab 地址：${trimmed}`)
      }
      const host = parsed.host.toLowerCase()
      const endpoint = readEndpoint(host, process.env)
      return {
        origin: `${parsed.protocol}//${parsed.host}`,
        host,
        skipTlsVerify: Boolean(endpoint?.skipTlsVerify),
        explicitScheme: true
      }
    }
    const host = normalizeHost(trimmed, defaultHost)
    const endpoint = readEndpoint(host, process.env)
    return {
      origin: endpoint ? `${endpoint.protocol}://${endpoint.apiHost}` : `https://${host}`,
      host,
      skipTlsVerify: Boolean(endpoint?.skipTlsVerify),
      explicitScheme: Boolean(endpoint)
    }
  }

  const settings: readonly SettingField[] = [
    {
      key: 'host',
      type: 'text',
      label: 'GitLab 地址或域名',
      translations: {
        en: {
          label: 'GitLab host or URL',
          hint: 'Defaults to gitlab.com or your logged-in glab CLI host & protocol; supports http:// or https:// self-hosted URLs.'
        }
      },
      placeholder: defaultHost,
      hint: '默认复用本机 glab 登录域名与协议（HTTP/HTTPS）或 gitlab.com；支持填写自建地址（如 http://10.x.x.x）',
      required: false,
      default: defaultHost,
      mono: true,
      bindsCredential: true
    },
    {
      key: 'scope',
      type: 'select',
      label: '同步范围',
      translations: { en: { label: 'Sync scope' } },
      required: true,
      default: 'assigned_to_me',
      options: [
        {
          value: 'assigned_to_me',
          label: '分配给我的 Issues 与 MRs（含待我评审 MR）',
          translations: { en: { label: 'Assigned to me (Issues, MRs & review requests)' } }
        },
        {
          value: 'created_by_me',
          label: '我创建的 Issues 与 MRs',
          translations: { en: { label: 'Created by me (Issues & MRs)' } }
        },
        {
          value: 'all',
          label: '我参与项目的全部开放 Issues 与 MRs',
          translations: { en: { label: 'All open Issues & MRs in my projects' } }
        }
      ]
    },
    {
      key: 'project',
      type: 'text',
      label: '限定项目路径（可选）',
      translations: {
        en: {
          label: 'Project path (optional)',
          hint: 'e.g. group/repo — leave empty to sync across all accessible projects.'
        }
      },
      placeholder: 'group/project',
      hint: '可选：填写 group/project 仅同步指定仓库，留空同步全部',
      required: false,
      mono: true
    }
  ]

  async function requestJson(target: GitlabTarget, endpoint: string, token: string, signal: AbortSignal): Promise<unknown> {
    const url = `${target.origin}/api/v4${endpoint}`
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'PRIVATE-TOKEN': token
    }
    let response: { status: number; ok: boolean; json(): Promise<unknown> }
    try {
      if (!dependencies.fetch && target.skipTlsVerify && target.origin.startsWith('https://')) {
        insecureAgent ??= new Agent({ connect: { rejectUnauthorized: false } })
        response = await undiciFetch(url, { headers, signal, dispatcher: insecureAgent })
      } else {
        response = await http(url, { headers, signal })
      }
    } catch (error) {
      throw new SourceError('request-failed', describeFetchError(error, target))
    }
    if (response.status === 401) throw new SourceError('auth-failed', 'GitLab 登录凭证无效或已过期')
    if (response.status === 403) throw new SourceError('forbidden', 'GitLab Token 权限不足（需要 read_api 权限）')
    if (response.status === 404) throw new SourceError('not-found', '找不到对应的 GitLab 项目或事项')
    if (!response.ok) throw new SourceError('request-failed', `GitLab HTTP ${response.status}`)
    return response.json()
  }

  function tokenOf(credential: SourceCredential): string {
    const parsed = TokenPayload.safeParse(credential.payload)
    if (!parsed.success) throw new SourceError('auth-failed', 'GitLab 凭证格式无效')
    return parsed.data.token
  }

  function toSourceIssue(item: z.infer<typeof GitlabItem>, kind: 'Issue' | 'MR'): SourceIssue | null {
    const sep = kind === 'MR' ? '!' : '#'
    const refFull = item.references?.full
    const project = projectPathFromWebUrl(item.web_url)
    const key = refFull && KEY_PATTERN.test(refFull)
      ? refFull
      : project
        ? `${project}${sep}${item.iid}`
        : null
    if (!key) return null
    const draft = Boolean(item.draft || item.work_in_progress)
    const status = item.state === 'merged'
      ? 'Merged'
      : item.state === 'opened'
        ? (draft ? 'Draft' : 'Open')
        : 'Closed'
    const updatedMs = item.updated_at ? Date.parse(item.updated_at) : Number.NaN
    return {
      key,
      title: item.title,
      url: item.web_url,
      status,
      statusCategory: item.state === 'opened' ? 'todo' : 'done',
      type: kind,
      priority: extractPriority(item.labels),
      updatedAt: Number.isFinite(updatedMs) ? updatedMs : null
    }
  }

  return {
    id: 'gitlab',
    name: 'GitLab',
    settings,

    normalizeSettings(values: SourceSettings): Record<string, string> {
      const rawHost = (values.host ?? defaultHost).trim() || defaultHost
      const target = resolveTarget(rawHost)
      const normalizedHost = /^https?:\/\//i.test(rawHost) ? target.origin : normalizeHost(rawHost, defaultHost)
      const scope = values.scope === 'created_by_me' || values.scope === 'all' ? values.scope : 'assigned_to_me'
      const project = (values.project ?? '').trim().replace(/^\/+|\/+$/g, '')
      return { host: normalizedHost, scope, ...(project ? { project } : {}) }
    },

    normalizeKey(raw: string): string {
      return raw
        .trim()
        .replace(/^https?:\/\/[^/]+\/(.+?)\/-\/issues\/(\d+).*$/i, '$1#$2')
        .replace(/^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\/(\d+).*$/i, '$1!$2')
    },

    envCredential(env: NodeJS.ProcessEnv): SourceCredential | null {
      const explicit = (env.CONCLAVE_GITLAB_TOKEN || env.GITLAB_TOKEN || env.GLAB_TOKEN || '').trim()
      if (explicit) return { kind: 'token', payload: { token: explicit } }
      if (hasStoredCredential()) return null
      const host = env.CONCLAVE_GITLAB_HOST
        ? normalizeHost(env.CONCLAVE_GITLAB_HOST, defaultHost)
        : normalizeHost(configuredHost(), defaultHost)
      const fromCli = readGlab(host, env)
      return fromCli ? { kind: 'token', payload: { token: fromCli } } : null
    },

    async login(session: LoginSession, currentSettings: SourceSettings, signal: AbortSignal) {
      const target = resolveTarget(currentSettings.host)
      const hostName = target.host
      const cliToken = readGlab(hostName, process.env)
      let mode = cliToken ? 'glab' : 'token'
      if (cliToken) {
        mode = await session.prompt({
          kind: 'select',
          label: '选择 GitLab 连接方式',
          translations: { en: { label: 'Choose GitLab sign-in method' } },
          defaultValue: 'glab',
          options: [
            { value: 'glab', label: `自动复用本机 glab CLI 登录态 (${hostName})`, translations: { en: { label: `Reuse local glab CLI credentials (${hostName})` } } },
            { value: 'token', label: '手动输入 Personal Access Token', translations: { en: { label: 'Enter Personal Access Token manually' } } }
          ]
        })
      }

      let lastError: string | undefined
      for (;;) {
        const candidate = mode === 'glab' && cliToken
          ? cliToken
          : (await session.prompt({
              kind: 'secret',
              label: `${hostName} Personal Access Token`,
              hint: '请在 GitLab 创建勾选 read_api 权限的 Access Token',
              translations: {
                en: {
                  label: `${hostName} Personal Access Token`,
                  hint: 'Create a Personal Access Token with read_api scope.'
                }
              },
              placeholder: 'glpat-...',
              link: {
                url: `${target.origin}/-/user_settings/personal_access_tokens`,
                label: '打开 GitLab Token 页面',
                translations: { en: { label: 'Open GitLab access tokens' } }
              },
              ...(lastError ? { error: lastError } : {})
            })).trim()

        if (!candidate) {
          lastError = 'Token 不能为空'
          mode = 'token'
          continue
        }

        try {
          const user = GitlabUser.parse(await requestJson(target, '/user', candidate, signal))
          return { credential: { kind: 'token', payload: { token: candidate } }, account: user.username }
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error)
          mode = 'token'
        }
      }
    },

    async list(currentSettings: SourceSettings, credential: SourceCredential, signal: AbortSignal): Promise<SourceIssue[]> {
      const target = resolveTarget(currentSettings.host)
      const token = tokenOf(credential)
      const scope = currentSettings.scope === 'created_by_me' || currentSettings.scope === 'all' ? currentSettings.scope : 'assigned_to_me'
      const project = (currentSettings.project ?? '').trim()
      const prefix = project ? `/projects/${encodeURIComponent(project)}` : ''
      const query = `state=opened&scope=${encodeURIComponent(scope)}&order_by=updated_at&sort=desc&per_page=40`

      const requests: Promise<{ kind: 'Issue' | 'MR'; data: unknown }>[] = [
        requestJson(target, `${prefix}/issues?${query}`, token, signal).then((data) => ({ kind: 'Issue' as const, data })),
        requestJson(target, `${prefix}/merge_requests?${query}`, token, signal).then((data) => ({ kind: 'MR' as const, data }))
      ]

      if (scope === 'assigned_to_me') {
        requests.push(
          requestJson(target, '/user', token, signal)
            .then((rawUser) => {
              const user = GitlabUser.parse(rawUser)
              return requestJson(
                target,
                `${prefix}/merge_requests?state=opened&scope=all&reviewer_id=${user.id}&order_by=updated_at&sort=desc&per_page=30`,
                token,
                signal
              )
            })
            .then((data) => ({ kind: 'MR' as const, data }))
            .catch(() => ({ kind: 'MR' as const, data: [] }))
        )
      }

      const batches = await Promise.all(requests)
      const byKey = new Map<string, SourceIssue>()
      for (const batch of batches) {
        const parsed = z.array(GitlabItem).safeParse(batch.data)
        if (!parsed.success) continue
        for (const raw of parsed.data) {
          const mapped = toSourceIssue(raw, batch.kind)
          if (mapped && !byKey.has(mapped.key)) byKey.set(mapped.key, mapped)
        }
      }
      return [...byKey.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    },

    async fetch(currentSettings: SourceSettings, credential: SourceCredential, key: string, signal: AbortSignal): Promise<SourceIssueDetail> {
      const match = KEY_PATTERN.exec(key)
      const project = match?.[1]
      const sep = match?.[2]
      const iid = match?.[3]
      if (!project || !sep || !iid) throw new SourceError('not-found', `无效的 GitLab 事项编号：${key}`)
      const isMr = sep === '!'
      const target = resolveTarget(currentSettings.host)
      const token = tokenOf(credential)
      const encodedProject = encodeURIComponent(project)
      const collection = isMr ? 'merge_requests' : 'issues'

      const [itemRaw, notesRaw] = await Promise.all([
        requestJson(target, `/projects/${encodedProject}/${collection}/${iid}`, token, signal),
        requestJson(target, `/projects/${encodedProject}/${collection}/${iid}/notes?sort=asc&per_page=30`, token, signal).catch(() => [])
      ])

      const item = GitlabItem.parse(itemRaw)
      const notes = z.array(GitlabNote).safeParse(notesRaw)
      const userNotes = notes.success ? notes.data.filter((n) => !n.system && n.body?.trim()) : []

      const sections: string[] = [
        `# [${isMr ? 'MR' : 'Issue'}] ${key}: ${item.title}`,
        item.author?.username ? `作者: @${item.author.username}` : '',
        isMr && item.source_branch && item.target_branch ? `分支: \`${item.source_branch}\` → \`${item.target_branch}\`` : '',
        '',
        '## 描述',
        item.description?.trim() || '（无正文描述）'
      ].filter((line, idx) => line !== '' || idx >= 3)

      if (userNotes.length > 0) {
        sections.push('', isMr ? '## 评审批注与讨论' : '## 讨论评论')
        for (const note of userNotes) {
          const pos = note.position
          const pathLoc = pos?.new_path ?? pos?.old_path
          const lineLoc = pos?.new_line ?? pos?.old_line
          const prefixLoc = pathLoc ? `\`${lineLoc ? `${pathLoc}:${lineLoc}` : pathLoc}\` · ` : ''
          sections.push(`- ${prefixLoc}**@${note.author?.username ?? 'user'}**: ${note.body?.trim() ?? ''}`)
        }
      }

      const base = toSourceIssue(item, isMr ? 'MR' : 'Issue')
      if (!base) throw new SourceError('not-found', `无法解析 GitLab 事项：${key}`)
      return {
        ...base,
        key,
        markdown: sections.join('\n').slice(0, 48_000)
      }
    }
  }
}
