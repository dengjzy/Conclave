import { useState, type ReactNode } from 'react'
import { DEFAULT_INSTANCE, type SourceDescriptor, type SourceInbox, type SourceIssue } from '@conclave/protocol'
import { getLocale, t, tr } from '../i18n'
import { openConversationDraft, perform, selectConversation, selectTask, useCore, useSourceInvestigateSupported } from '../core-store'
import { defaultAgent } from '../default-agent'
import { sourceProblemText } from '../labels'
import { inboxKey, investigationProjects } from '../source-inboxes'
import { GearIcon, RefreshIcon } from './icons'
import { SourceSettingsSection } from './SourceSettingsSection'

function syncClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit', hour12: false })
}

function updatedLabel(ms: number): string {
  const date = new Date(ms)
  const day = t('SourceInboxView.monthAndDay', { value1: date.getMonth() + 1, value2: date.getDate() })
  return date.getFullYear() === new Date().getFullYear() ? day : t('SourceInboxView._1782', { value1: date.getFullYear(), day })
}

function channelHint(provider: string): string {
  if (provider === 'github') return t('Agenda.connectGithubHint')
  if (provider === 'gitlab') return t('Agenda.connectGitlabHint')
  if (provider === 'jira') return t('Agenda.connectJiraHint')
  return t('Agenda.connectGenericHint')
}

function RemoteIssueRow({
  issue,
  sourceName,
  busy,
  investigating,
  children
}: {
  issue: SourceIssue
  sourceName: string
  busy: boolean
  investigating: boolean
  children: ReactNode
}) {
  const isReviewRequest = issue.type === 'PR' || issue.type === 'MR'
  return (
    <li className="inbox-row agenda-remote-row" aria-busy={busy || undefined}>
      <div className="inbox-row-text">
        <div className="inbox-row-meta">
          {issue.type && (
            <span className="agenda-kind-badge" data-kind={isReviewRequest ? 'review' : 'issue'}>
              {issue.type}
            </span>
          )}
          <a
            className="inbox-key"
            href={issue.url}
            target="_blank"
            rel="noreferrer"
            data-tooltip={t('SourceInboxView.openIn', { name: sourceName })}
            data-tooltip-align="start"
          >
            {issue.key}
          </a>
          {issue.priority && <span className="inbox-priority">{issue.priority}</span>}
          <span className="inbox-status" data-category={issue.statusCategory}>
            {issue.status}
          </span>
          {issue.updatedAt !== null && <span>{tr('SourceInboxView.updated', { value1: updatedLabel(issue.updatedAt) })}</span>}
          {investigating && <span className="inbox-investigating">{t('SourceInboxView.investigating')}</span>}
        </div>
        <div className="inbox-row-title">{issue.title}</div>
      </div>
      <div className="inbox-row-actions">{children}</div>
    </li>
  )
}

export function AgendaSourceChannel({
  source,
  inbox,
  query,
  trackedCount,
  trackedContent
}: {
  source: SourceDescriptor
  inbox: SourceInbox | undefined
  query: string
  trackedCount: number
  trackedContent: ReactNode
}) {
  const tasks = useCore((s) => s.tasks)
  const conversations = useCore((s) => s.conversations)
  const investigateSupported = useSourceInvestigateSupported()
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [showDismissed, setShowDismissed] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  const target = { provider: source.provider, instance: inbox?.instance ?? DEFAULT_INSTANCE }
  const active = Boolean(inbox?.active)
  const normalizedQuery = query.trim().toLowerCase()

  const matchesQuery = (issue: SourceIssue) =>
    !normalizedQuery ||
    issue.title.toLowerCase().includes(normalizedQuery) ||
    issue.key.toLowerCase().includes(normalizedQuery) ||
    (issue.type ?? '').toLowerCase().includes(normalizedQuery)

  const visibleItems = (inbox?.items ?? []).filter(matchesQuery)
  const dismissedItems = (inbox?.dismissed ?? []).filter(matchesQuery)

  const act = async (key: string, run: () => Promise<unknown>) => {
    setBusyKey(key)
    try {
      await run()
    } finally {
      setBusyKey(null)
    }
  }

  const importIssue = (key: string, openImmediately: boolean) =>
    act(key, async () => {
      const created = await perform((rpc) =>
        rpc.call('sources.import', { ...target, key, agent: defaultAgent(tasks, conversations) })
      )
      if (created && openImmediately) {
        selectTask(created.id)
      }
    })

  const investigate = (issue: SourceIssue) =>
    openConversationDraft(investigationProjects(inboxKey(target)), {
      provider: target.provider,
      instance: target.instance,
      key: issue.key,
      title: issue.title,
      url: issue.url,
      source: source.name
    })

  const lookedInto = (issue: SourceIssue) =>
    issue.conversationId && conversations[issue.conversationId] ? issue.conversationId : null

  const dismiss = (key: string) => act(key, () => perform((rpc) => rpc.call('sources.dismiss', { ...target, key })))
  const restore = (key: string) => act(key, () => perform((rpc) => rpc.call('sources.restore', { ...target, key })))
  const refresh = () => void perform((rpc) => rpc.call('sources.refresh', target))

  if (!active || !inbox) {
    return (
      <div className="agenda-channel-body">
        <section className="agenda-connect-card" aria-label={t('Agenda.connectTitle', { value1: source.name })}>
          <header className="agenda-connect-header">
            <div>
              <h3>{t('Agenda.connectTitle', { value1: source.name })}</h3>
              <p className="muted">{channelHint(source.provider)}</p>
            </div>
            <span className="agenda-status-pill" data-connected={undefined}>
              {t('Agenda.notConnected')}
            </span>
          </header>
          <SourceSettingsSection source={source} />
        </section>

        {trackedCount > 0 && (
          <section className="agenda-tracked-section">
            <h3 className="agenda-section-heading">{t('Agenda.importedBoard', { value1: trackedCount })}</h3>
            {trackedContent}
          </section>
        )}
      </div>
    )
  }

  return (
    <div className="agenda-channel-body">
      <section className="agenda-remote-section" aria-label={t('SourceInboxView.inbox', { name: source.name })}>
        <header className="agenda-remote-header">
          <div className="agenda-remote-title">
            <h3>{t('Agenda.remoteQueue', { value1: visibleItems.length })}</h3>
            <span className="agenda-status-pill" data-connected="true">
              {t('Agenda.connected')}
            </span>
          </div>
          <div className="toolbar">
            <span className="muted inbox-synced">
              {inbox.refreshing
                ? t('SourceInboxView.syncing')
                : inbox.refreshedAt !== null
                  ? t('SourceInboxView.sync', { value1: syncClock(inbox.refreshedAt) })
                  : ''}
            </span>
            <button
              type="button"
              className="tool-button"
              aria-label={t('SourceInboxView.syncNow')}
              data-tooltip={t('SourceInboxView.syncNow')}
              aria-busy={inbox.refreshing || undefined}
              onClick={refresh}
            >
              <RefreshIcon />
            </button>
            <button
              type="button"
              className="task-board-chip"
              aria-expanded={showSettings || Boolean(inbox.problem)}
              onClick={() => setShowSettings((open) => !open)}
            >
              <GearIcon />
              <span>{t('Agenda.configureFilter')}</span>
            </button>
          </div>
        </header>

        {(showSettings || Boolean(inbox.problem)) && (
          <div className="agenda-inline-settings">
            <SourceSettingsSection source={source} />
          </div>
        )}

        {inbox.problem && !showSettings && (
          <p className="inbox-error" role="alert">
            {tr('SourceInboxView.syncFailed_1794', {
              value1: sourceProblemText(inbox.problem),
              value2: (
                <button type="button" className="link-button" onClick={() => setShowSettings(true)}>
                  {t('SourceInboxView.checkSettings')}
                </button>
              )
            })}
          </p>
        )}

        {visibleItems.length > 0 ? (
          <ul className="inbox-list">
            {visibleItems.map((issue) => {
              const conversationId = lookedInto(issue)
              return (
                <RemoteIssueRow
                  key={issue.key}
                  issue={issue}
                  sourceName={source.name}
                  busy={busyKey === issue.key}
                  investigating={conversationId !== null}
                >
                  {conversationId && (
                    <button type="button" className="button primary" onClick={() => selectConversation(conversationId)}>
                      {t('SourceInboxView.viewConversation')}
                    </button>
                  )}
                  <button
                    type="button"
                    className={conversationId ? 'button' : 'button primary'}
                    disabled={busyKey !== null}
                    onClick={() => void importIssue(issue.key, true)}
                  >
                    {t('Agenda.importAndOpen')}
                  </button>
                  <button
                    type="button"
                    className="button"
                    disabled={busyKey !== null}
                    onClick={() => void importIssue(issue.key, false)}
                  >
                    {t('Agenda.importToBacklog')}
                  </button>
                  {investigateSupported && !conversationId && (
                    <button
                      type="button"
                      className="button"
                      disabled={busyKey !== null}
                      data-tooltip={t('SourceInboxView.openAReadOnlyConversationToInvestigateFix')}
                      onClick={() => investigate(issue)}
                    >
                      {t('SourceInboxView.investigateInChat')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="button ghost"
                    disabled={busyKey !== null}
                    onClick={() => void dismiss(issue.key)}
                  >
                    {t('SourceInboxView.dismiss')}
                  </button>
                </RemoteIssueRow>
              )
            })}
          </ul>
        ) : (
          <p className="inbox-empty">
            {inbox.refreshedAt !== null
              ? t('SourceInboxView.noNewIssuesAllMatchingIssuesHaveBeen')
              : inbox.problem
                ? t('SourceInboxView.issuesAppearHereAfterASuccessfulSync')
                : t('SourceInboxView.runningFirstSync')}
          </p>
        )}

        {dismissedItems.length > 0 && (
          <div className="inbox-dismissed">
            <button
              type="button"
              className="link-button"
              aria-expanded={showDismissed}
              onClick={() => setShowDismissed((current) => !current)}
            >
              {tr('SourceInboxView.dismissed', {
                value1: showDismissed ? t('ChatPlan.collapse') : t('EnvironmentNotice.view'),
                value2: dismissedItems.length
              })}
            </button>
            {showDismissed && (
              <ul className="inbox-list">
                {dismissedItems.map((issue) => (
                  <RemoteIssueRow key={issue.key} issue={issue} sourceName={source.name} busy={busyKey === issue.key} investigating={false}>
                    <button type="button" className="button" disabled={busyKey !== null} onClick={() => void restore(issue.key)}>
                      {t('SourceInboxView.restore')}
                    </button>
                  </RemoteIssueRow>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <section className="agenda-tracked-section">
        <h3 className="agenda-section-heading">{t('Agenda.importedBoard', { value1: trackedCount })}</h3>
        {trackedCount > 0 ? trackedContent : <p className="agenda-tracked-empty muted">{t('Agenda.importedEmpty')}</p>}
      </section>
    </div>
  )
}
