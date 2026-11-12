import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StateCreator } from 'zustand'
import { createRpcClient, Task, type RpcConnection, type SourceDescriptor, type SourceInbox, type SourceIssue } from '@conclave/protocol'
import { useCore } from '../core-store'
import { SidebarTasks } from './SidebarTasks'
import { setAgendaChannel, TaskBoard } from './TaskBoard'

vi.mock('zustand', async (importOriginal) => {
  const zustand = await importOriginal<typeof import('zustand')>()
  return {
    ...zustand,
    create: <T>() => (initializer: StateCreator<T>) => {
      const store = zustand.create(initializer)
      return Object.assign(
        (selector?: (state: T) => unknown) => (selector ? selector(store.getState()) : store.getState()),
        store
      )
    }
  }
})

const now = Date.UTC(2026, 10, 12, 12, 0, 0)

function makeSource(provider: string, name: string, configured: boolean): SourceDescriptor {
  return {
    provider,
    name,
    settings: [
      { key: 'query', type: 'text', label: '筛选条件', required: true, default: 'involves:@me' }
    ],
    instances: [
      {
        instance: 'default',
        enabled: true,
        settings: { query: 'involves:@me' },
        credential: { configured, source: configured ? 'env' : null, account: null }
      }
    ]
  }
}

function makeIssue(key: string, type: 'Issue' | 'PR' | 'MR', title: string): SourceIssue {
  return {
    key,
    title,
    url: `https://example.com/${encodeURIComponent(key)}`,
    status: 'Open',
    statusCategory: 'todo',
    type,
    priority: 'P1',
    updatedAt: now,
    conversationId: null
  }
}

function makeInbox(provider: string, active: boolean, items: SourceIssue[]): SourceInbox {
  return {
    provider,
    instance: 'default',
    active,
    items,
    dismissed: [],
    refreshedAt: active ? now : null,
    refreshing: false,
    problem: null
  }
}

function connectWorkbench(): void {
  const client = createRpcClient(() => {})
  const rpc: RpcConnection = {
    ...client,
    features: ['plugins', 'evolution', 'source-investigate'],
    close: () => {},
    closed: new Promise(() => {})
  }
  const importedPr = Task.parse({
    id: 'gh-pr-task',
    title: 'Fix daemon socket reconnect',
    details: '',
    status: 'running',
    agent: 'codex',
    repos: [{ path: '/work/conclave', worktreePath: null, branch: 'feat/fix' }],
    dependsOn: [],
    source: {
      provider: 'github',
      instance: 'default',
      name: 'GitHub',
      key: 'acme/conclave#10',
      url: 'https://github.com/acme/conclave/pull/10'
    },
    createdAt: now,
    updatedAt: now
  })
  const localReview = Task.parse({
    id: 'local-1',
    title: 'Unify agenda navigation',
    details: '',
    status: 'review',
    awaitingInput: true,
    agent: 'claude',
    repos: [{ path: '/work/conclave', worktreePath: null, branch: null }],
    dependsOn: [],
    createdAt: now,
    updatedAt: now
  })

  useCore.setState({
    connection: 'connected',
    attentionSummaryMode: 'complete',
    rpc,
    tasks: { [importedPr.id]: importedPr, [localReview.id]: localReview },
    sources: [
      makeSource('github', 'GitHub', true),
      makeSource('gitlab', 'GitLab', true),
      makeSource('jira', 'Jira', false)
    ],
    inboxes: {
      'github/default': makeInbox('github', true, [
        makeIssue('acme/conclave#42', 'PR', 'Add GitLab MR channel'),
        makeIssue('acme/conclave#43', 'Issue', 'Support Jira Cloud v3')
      ]),
      'gitlab/default': makeInbox('gitlab', true, [
        makeIssue('platform/conclave!21', 'MR', 'Refine Agenda workbench')
      ]),
      'jira/default': makeInbox('jira', false, [])
    },
    evolutionStatus: {
      stagingBranch: 'self/evolve',
      baseCommit: 'ceb6f7901234',
      openFrictionCount: 2,
      activeGeneration: null,
      items: [],
      recentGenerations: []
    }
  })
}

beforeEach(() => {
  useCore.setState(useCore.getInitialState(), true)
  setAgendaChannel('all')
})

describe('unified Agenda workbench', () => {
  it('renders unified Agenda sidebar entry counting both attention items and synced remote items', () => {
    connectWorkbench()
    const html = renderToStaticMarkup(createElement(SidebarTasks))
    expect(html).toContain('>事项</span>')
    expect(html).not.toContain('>任务</span>')
    // 1 task in review + 2 GitHub items + 1 GitLab MR = 4
    expect(html).toContain('>4</span>')
  })

  it('renders all built-in channels, plugin slot, self-evolution tab, and remote banner on the Agenda board', () => {
    connectWorkbench()
    const html = renderToStaticMarkup(createElement(TaskBoard))
    expect(html).toContain('<h2>事项</h2>')
    expect(html).toContain('>全部</span>')
    expect(html).toContain('>本地事项</span>')
    expect(html).toContain('>GitHub</span>')
    expect(html).toContain('>GitLab</span>')
    expect(html).toContain('>Jira</span>')
    expect(html).toContain('>自我迭代</span>')
    expect(html).toContain('＋ 接入更多渠道')
    expect(html).toContain('远程渠道有 3 项待立项：')
    expect(html).toContain('GitHub · acme/conclave#10')
  })

  it('renders remote PR/Issue queue and tracked items together when a connected channel is selected', () => {
    connectWorkbench()
    setAgendaChannel('source:github')
    const html = renderToStaticMarkup(createElement(TaskBoard))
    expect(html).toContain('远程待立项 (2)')
    expect(html).toContain('>PR</span>')
    expect(html).toContain('acme/conclave#42')
    expect(html).toContain('>立项执行</button>')
    expect(html).toContain('>收入待办</button>')
    expect(html).toContain('>会话排查</button>')
    expect(html).toContain('已立项推进 (1)')
    expect(html).toContain('Fix daemon socket reconnect')
  })

  it('renders inline connection card when an unconfigured channel such as Jira is selected', () => {
    connectWorkbench()
    setAgendaChannel('source:jira')
    const html = renderToStaticMarkup(createElement(TaskBoard))
    expect(html).toContain('接入 Jira 事项流')
    expect(html).toContain('未连接')
    expect(html).toContain('>登录</button>')
  })
})
