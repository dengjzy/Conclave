import { z } from 'zod'
import type { ISSUE_STATUS_CATEGORIES, SettingField, SourceIssue } from '@conclave/protocol'
import { SourceError } from '../source-error'
import type { LoginSession, SourceCredential, SourceIssueDetail, SourceProvider, SourceSettings } from '../source-provider'

const DEFAULT_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'

const JiraMyself = z.object({
  displayName: z.string().optional(),
  emailAddress: z.string().optional(),
  name: z.string().optional()
})

const JiraFields = z.object({
  summary: z.string(),
  updated: z.string().nullable().optional(),
  description: z.unknown().optional(),
  status: z.object({
    name: z.string(),
    statusCategory: z.object({ key: z.string().optional() }).optional()
  }).optional(),
  issuetype: z.object({ name: z.string() }).optional(),
  priority: z.object({ name: z.string() }).nullable().optional(),
  comment: z.object({
    comments: z.array(z.object({
      author: z.object({ displayName: z.string().optional() }).optional(),
      created: z.string().optional(),
      body: z.unknown().optional()
    })).default([])
  }).optional()
})

const JiraIssueBean = z.object({
  key: z.string(),
  fields: JiraFields
})

const JiraSearchResponse = z.object({
  issues: z.array(JiraIssueBean).default([])
})

const BasicPayload = z.object({ email: z.string().min(1), token: z.string().min(1) })
const BearerPayload = z.object({ token: z.string().min(1) })

function normalizeSite(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) throw new SourceError('invalid-settings', '请填写 Jira 站点地址')
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const parsed = new URL(withScheme)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new SourceError('invalid-settings', 'Jira 站点地址必须使用 https 或 http')
    }
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`
  } catch (error) {
    if (error instanceof SourceError) throw error
    throw new SourceError('invalid-settings', `无效的 Jira 站点地址：${trimmed}`)
  }
}

function authHeader(credential: SourceCredential): string {
  if (credential.kind === 'basic') {
    const parsed = BasicPayload.safeParse(credential.payload)
    if (!parsed.success) throw new SourceError('auth-failed', 'Jira Basic 凭证格式无效')
    const encoded = Buffer.from(`${parsed.data.email}:${parsed.data.token}`, 'utf8').toString('base64')
    return `Basic ${encoded}`
  }
  const parsed = BearerPayload.safeParse(credential.payload)
  if (!parsed.success) throw new SourceError('auth-failed', 'Jira Token 凭证格式无效')
  return `Bearer ${parsed.data.token}`
}

function mapCategory(raw: string | undefined): (typeof ISSUE_STATUS_CATEGORIES)[number] {
  if (raw === 'new') return 'todo'
  if (raw === 'indeterminate') return 'doing'
  if (raw === 'done') return 'done'
  return 'unknown'
}

const AdfNode: z.ZodType<{ type?: string; text?: string; content?: unknown[] }> = z.lazy(() =>
  z.object({
    type: z.string().optional(),
    text: z.string().optional(),
    content: z.array(z.unknown()).optional()
  }).passthrough()
)

function renderRichBody(body: unknown): string {
  if (typeof body === 'string') return body.trim()
  const parsed = AdfNode.safeParse(body)
  if (!parsed.success) return ''
  const walk = (node: unknown): string => {
    const item = AdfNode.safeParse(node)
    if (!item.success) return ''
    if (typeof item.data.text === 'string') return item.data.text
    const children = (item.data.content ?? []).map(walk)
    switch (item.data.type) {
      case 'paragraph':
      case 'heading':
        return `${children.join('')}\n\n`
      case 'listItem':
        return `- ${children.join('').trim()}\n`
      case 'codeBlock':
        return `\`\`\`\n${children.join('')}\n\`\`\`\n\n`
      case 'hardBreak':
        return '\n'
      default:
        return children.join('')
    }
  }
  return walk(parsed.data).trim()
}

const SETTINGS: readonly SettingField[] = [
  {
    key: 'site',
    type: 'url',
    label: 'Jira 站点地址',
    translations: {
      en: {
        label: 'Jira site URL',
        hint: 'e.g. https://your-team.atlassian.net or your self-hosted Jira URL'
      }
    },
    placeholder: 'https://your-team.atlassian.net',
    hint: '例如 https://your-team.atlassian.net 或自建 Jira 地址',
    required: true,
    mono: true,
    bindsCredential: true
  },
  {
    key: 'jql',
    type: 'textarea',
    label: 'JQL 筛选条件',
    translations: {
      en: {
        label: 'JQL query',
        hint: 'Issues matching this JQL query appear in your Agenda.'
      }
    },
    placeholder: DEFAULT_JQL,
    hint: '默认同步分配给当前用户且未完成的事项',
    required: true,
    default: DEFAULT_JQL,
    mono: true
  }
]

export type JiraSourceDependencies = {
  fetch?: typeof fetch
}

export function createJiraSource(dependencies: JiraSourceDependencies = {}): SourceProvider {
  const http = dependencies.fetch ?? fetch

  async function requestJson(site: string, endpoint: string, auth: string, signal: AbortSignal, init?: RequestInit): Promise<Response> {
    try {
      return await http(`${site}${endpoint}`, {
        ...init,
        headers: {
          Accept: 'application/json',
          Authorization: auth,
          ...(init?.body ? { 'Content-Type': 'application/json' } : {})
        },
        signal
      })
    } catch (error) {
      throw new SourceError('request-failed', error instanceof Error ? error.message : String(error))
    }
  }

  function checkStatus(response: Response): void {
    if (response.status === 401) throw new SourceError('auth-failed', 'Jira 认证失败，请检查邮箱或 API Token')
    if (response.status === 403) throw new SourceError('forbidden', 'Jira 账号无权访问该资源')
    if (response.status === 400) throw new SourceError('bad-query', 'JQL 查询语法无效')
    if (response.status === 404) throw new SourceError('not-found', '找不到对应的 Jira 站点或工作项')
    if (!response.ok) throw new SourceError('request-failed', `Jira HTTP ${response.status}`)
  }

  return {
    id: 'jira',
    name: 'Jira',
    settings: SETTINGS,

    normalizeSettings(values: SourceSettings): Record<string, string> {
      const site = normalizeSite(values.site)
      const jql = (values.jql ?? DEFAULT_JQL).trim()
      if (!jql) throw new SourceError('invalid-settings', '请填写 JQL 筛选条件')
      return { site, jql }
    },

    normalizeKey(raw: string): string {
      return raw
        .trim()
        .replace(/^https?:\/\/[^/]+\/browse\/([A-Za-z0-9]+-\d+).*$/i, '$1')
        .toUpperCase()
    },

    envCredential(env: NodeJS.ProcessEnv): SourceCredential | null {
      const pat = (env.CONCLAVE_JIRA_PAT || '').trim()
      if (pat) return { kind: 'bearer', payload: { token: pat } }
      const email = (env.CONCLAVE_JIRA_EMAIL || '').trim()
      const token = (env.CONCLAVE_JIRA_TOKEN || '').trim()
      return email && token ? { kind: 'basic', payload: { email, token } } : null
    },

    async login(session: LoginSession, settings: SourceSettings, signal: AbortSignal) {
      const site = normalizeSite(settings.site)
      const isCloud = /\.atlassian\.net$/i.test(new URL(site).hostname)
      const mode = await session.prompt({
        kind: 'select',
        label: '选择 Jira 认证方式',
        translations: { en: { label: 'Choose Jira authentication type' } },
        defaultValue: isCloud ? 'basic' : 'bearer',
        options: [
          { value: 'basic', label: '邮箱 + API Token（Jira Cloud 推荐）', translations: { en: { label: 'Email + API Token (Jira Cloud)' } } },
          { value: 'bearer', label: 'Personal Access Token（自建 Jira Server / DC）', translations: { en: { label: 'Personal Access Token (Jira Server / DC)' } } }
        ]
      })

      let lastError: string | undefined
      for (;;) {
        let credential: SourceCredential
        if (mode === 'bearer') {
          const token = (await session.prompt({
            kind: 'secret',
            label: 'Jira Personal Access Token',
            translations: { en: { label: 'Jira Personal Access Token' } },
            ...(lastError ? { error: lastError } : {})
          })).trim()
          credential = { kind: 'bearer', payload: { token } }
        } else {
          const email = (await session.prompt({
            kind: 'text',
            label: 'Atlassian 账号邮箱',
            translations: { en: { label: 'Atlassian account email' } },
            placeholder: 'you@company.com',
            ...(lastError ? { error: lastError } : {})
          })).trim()
          const token = (await session.prompt({
            kind: 'secret',
            label: 'Jira API Token',
            translations: { en: { label: 'Jira API Token' } },
            link: {
              url: 'https://id.atlassian.com/manage-profile/security/api-tokens',
              label: '创建 Atlassian API Token',
              translations: { en: { label: 'Create Atlassian API token' } }
            }
          })).trim()
          credential = { kind: 'basic', payload: { email, token } }
        }

        try {
          const auth = authHeader(credential)
          let res = await requestJson(site, '/rest/api/3/myself', auth, signal)
          if (res.status === 404) {
            res = await requestJson(site, '/rest/api/2/myself', auth, signal)
          }
          checkStatus(res)
          const me = JiraMyself.parse(await res.json())
          const account = me.displayName || me.emailAddress || me.name || 'Jira User'
          return { credential, account }
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error)
        }
      }
    },

    async list(settings: SourceSettings, credential: SourceCredential, signal: AbortSignal): Promise<SourceIssue[]> {
      const site = normalizeSite(settings.site)
      const jql = (settings.jql ?? DEFAULT_JQL).trim() || DEFAULT_JQL
      const auth = authHeader(credential)
      const fields = ['summary', 'status', 'issuetype', 'priority', 'updated']

      let res = await requestJson(
        site,
        `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=50&fields=${fields.join(',')}`,
        auth,
        signal
      )
      if (res.status === 404) {
        res = await requestJson(
          site,
          `/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=50&fields=${fields.join(',')}`,
          auth,
          signal
        )
      }
      checkStatus(res)
      const parsed = JiraSearchResponse.parse(await res.json())
      return parsed.issues.map((issue) => {
        const updatedMs = issue.fields.updated ? Date.parse(issue.fields.updated) : Number.NaN
        return {
          key: issue.key,
          title: issue.fields.summary,
          url: `${site}/browse/${issue.key}`,
          status: issue.fields.status?.name ?? 'Open',
          statusCategory: mapCategory(issue.fields.status?.statusCategory?.key),
          type: issue.fields.issuetype?.name ?? 'Issue',
          priority: issue.fields.priority?.name ?? null,
          updatedAt: Number.isFinite(updatedMs) ? updatedMs : null
        }
      })
    },

    async fetch(settings: SourceSettings, credential: SourceCredential, key: string, signal: AbortSignal): Promise<SourceIssueDetail> {
      const site = normalizeSite(settings.site)
      const auth = authHeader(credential)
      const fields = 'summary,description,status,issuetype,priority,updated,comment'
      let res = await requestJson(site, `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields}`, auth, signal)
      if (res.status === 404) {
        res = await requestJson(site, `/rest/api/2/issue/${encodeURIComponent(key)}?fields=${fields}`, auth, signal)
      }
      checkStatus(res)
      const issue = JiraIssueBean.parse(await res.json())
      const desc = renderRichBody(issue.fields.description) || '（无正文描述）'
      const comments = (issue.fields.comment?.comments ?? []).slice(-20)
      const sections: string[] = [
        `# [Jira] ${issue.key}: ${issue.fields.summary}`,
        '',
        '## 描述',
        desc
      ]
      if (comments.length > 0) {
        sections.push('', '## 评论')
        for (const comment of comments) {
          const text = renderRichBody(comment.body)
          if (!text) continue
          sections.push(`### ${comment.author?.displayName ?? 'User'} (${comment.created ?? ''})`, text, '')
        }
      }
      const updatedMs = issue.fields.updated ? Date.parse(issue.fields.updated) : Number.NaN
      return {
        key: issue.key,
        title: issue.fields.summary,
        url: `${site}/browse/${issue.key}`,
        status: issue.fields.status?.name ?? 'Open',
        statusCategory: mapCategory(issue.fields.status?.statusCategory?.key),
        type: issue.fields.issuetype?.name ?? 'Issue',
        priority: issue.fields.priority?.name ?? null,
        updatedAt: Number.isFinite(updatedMs) ? updatedMs : null,
        markdown: sections.join('\n').slice(0, 48_000)
      }
    }
  }
}
