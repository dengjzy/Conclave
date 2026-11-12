import { z } from 'zod'
import type { SettingField, SourceIssue } from '@conclave/protocol'
import { SourceError } from '../source-error'
import type { LoginSession, SourceCredential, SourceIssueDetail, SourceProvider, SourceSettings } from '../source-provider'
import { normalizeHost, readGhCliToken } from './cli-credential'

const DEFAULT_HOST = 'github.com'
const DEFAULT_QUERY = 'involves:@me state:open'
const KEY_PATTERN = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/

const GithubUser = z.object({ login: z.string().min(1) })
const GithubLabel = z.union([z.string(), z.object({ name: z.string() })])
const GithubSearchItem = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  html_url: z.string().url(),
  repository_url: z.string().url(),
  state: z.string(),
  draft: z.boolean().optional(),
  updated_at: z.string().optional(),
  body: z.string().nullable().optional(),
  labels: z.array(GithubLabel).default([]),
  pull_request: z.object({ merged_at: z.string().nullable().optional() }).passthrough().optional(),
  user: z.object({ login: z.string() }).nullable().optional()
})
const GithubSearchResponse = z.object({ items: z.array(GithubSearchItem).default([]) })

const GithubComment = z.object({
  user: z.object({ login: z.string() }).nullable().optional(),
  created_at: z.string().optional(),
  body: z.string().nullable().optional()
})

const GithubPullDetail = z.object({
  head: z.object({ ref: z.string(), label: z.string().optional() }).optional(),
  base: z.object({ ref: z.string(), label: z.string().optional() }).optional(),
  changed_files: z.number().optional(),
  additions: z.number().optional(),
  deletions: z.number().optional(),
  mergeable_state: z.string().nullable().optional()
}).passthrough()

const GithubReview = z.object({
  user: z.object({ login: z.string() }).nullable().optional(),
  state: z.string(),
  body: z.string().nullable().optional()
})

const GithubReviewComment = z.object({
  user: z.object({ login: z.string() }).nullable().optional(),
  path: z.string(),
  line: z.number().nullable().optional(),
  original_line: z.number().nullable().optional(),
  body: z.string().nullable().optional()
})

const TokenPayload = z.object({ token: z.string().min(1) })

function apiBase(host: string): string {
  const clean = normalizeHost(host, DEFAULT_HOST)
  return clean === 'github.com' ? 'https://api.github.com' : `https://${clean}/api/v3`
}

function webBase(host: string): string {
  return `https://${normalizeHost(host, DEFAULT_HOST)}`
}

function repoFromApiUrl(repositoryUrl: string): string | null {
  try {
    const parts = new URL(repositoryUrl).pathname.split('/').filter(Boolean)
    const reposIdx = parts.lastIndexOf('repos')
    if (reposIdx >= 0 && parts.length >= reposIdx + 3) {
      return `${parts[reposIdx + 1]}/${parts[reposIdx + 2]}`
    }
    if (parts.length >= 2) {
      return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
    }
    return null
  } catch {
    return null
  }
}

function extractPriority(labels: readonly z.infer<typeof GithubLabel>[]): string | null {
  const names = labels.map((label) => (typeof label === 'string' ? label : label.name))
  const match = names.find((name) => /^(?:p[0-4]|priority[:/\s-]*\w+|urgent|critical|high|medium|low)$/i.test(name.trim()))
  return match ? match.slice(0, 40) : null
}

const SETTINGS: readonly SettingField[] = [
  {
    key: 'host',
    type: 'text',
    label: 'GitHub 域名',
    translations: {
      en: {
        label: 'GitHub host',
        hint: 'Defaults to github.com; enter your GitHub Enterprise hostname if self-hosted.'
      }
    },
    placeholder: DEFAULT_HOST,
    hint: '默认 github.com；GitHub Enterprise 填写企业域名',
    required: false,
    default: DEFAULT_HOST,
    mono: true,
    bindsCredential: true
  },
  {
    key: 'query',
    type: 'text',
    label: '搜索筛选条件',
    translations: {
      en: {
        label: 'Search filter',
        hint: 'Uses GitHub search syntax and syncs both Issues and Pull Requests unless filtered by is:issue or is:pr.'
      }
    },
    placeholder: DEFAULT_QUERY,
    hint: '支持 GitHub 搜索语法，同时同步 Issue 与 PR（如 involves:@me state:open、review-requested:@me is:pr）',
    required: true,
    default: DEFAULT_QUERY,
    mono: true
  }
]

export type GithubSourceDependencies = {
  fetch?: typeof fetch
  ghToken?: (host: string, env: NodeJS.ProcessEnv) => string | null
  configuredHost?: () => string | undefined
  hasStoredCredential?: () => boolean
}

export function createGithubSource(dependencies: GithubSourceDependencies = {}): SourceProvider {
  const http = dependencies.fetch ?? fetch
  const readGh = dependencies.ghToken ?? readGhCliToken
  const configuredHost = dependencies.configuredHost ?? (() => undefined)
  const hasStoredCredential = dependencies.hasStoredCredential ?? (() => false)
  const etagCache = new Map<string, { etag: string; items: SourceIssue[] }>()

  async function requestJson(
    host: string,
    endpoint: string,
    token: string,
    signal: AbortSignal,
    etagKey?: string
  ): Promise<{ notModified: true; cached: SourceIssue[] } | { notModified: false; data: unknown; etag: string | null }> {
    const cached = etagKey ? etagCache.get(etagKey) : undefined
    let response: Response
    try {
      response = await http(`${apiBase(host)}${endpoint}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'Conclave-Workbench',
          ...(cached ? { 'If-None-Match': cached.etag } : {})
        },
        signal
      })
    } catch (error) {
      throw new SourceError('request-failed', error instanceof Error ? error.message : String(error))
    }

    if (response.status === 304 && cached) {
      return { notModified: true, cached: cached.items }
    }
    if (response.status === 401) throw new SourceError('auth-failed', 'GitHub 登录凭证已失效或无权访问')
    if (response.status === 403) throw new SourceError('forbidden', 'GitHub API 权限不足或触发速率限制')
    if (response.status === 404) throw new SourceError('not-found', '找不到对应的 GitHub 资源')
    if (response.status === 422) throw new SourceError('bad-query', 'GitHub 搜索条件语法无效')
    if (!response.ok) throw new SourceError('request-failed', `GitHub HTTP ${response.status}`)

    const data: unknown = await response.json()
    return { notModified: false, data, etag: response.headers.get('etag') }
  }

  function tokenOf(credential: SourceCredential): string {
    const parsed = TokenPayload.safeParse(credential.payload)
    if (!parsed.success) throw new SourceError('auth-failed', 'GitHub 凭证格式无效')
    return parsed.data.token
  }

  return {
    id: 'github',
    name: 'GitHub',
    settings: SETTINGS,

    normalizeSettings(values: SourceSettings): Record<string, string> {
      const host = normalizeHost(values.host, DEFAULT_HOST)
      const query = (values.query ?? DEFAULT_QUERY).trim()
      if (!query) throw new SourceError('invalid-settings', '请填写 GitHub 搜索筛选条件')
      return { host, query }
    },

    normalizeKey(raw: string): string {
      return raw.trim().replace(/^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/(?:issues|pull)\/(\d+).*$/i, '$1#$2')
    },

    envCredential(env: NodeJS.ProcessEnv): SourceCredential | null {
      const explicit = (env.CONCLAVE_GITHUB_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN || '').trim()
      if (explicit) return { kind: 'token', payload: { token: explicit } }
      if (hasStoredCredential()) return null
      const host = normalizeHost(configuredHost(), DEFAULT_HOST)
      const fromCli = readGh(host, env)
      return fromCli ? { kind: 'token', payload: { token: fromCli } } : null
    },

    async login(session: LoginSession, settings: SourceSettings, signal: AbortSignal) {
      const host = normalizeHost(settings.host, DEFAULT_HOST)
      const cliToken = readGh(host, process.env)
      let mode = cliToken ? 'gh' : 'token'
      if (cliToken) {
        mode = await session.prompt({
          kind: 'select',
          label: '选择 GitHub 连接方式',
          translations: { en: { label: 'Choose GitHub sign-in method' } },
          defaultValue: 'gh',
          options: [
            { value: 'gh', label: '自动复用本机 gh CLI 登录态', translations: { en: { label: 'Reuse local gh CLI credentials' } } },
            { value: 'token', label: '手动输入 Personal Access Token', translations: { en: { label: 'Enter Personal Access Token manually' } } }
          ]
        })
      }

      let lastError: string | undefined
      for (;;) {
        const candidate = mode === 'gh' && cliToken
          ? cliToken
          : (await session.prompt({
              kind: 'secret',
              label: `${host} Personal Access Token`,
              hint: '仅需 repo / read:org 读权限即可同步 Issue 与 PR',
              translations: {
                en: {
                  label: `${host} Personal Access Token`,
                  hint: 'Read access to issues and pull requests is sufficient.'
                }
              },
              placeholder: 'ghp_... / github_pat_...',
              link: {
                url: `${webBase(host)}/settings/tokens`,
                label: '打开 GitHub Token 页面',
                translations: { en: { label: 'Open GitHub tokens settings' } }
              },
              ...(lastError ? { error: lastError } : {})
            })).trim()

        if (!candidate) {
          lastError = 'Token 不能为空'
          mode = 'token'
          continue
        }

        try {
          const res = await requestJson(host, '/user', candidate, signal)
          if (res.notModified) throw new SourceError('request-failed', 'unexpected 304')
          const user = GithubUser.parse(res.data)
          return { credential: { kind: 'token', payload: { token: candidate } }, account: user.login }
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error)
          mode = 'token'
        }
      }
    },

    async list(settings: SourceSettings, credential: SourceCredential, signal: AbortSignal): Promise<SourceIssue[]> {
      const host = normalizeHost(settings.host, DEFAULT_HOST)
      const query = (settings.query ?? DEFAULT_QUERY).trim() || DEFAULT_QUERY
      const token = tokenOf(credential)
      const endpoint = `/search/issues?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=50`
      const cacheKey = `${host}|${query}|${token.slice(-8)}`
      const response = await requestJson(host, endpoint, token, signal, cacheKey)
      if (response.notModified) return response.cached

      const parsed = GithubSearchResponse.parse(response.data)
      const issues: SourceIssue[] = []
      for (const item of parsed.items) {
        const repo = repoFromApiUrl(item.repository_url)
        if (!repo) continue
        const isPr = Boolean(item.pull_request)
        const merged = Boolean(item.pull_request?.merged_at)
        const status = merged
          ? 'Merged'
          : item.state === 'open'
            ? (item.draft ? 'Draft' : 'Open')
            : 'Closed'
        const updatedMs = item.updated_at ? Date.parse(item.updated_at) : Number.NaN
        issues.push({
          key: `${repo}#${item.number}`,
          title: item.title,
          url: item.html_url,
          status,
          statusCategory: item.state === 'open' ? 'todo' : 'done',
          type: isPr ? 'PR' : 'Issue',
          priority: extractPriority(item.labels),
          updatedAt: Number.isFinite(updatedMs) ? updatedMs : null
        })
      }
      if (response.etag) {
        etagCache.set(cacheKey, { etag: response.etag, items: issues })
      }
      return issues
    },

    async fetch(settings: SourceSettings, credential: SourceCredential, key: string, signal: AbortSignal): Promise<SourceIssueDetail> {
      const match = KEY_PATTERN.exec(key)
      if (!match) throw new SourceError('not-found', `无效的 GitHub 事项编号：${key}`)
      const [, repo, num] = match
      const host = normalizeHost(settings.host, DEFAULT_HOST)
      const token = tokenOf(credential)

      const issueRes = await requestJson(host, `/repos/${repo}/issues/${num}`, token, signal)
      if (issueRes.notModified) throw new SourceError('request-failed', 'unexpected 304')
      const item = GithubSearchItem.parse(issueRes.data)
      const isPr = Boolean(item.pull_request)

      const commentsRes = await requestJson(host, `/repos/${repo}/issues/${num}/comments?per_page=20`, token, signal)
      const comments = commentsRes.notModified ? [] : z.array(GithubComment).parse(commentsRes.data)

      const sections: string[] = [
        `# [${isPr ? 'PR' : 'Issue'}] ${repo}#${item.number}: ${item.title}`,
        item.user?.login ? `作者: @${item.user.login}` : ''
      ].filter(Boolean)

      if (isPr) {
        const [prRes, reviewsRes, inlineRes] = await Promise.all([
          requestJson(host, `/repos/${repo}/pulls/${num}`, token, signal).catch(() => null),
          requestJson(host, `/repos/${repo}/pulls/${num}/reviews?per_page=20`, token, signal).catch(() => null),
          requestJson(host, `/repos/${repo}/pulls/${num}/comments?per_page=30`, token, signal).catch(() => null)
        ])
        if (prRes && !prRes.notModified) {
          const pr = GithubPullDetail.safeParse(prRes.data)
          if (pr.success) {
            const head = pr.data.head?.ref ?? ''
            const base = pr.data.base?.ref ?? ''
            if (head && base) sections.push(`分支: \`${head}\` → \`${base}\``)
            if (pr.data.changed_files !== undefined) {
              sections.push(`变更统计: ${pr.data.changed_files} 个文件 (+${pr.data.additions ?? 0} / -${pr.data.deletions ?? 0})`)
            }
          }
        }
        sections.push('', '## 描述', item.body?.trim() || '（无正文描述）')
        if (reviewsRes && !reviewsRes.notModified) {
          const reviews = z.array(GithubReview).safeParse(reviewsRes.data)
          const nonEmpty = reviews.success ? reviews.data.filter((r) => r.state !== 'PENDING' && (r.body?.trim() || r.state)) : []
          if (nonEmpty.length > 0) {
            sections.push('', '## 评审结论 (Reviews)')
            for (const review of nonEmpty) {
              sections.push(`- **@${review.user?.login ?? 'reviewer'}** [${review.state}]${review.body?.trim() ? `: ${review.body.trim()}` : ''}`)
            }
          }
        }
        if (inlineRes && !inlineRes.notModified) {
          const inlines = z.array(GithubReviewComment).safeParse(inlineRes.data)
          if (inlines.success && inlines.data.length > 0) {
            sections.push('', '## 行内代码批注 (Inline Review Comments)')
            for (const note of inlines.data) {
              const line = note.line ?? note.original_line
              const loc = line ? `${note.path}:${line}` : note.path
              sections.push(`- \`${loc}\` (@${note.user?.login ?? 'reviewer'}): ${note.body?.trim() ?? ''}`)
            }
          }
        }
      } else {
        sections.push('', '## 描述', item.body?.trim() || '（无正文描述）')
      }

      if (comments.length > 0) {
        sections.push('', '## 讨论评论')
        for (const comment of comments) {
          if (!comment.body?.trim()) continue
          sections.push(`### @${comment.user?.login ?? 'user'} (${comment.created_at ?? ''})`, comment.body.trim(), '')
        }
      }

      const updatedMs = item.updated_at ? Date.parse(item.updated_at) : Number.NaN
      return {
        key: `${repo}#${item.number}`,
        title: item.title,
        url: item.html_url,
        status: item.pull_request?.merged_at ? 'Merged' : item.state === 'open' ? (item.draft ? 'Draft' : 'Open') : 'Closed',
        statusCategory: item.state === 'open' ? 'todo' : 'done',
        type: isPr ? 'PR' : 'Issue',
        priority: extractPriority(item.labels),
        updatedAt: Number.isFinite(updatedMs) ? updatedMs : null,
        markdown: sections.join('\n').slice(0, 48_000)
      }
    }
  }
}
