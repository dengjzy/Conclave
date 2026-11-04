import { useState } from 'react'
import { agentCallOpen, type AgentCall, type Conversation } from '@conclave/protocol'
import { perform } from '../core-store'
import { t } from '../i18n'
import { agentLabel, chatDayAndTime } from '../labels'
import { workedFor } from '../chat-tools'
import { AgentIcon, CheckIcon, ChevronDownIcon, ClockIcon, CloseIcon, WarningIcon } from './icons'
import { openAgentCall, useAgentCalls } from '../agent-calls'
import { Spinner } from './Spinner'
import { ChatMarkdown } from './ChatMarkdown'
import './agent-calls.css'

function DelegationTopology({
  conversation,
  calls,
  cancelling,
  onCancel
}: {
  conversation: Conversation
  calls: readonly AgentCall[]
  cancelling: readonly string[]
  onCancel: (call: AgentCall) => void
}) {
  const [expandedCalls, setExpandedCalls] = useState<Record<string, boolean>>({})
  const toggleExpand = (id: string) => {
    setExpandedCalls((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  const working = calls.filter(agentCallOpen).length

  return (
    <div className="delegation-topology" role="region" aria-label={t('AgentProfiles.viewTopology')}>
      <div className="delegation-topology-root" data-working={working > 0 || undefined}>
        <div className="delegation-topology-root-avatar">
          <AgentIcon agent={conversation.agent} />
        </div>
        <div className="delegation-topology-root-info">
          <strong className="delegation-topology-root-title">
            {conversation.title || t('AgentProfiles.mainConversation')}
          </strong>
          <span className="delegation-topology-root-subtitle muted">
            {agentLabel(conversation.agent)} · {t('AgentProfiles.topologyRoot')}
          </span>
        </div>
        {working > 0 && (
          <span className="delegation-topology-live-pill" data-state="running">
            <Spinner />
            <span>{t('AgentProfiles.running')}</span>
          </span>
        )}
      </div>

      <div className="delegation-topology-tree">
        {calls.map((call) => {
          const active = call.state === 'running' || call.state === 'starting'
          const open = agentCallOpen(call)
          const isExpanded = Boolean(expandedCalls[call.id])
          const duration = workedFor(Math.max(0, (open ? Date.now() : call.updatedAt) - call.createdAt))

          return (
            <div
              key={call.id}
              className="delegation-topology-branch"
              data-state={call.state}
              data-active={active || undefined}
            >
              <span className="delegation-topology-node" data-state={call.state} aria-hidden="true">
                {call.state === 'completed' ? (
                  <CheckIcon />
                ) : call.state === 'awaiting' || call.state === 'failed' ? (
                  <WarningIcon />
                ) : call.state === 'cancelled' ? (
                  <CloseIcon />
                ) : call.state === 'queued' ? (
                  <ClockIcon />
                ) : (
                  <span className="delegation-topology-dot" />
                )}
              </span>

              <article
                className="delegation-topology-card"
                data-state={call.state}
                data-active={active || undefined}
                data-expanded={isExpanded || undefined}
              >
                <div className="delegation-topology-card-header">
                  <div className="delegation-topology-card-agent">
                    <AgentIcon agent={call.profile.agent} />
                    <strong>{call.profile.name}</strong>
                  </div>
                  <span className="delegation-status" data-state={call.state}>
                    {t(`AgentProfiles.${call.state}`)}
                  </span>
                </div>

                <div className="delegation-topology-card-meta">
                  <time dateTime={new Date(call.createdAt).toISOString()}>{chatDayAndTime(call.createdAt)}</time>
                  <span aria-hidden="true">·</span>
                  <span className="muted">{duration}</span>
                </div>

                <button
                  type="button"
                  className="delegation-topology-instruction-preview"
                  onClick={() => toggleExpand(call.id)}
                  title={call.instruction}
                >
                  <span>{call.instruction.split('\n').filter((l) => l.trim()).slice(0, 2).join(' · ')}</span>
                  <span className={`delegation-expand-icon ${isExpanded ? 'open' : ''}`}>
                    <ChevronDownIcon />
                  </span>
                </button>

                {call.error && <p className="modal-error" role="status">{call.error}</p>}

                {call.result && !isExpanded && (
                  <div
                    className="delegation-topology-result-preview"
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleExpand(call.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleExpand(call.id) }}
                  >
                    <CheckIcon />
                    <p>{call.result.split('\n').filter((l) => l.trim())[0] ?? call.result}</p>
                  </div>
                )}

                {isExpanded && (
                  <div className="delegation-topology-expanded">
                    <section className="delegation-topology-section">
                      <h4>{t('AgentProfiles.instruction')}</h4>
                      <p className="delegation-topology-full-instruction">{call.instruction}</p>
                    </section>
                    {call.result && (
                      <section className="delegation-topology-section">
                        <h4>{t('AgentProfiles.result')}</h4>
                        <div className="delegation-topology-full-result">
                          <ChatMarkdown text={call.result} />
                        </div>
                      </section>
                    )}
                  </div>
                )}

                <footer className="delegation-topology-card-actions">
                  {call.state !== 'queued' && call.state !== 'starting' && (
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => void openAgentCall(call)}
                    >
                      {t('AgentProfiles.openConversation')}
                    </button>
                  )}
                  {open && (
                    <button
                      type="button"
                      className="link-button"
                      disabled={cancelling.includes(call.id)}
                      onClick={() => onCancel(call)}
                    >
                      {t('AgentProfiles.cancelCall')}
                    </button>
                  )}
                </footer>
              </article>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function AgentCalls({ conversation }: { conversation: Conversation }) {
  const { calls, error } = useAgentCalls(conversation.id)
  const [cancelling, setCancelling] = useState<string[]>([])
  const [viewMode, setViewMode] = useState<'topology' | 'timeline'>('topology')
  const parentId = conversation.id
  const cancel = async (call: AgentCall) => {
    setCancelling((items) => [...items, call.id])
    await perform((rpc) => rpc.call('agentCalls.cancel', { id: parentId, callId: call.id }))
    setCancelling((items) => items.filter((id) => id !== call.id))
  }
  const working = calls?.filter(agentCallOpen).length ?? 0
  const ordered = [...(calls ?? [])].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
  return (
    <section className="delegation-panel" aria-label={t('AgentProfiles.calls')}>
      <header className="delegation-panel-header">
        <div className="delegation-header-title">
          <strong>{t('AgentProfiles.history')}</strong>
          <span className="muted">{calls?.length ?? 0}{working > 0 && ` · ${t('AgentProfiles.running')} ${working}`}</span>
        </div>
        {ordered.length > 0 && (
          <div className="delegation-view-modes" role="tablist" aria-label={t('AgentProfiles.viewMode')}>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'topology'}
              className={`delegation-view-tab ${viewMode === 'topology' ? 'active' : ''}`}
              onClick={() => setViewMode('topology')}
            >
              {t('AgentProfiles.viewTopology')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'timeline'}
              className={`delegation-view-tab ${viewMode === 'timeline' ? 'active' : ''}`}
              onClick={() => setViewMode('timeline')}
            >
              {t('AgentProfiles.viewTimeline')}
            </button>
          </div>
        )}
      </header>
      {error && <p className="inspector-empty" role="alert">{error}</p>}
      {!error && calls === null && <p className="inspector-empty muted">{t('AgentProfiles.loadingCalls')}</p>}
      {calls?.length === 0 && <p className="inspector-empty muted">{t('AgentProfiles.noCalls')}</p>}
      {ordered.length > 0 && (
        viewMode === 'topology' ? (
          <DelegationTopology
            conversation={conversation}
            calls={ordered}
            cancelling={cancelling}
            onCancel={(call) => void cancel(call)}
          />
        ) : (
          <ol className="delegation-timeline" aria-label={t('AgentProfiles.history')}>
            {ordered.map((call) => (
              <li className="delegation-timeline-item" key={call.id} data-state={call.state} data-active={call.state === 'running' || call.state === 'starting' || undefined}>
                <span className="delegation-timeline-node" aria-hidden="true">
                  {call.state === 'completed' ? <CheckIcon /> : call.state === 'awaiting' || call.state === 'failed' ? <WarningIcon /> : call.state === 'cancelled' ? <CloseIcon /> : call.state === 'queued' ? <ClockIcon /> : <span className="delegation-timeline-dot" />}
                </span>
                <article className="delegation-record">
                  <div className="delegation-record-head">
                    <AgentIcon agent={call.profile.agent} />
                    <strong>{call.profile.name}</strong>
                    <span className="delegation-status" data-state={call.state}>{t(`AgentProfiles.${call.state}`)}</span>
                  </div>
                  <time className="muted" dateTime={new Date(call.createdAt).toISOString()}>{chatDayAndTime(call.createdAt)}</time>
                  <details className="delegation-instruction">
                    <summary title={call.instruction}>{call.instruction.split('\n').filter((line) => line.trim()).slice(0, 2).join(' · ')}</summary>
                    <p>{call.instruction}</p>
                  </details>
                  {call.result && (
                    <details className="delegation-result">
                      <summary>{t('AgentProfiles.result')}</summary>
                      <p>{call.result}</p>
                    </details>
                  )}
                  {call.error && <p className="modal-error" role="status">{call.error}</p>}
                  <footer className="delegation-record-actions">
                    {call.state !== 'queued' && call.state !== 'starting' && (
                      <button type="button" className="link-button" onClick={() => void openAgentCall(call)}>
                        {t('AgentProfiles.openConversation')}
                      </button>
                    )}
                    {agentCallOpen(call) && (
                      <button type="button" className="link-button" disabled={cancelling.includes(call.id)} onClick={() => void cancel(call)}>
                        {t('AgentProfiles.cancelCall')}
                      </button>
                    )}
                  </footer>
                </article>
              </li>
            ))}
          </ol>
        )
      )}
    </section>
  )
}
