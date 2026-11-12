import { describe, expect, it } from 'vitest'
import { createGithubSource } from './github-source'
import { createGitlabSource } from './gitlab-source'
import { createJiraSource } from './jira-source'

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  })
}

describe('built-in source providers', () => {
  it('syncs GitHub Issues and PRs, reuses gh CLI credentials, caches ETags, and builds 4-in-1 PR context', async () => {
    let stored = false
    const seenUrls: string[] = []
    const seenIfNoneMatch: (string | null)[] = []

    const github = createGithubSource({
      ghToken: (host) => (host === 'github.com' ? 'gho_cli_token' : null),
      configuredHost: () => 'github.com',
      hasStoredCredential: () => stored,
      fetch: async (input, init) => {
        const url = String(input)
        seenUrls.push(url)
        const headers = new Headers(init?.headers)
        seenIfNoneMatch.push(headers.get('If-None-Match'))

        if (url.includes('/search/issues')) {
          if (headers.get('If-None-Match') === '"etag-v1"') {
            return new Response(null, { status: 304 })
          }
          return jsonResponse(
            {
              items: [
                {
                  number: 12,
                  title: 'Fix daemon socket reconnect',
                  html_url: 'https://github.com/acme/conclave/issues/12',
                  repository_url: 'https://api.github.com/repos/acme/conclave',
                  state: 'open',
                  updated_at: '2026-11-12T10:00:00Z',
                  labels: [{ name: 'P1' }]
                },
                {
                  number: 42,
                  title: 'Add GitLab MR channel',
                  html_url: 'https://github.com/acme/conclave/pull/42',
                  repository_url: 'https://api.github.com/repos/acme/conclave',
                  state: 'open',
                  draft: false,
                  updated_at: '2026-11-12T11:00:00Z',
                  labels: ['enhancement'],
                  pull_request: { merged_at: null }
                }
              ]
            },
            200,
            { etag: '"etag-v1"' }
          )
        }
        if (url.endsWith('/repos/acme/conclave/issues/42')) {
          return jsonResponse({
            number: 42,
            title: 'Add GitLab MR channel',
            html_url: 'https://github.com/acme/conclave/pull/42',
            repository_url: 'https://api.github.com/repos/acme/conclave',
            state: 'open',
            body: 'Implements built-in GitLab source.',
            labels: [],
            pull_request: { merged_at: null }
          })
        }
        if (url.includes('/repos/acme/conclave/issues/42/comments')) {
          return jsonResponse([{ user: { login: 'alice' }, body: 'Please check self-hosted URLs.' }])
        }
        if (url.endsWith('/repos/acme/conclave/pulls/42')) {
          return jsonResponse({
            head: { ref: 'feat/gitlab' },
            base: { ref: 'main' },
            changed_files: 3,
            additions: 120,
            deletions: 8
          })
        }
        if (url.includes('/repos/acme/conclave/pulls/42/reviews')) {
          return jsonResponse([{ user: { login: 'bob' }, state: 'CHANGES_REQUESTED', body: 'Handle ! separator.' }])
        }
        if (url.includes('/repos/acme/conclave/pulls/42/comments')) {
          return jsonResponse([{ user: { login: 'bob' }, path: 'packages/protocol/src/source.ts', line: 5, body: 'Allow ! in key regex.' }])
        }
        throw new Error(`unexpected URL: ${url}`)
      }
    })

    expect(github.normalizeKey?.('https://github.com/acme/conclave/pull/42#discussion_r1')).toBe('acme/conclave#42')
    const cliCred = github.envCredential?.({})
    expect(cliCred).toEqual({ kind: 'token', payload: { token: 'gho_cli_token' } })
    stored = true
    expect(github.envCredential?.({})).toBeNull()
    expect(github.envCredential?.({ GITHUB_TOKEN: 'explicit_pat' })).toEqual({
      kind: 'token',
      payload: { token: 'explicit_pat' }
    })

    const credential = { kind: 'token', payload: { token: 'gho_cli_token' } }
    const settings = await github.normalizeSettings({ host: 'github.com', query: 'involves:@me state:open' })
    const first = await github.list(settings, credential, new AbortController().signal)
    expect(first).toMatchObject([
      { key: 'acme/conclave#12', type: 'Issue', priority: 'P1', status: 'Open' },
      { key: 'acme/conclave#42', type: 'PR', priority: null, status: 'Open' }
    ])

    const cached = await github.list(settings, credential, new AbortController().signal)
    expect(cached).toEqual(first)
    expect(seenIfNoneMatch[1]).toBe('"etag-v1"')

    const detail = await github.fetch(settings, credential, 'acme/conclave#42', new AbortController().signal)
    expect(detail.type).toBe('PR')
    expect(detail.markdown).toContain('`feat/gitlab` → `main`')
    expect(detail.markdown).toContain('CHANGES_REQUESTED')
    expect(detail.markdown).toContain('`packages/protocol/src/source.ts:5`')
  })

  it('syncs GitLab Issues and MRs (including reviewer MRs) and fetches inline diff notes', async () => {
    const gitlab = createGitlabSource({
      glabHosts: () => ['git.corp.internal'],
      glabToken: (host) => (host === 'git.corp.internal' ? 'glpat_cli' : null),
      fetch: async (input) => {
        const url = String(input)
        if (url.endsWith('/api/v4/user')) {
          return jsonResponse({ id: 7, username: 'swrd' })
        }
        if (url.includes('/api/v4/issues?')) {
          return jsonResponse([
            {
              iid: 9,
              title: 'Support self-hosted GitLab',
              web_url: 'https://git.corp.internal/platform/conclave/-/issues/9',
              state: 'opened',
              updated_at: '2026-11-12T08:00:00Z',
              labels: ['priority::high']
            }
          ])
        }
        if (url.includes('/api/v4/merge_requests?') && url.includes('reviewer_id=7')) {
          return jsonResponse([
            {
              iid: 21,
              title: 'Refactor task agenda header',
              web_url: 'https://git.corp.internal/platform/conclave/-/merge_requests/21',
              state: 'opened',
              draft: true,
              updated_at: '2026-11-12T09:30:00Z',
              labels: []
            }
          ])
        }
        if (url.includes('/api/v4/merge_requests?')) {
          return jsonResponse([])
        }
        if (url.includes('/projects/platform%2Fconclave/merge_requests/21/notes')) {
          return jsonResponse([
            {
              system: false,
              author: { username: 'reviewer1' },
              body: 'Use CSS tokens instead of hex colors.',
              position: { new_path: 'packages/web/src/styles.css', new_line: 140 }
            }
          ])
        }
        if (url.includes('/projects/platform%2Fconclave/merge_requests/21')) {
          return jsonResponse({
            iid: 21,
            title: 'Refactor task agenda header',
            web_url: 'https://git.corp.internal/platform/conclave/-/merge_requests/21',
            state: 'opened',
            description: 'Unifies the agenda bar.',
            source_branch: 'feat/agenda',
            target_branch: 'main',
            labels: []
          })
        }
        throw new Error(`unexpected GitLab URL: ${url}`)
      }
    })

    expect(gitlab.normalizeKey?.('https://git.corp.internal/platform/conclave/-/merge_requests/21')).toBe(
      'platform/conclave!21'
    )
    const cred = gitlab.envCredential?.({})
    expect(cred).toEqual({ kind: 'token', payload: { token: 'glpat_cli' } })

    const settings = await gitlab.normalizeSettings({})
    expect(settings.host).toBe('git.corp.internal')

    const items = await gitlab.list(settings, { kind: 'token', payload: { token: 'glpat_cli' } }, new AbortController().signal)
    expect(items.map((item) => ({ key: item.key, type: item.type, status: item.status }))).toEqual([
      { key: 'platform/conclave!21', type: 'MR', status: 'Draft' },
      { key: 'platform/conclave#9', type: 'Issue', status: 'Open' }
    ])

    const detail = await gitlab.fetch(
      settings,
      { kind: 'token', payload: { token: 'glpat_cli' } },
      'platform/conclave!21',
      new AbortController().signal
    )
    expect(detail.type).toBe('MR')
    expect(detail.markdown).toContain('`feat/agenda` → `main`')
    expect(detail.markdown).toContain('`packages/web/src/styles.css:140`')
  })

  it('supports Jira Cloud v3 ADF bodies and falls back to Jira Server v2 search', async () => {
    const jira = createJiraSource({
      fetch: async (input) => {
        const url = String(input)
        if (url.includes('/rest/api/3/search/jql')) {
          return new Response('not found', { status: 404 })
        }
        if (url.includes('/rest/api/2/search')) {
          return jsonResponse({
            issues: [
              {
                key: 'PROJ-108',
                fields: {
                  summary: 'Unify task contract verification',
                  updated: '2026-11-12T07:00:00.000+0000',
                  status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
                  issuetype: { name: 'Task' },
                  priority: { name: 'High' }
                }
              }
            ]
          })
        }
        if (url.includes('/rest/api/3/issue/PROJ-108')) {
          return jsonResponse({
            key: 'PROJ-108',
            fields: {
              summary: 'Unify task contract verification',
              status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
              issuetype: { name: 'Task' },
              priority: { name: 'High' },
              description: {
                type: 'doc',
                content: [
                  { type: 'paragraph', content: [{ type: 'text', text: 'Verify acceptance criteria automatically.' }] }
                ]
              },
              comment: {
                comments: [
                  {
                    author: { displayName: 'QA Bot' },
                    body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'All checks green.' }] }] }
                  }
                ]
              }
            }
          })
        }
        throw new Error(`unexpected Jira URL: ${url}`)
      }
    })

    expect(jira.normalizeKey?.('https://jira.corp.local/browse/proj-108?filter=1')).toBe('PROJ-108')
    const envCred = jira.envCredential?.({ CONCLAVE_JIRA_EMAIL: 'dev@corp.local', CONCLAVE_JIRA_TOKEN: 'secret' })
    expect(envCred).toEqual({ kind: 'basic', payload: { email: 'dev@corp.local', token: 'secret' } })

    const settings = await jira.normalizeSettings({ site: 'jira.corp.local' })
    const credential = { kind: 'bearer', payload: { token: 'pat_123' } }
    const list = await jira.list(settings, credential, new AbortController().signal)
    expect(list).toMatchObject([
      { key: 'PROJ-108', statusCategory: 'doing', priority: 'High', type: 'Task' }
    ])

    const detail = await jira.fetch(settings, credential, 'PROJ-108', new AbortController().signal)
    expect(detail.markdown).toContain('Verify acceptance criteria automatically.')
    expect(detail.markdown).toContain('QA Bot')
    expect(detail.markdown).toContain('All checks green.')
  })
})
