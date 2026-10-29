import { localized, t, tr } from '../i18n'
import { useState } from 'react'
import { DEFAULT_DISCUSSION_REQUIREMENTS, DEFAULT_DISCUSSION_ROUNDS, MAX_DISCUSSION_MEMBERS, MAX_DISCUSSION_ROUNDS, MIN_DISCUSSION_MEMBERS, type AgentKind, type Discussion } from '@conclave/protocol'
import { resolveModel, useAgentCatalog } from '../agent-models'
import { closeDiscussionDraft, selectDiscussion, useDiscussionRequirementsSupported } from '../core-store'
import { createDiscussion, defaultMemberName, loadDiscussionPosts } from '../discussions'
import { useInstalledAgents } from '../installed-agents'
import { agentLabel } from '../labels'
import { effortLabel } from './ChatOptionsBar'
import { ChatModelPicker, ChatPicker } from './ChatPicker'
import { AgentIcon, CloseIcon } from './icons'
import { ProjectPicker } from './ProjectPicker'
import { DiscussionRequirements } from './DiscussionRequirements'

// A member as picked: name is null while it follows the agent and model.
type Draft = { key: string; agent: AgentKind; model?: string; effort?: string; name: string | null; role: string }

const ROLE_HINTS = localized(() => ([t('DiscussionDraft.supporter'), t('DiscussionDraft.opponent'), t('DiscussionDraft.focusOnSecurityAndRisk'), t('DiscussionDraft.focusOnPerformanceAndCost'), t('DiscussionDraft.critic')]))

function MemberRow({ member, index, agents, chair, busy, removable, onChange, onRemove, onChair }: {
  member: Draft
  index: number
  agents: readonly AgentKind[]
  chair: boolean
  busy: boolean
  removable: boolean
  onChange: (next: Draft) => void
  onRemove: () => void
  onChair: () => void
}) {
  const catalog = useAgentCatalog(member.agent, true)
  const { model, effort } = resolveModel(catalog, { model: member.model, effort: member.effort })
  const shownName = member.name ?? defaultMemberName(member.agent, member.model ?? null)
  return (
    <li className="discussion-draft-member">
      <span className="discussion-draft-index">{String.fromCharCode(65 + index)}</span>
      <ChatPicker
        label="Agent"
        value={member.agent}
        placeholder="Agent"
        disabled={busy}
        options={agents.map((agent) => ({ value: agent, label: agentLabel(agent), icon: <AgentIcon agent={agent} /> }))}
        onChange={(value) => {
          const agent = agents.find((each) => each === value)
          if (agent) onChange({ ...member, agent, model: undefined, effort: undefined })
        }}
      />
      {!catalog && <span className="chat-options-note muted">{catalog === undefined ? t('AgentModelPicker.loadingModels') : t('ChatPicker.defaultModel')}</span>}
      {catalog && (
        <ChatModelPicker
          align="start"
          models={catalog.models.map((each) => ({ value: each.id, label: each.label, description: each.description, efforts: each.efforts.map((one) => ({ value: one, label: effortLabel(one) })) }))}
          model={model?.id ?? null}
          effort={effort ?? null}
          disabled={busy}
          onModel={(value) => {
            const next = catalog.models.find((each) => each.id === value)
            if (next) onChange({ ...member, model: next.id, effort: member.effort && next.efforts.includes(member.effort) ? member.effort : undefined })
          }}
          onEffort={(value) => onChange({ ...member, effort: value })}
        />
      )}
      <input
        className="discussion-draft-name"
        aria-label={t('DiscussionDraft.memberSNameUsedToMentionThem', { value1: index + 1 })}
        value={shownName}
        maxLength={60}
        disabled={busy}
        onChange={(event) => onChange({ ...member, name: event.target.value })}
        onBlur={() => { if (member.name !== null && !member.name.trim()) onChange({ ...member, name: null }) }}
      />
      <input
        className="discussion-draft-role"
        aria-label={t('DiscussionDraft.memberSPositionOrPerspective', { value1: index + 1 })}
        placeholder={t('DiscussionDraft.optionalEG', { value1: ROLE_HINTS[index % ROLE_HINTS.length] })}
        value={member.role}
        maxLength={2000}
        disabled={busy}
        onChange={(event) => onChange({ ...member, role: event.target.value })}
      />
      <label className="discussion-draft-chair" data-tooltip={t('DiscussionDraft.theChairSummarizesWhenTheDiscussionEnds')}>{tr('DiscussionDraft.chair', { value1: <input type="radio" name="discussion-chair" checked={chair} disabled={busy} onChange={onChair} /> })}</label>
      <button type="button" className="icon-button" aria-label={t('DiscussionDraft.removeMember', { value1: index + 1 })} data-tooltip={t('ChatQuoteCards.remove')} disabled={busy || !removable} onClick={onRemove}>
        <CloseIcon />
      </button>
    </li>
  )
}

// A new group chat: a topic, the projects its members may read, and who discusses it. One begun from
// another group starts with its members, projects and options, for a topic of its own.
export function DiscussionDraft({ from }: { from: Discussion | null }) {
  const installed = useInstalledAgents()
  const [mode, setMode] = useState<'fanout' | 'debate'>('fanout')
  const [topic, setTopic] = useState('')
  const requirementsSupported = useDiscussionRequirementsSupported()
  const [requirements, setRequirements] = useState(() => from?.requirements ?? DEFAULT_DISCUSSION_REQUIREMENTS)
  const [projectPaths, setProjectPaths] = useState<string[]>(() => from?.projectPaths ?? [])
  const [members, setMembers] = useState<Draft[]>(() => {
    if (from) {
      return from.members.map((member) => ({
        key: crypto.randomUUID(), agent: member.agent, model: member.model ?? undefined, effort: member.effort ?? undefined, name: member.name, role: member.role
      }))
    }
    // Default: select available installed agents for quick comparison
    const initialAgents = installed.slice(0, 3)
    if (initialAgents.length >= 2) {
      return initialAgents.map((agent) => ({
        key: crypto.randomUUID(), agent, name: null, role: ''
      }))
    }
    const first = installed[0] ?? 'claude'
    const second = installed[1] ?? first
    return [
      { key: crypto.randomUUID(), agent: first, name: null, role: '' },
      { key: crypto.randomUUID(), agent: second, name: null, role: '' }
    ]
  })
  const [chair, setChair] = useState(() => Math.max(0, from?.members.findIndex((member) => member.id === from.chairId) ?? 0))
  const [rounds, setRounds] = useState(from?.maxRounds ?? 1)
  const [anonymous, setAnonymous] = useState(from?.anonymous ?? false)
  const [busy, setBusy] = useState(false)
  // Names in use more than once would make @ ambiguous.
  const names = members.map((member) => (member.name ?? defaultMemberName(member.agent, member.model ?? null)).trim())
  const clash = names.find((name, index) => names.indexOf(name) !== index)
  const canStart = !busy && topic.trim() !== '' && members.length >= MIN_DISCUSSION_MEMBERS && !clash && names.every(Boolean)

  const update = (index: number, next: Draft) => setMembers(members.map((each, at) => (at === index ? next : each)))
  const add = () => setMembers([...members, { key: crypto.randomUUID(), agent: installed[members.length % Math.max(installed.length, 1)] ?? 'claude', name: null, role: '' }])
  const remove = (index: number) => {
    setMembers(members.filter((_, at) => at !== index))
    setChair((current) => (current === index ? 0 : current > index ? current - 1 : current))
  }
  const toggleAgent = (agent: AgentKind) => {
    const existingIndex = members.findIndex((m) => m.agent === agent)
    if (existingIndex >= 0) {
      if (members.length > MIN_DISCUSSION_MEMBERS) {
        remove(existingIndex)
      }
    } else {
      if (members.length < MAX_DISCUSSION_MEMBERS) {
        setMembers([...members, { key: crypto.randomUUID(), agent, name: null, role: '' }])
      }
    }
  }

  const start = async () => {
    if (!canStart) return
    setBusy(true)
    const created = await createDiscussion({
      topic: topic.trim(),
      ...(requirementsSupported ? { requirements: requirements.trim() } : {}),
      projectPaths,
      members: members.map((member, index) => ({
        agent: member.agent,
        ...(member.model ? { model: member.model } : {}),
        ...(member.effort ? { effort: member.effort } : {}),
        name: names[index] ?? agentLabel(member.agent),
        role: member.role.trim()
      })),
      chair,
      maxRounds: rounds,
      anonymous
    })
    setBusy(false)
    if (!created) return
    void loadDiscussionPosts(created.id)
    selectDiscussion(created.id)
  }

  return (
    <section className="detail terminal-view discussion-view" aria-label={mode === 'fanout' ? '并发提问' : t('DiscussionDraft.newGroupChat')}>
      <header className="detail-header conversation-header">
        <span className="terminal-view-title">{mode === 'fanout' ? '并发提问' : '多轮讨论'}</span>
        <div className="toolbar">
          <button type="button" className="tool-button" aria-label={t('BackdropPicker.close')} data-tooltip={t('BackdropPicker.close')} onClick={closeDiscussionDraft}><CloseIcon /></button>
        </div>
      </header>
      <div className="discussion-draft">
        <div className="discussion-draft-mode-tabs" role="tablist">
          <button
            type="button"
            className={`discussion-mode-tab ${mode === 'fanout' ? 'active' : ''}`}
            onClick={() => {
              setMode('fanout')
              setRounds(1)
            }}
          >
            并发提问
          </button>
          <button
            type="button"
            className={`discussion-mode-tab ${mode === 'debate' ? 'active' : ''}`}
            onClick={() => {
              setMode('debate')
              if (rounds < 2) setRounds(DEFAULT_DISCUSSION_ROUNDS)
            }}
          >
            多轮讨论
          </button>
        </div>

        {from && <p className="discussion-draft-from">{tr('DiscussionDraft.reuseMembersProjectsAndSettingsFromEachMember', { value1: from.title })}</p>}
        <p className="muted">
          {mode === 'fanout'
            ? '选中的 Agent 将同时接收并回答相同问题，便于对比回答。'
            : '选中的 Agent 共同参与多轮讨论，可互相审阅与补充。'}
        </p>

        {mode === 'fanout' && (
          <div className="fanout-agent-chips">
            <span className="fanout-chips-label">选择参与的 Agent：</span>
            <div className="fanout-chips-row">
              {installed.map((agent) => {
                const isSelected = members.some((m) => m.agent === agent)
                return (
                  <button
                    key={agent}
                    type="button"
                    className={`fanout-agent-chip ${isSelected ? 'selected' : ''}`}
                    disabled={busy}
                    onClick={() => toggleAgent(agent)}
                  >
                    <AgentIcon agent={agent} />
                    <span>{agentLabel(agent)}</span>
                    <span className="chip-check">{isSelected ? '✓' : '+'}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <label className="discussion-draft-field">
          <span>{mode === 'fanout' ? '提问内容' : t('DiscussionDraft.topic')}</span>
          <textarea
            className="discussion-draft-topic"
            rows={4}
            autoFocus
            value={topic}
            disabled={busy}
            placeholder={mode === 'fanout' ? '输入你想提问的问题或任务要求...' : '输入讨论议题或任务背景...'}
            onChange={(event) => setTopic(event.target.value)}
          />
        </label>
        {requirementsSupported && mode === 'debate' && <DiscussionRequirements value={requirements} onChange={setRequirements} disabled={busy} />}
        <div className="discussion-draft-field">
          <span>{t('DiscussionDraft.projectsOptional')}</span>
          <ProjectPicker projects={projectPaths.map((path) => ({ path, worktreePath: null }))} onChange={setProjectPaths} locked={busy} />
        </div>
        <div className="discussion-draft-field">
          <span>{mode === 'fanout' ? '已选成员与模型' : t('DiscussionDraft.members')}</span>
          <ul className="discussion-draft-members">
            {/* What each column of a member is: the name most of all, as it is what @ picks it by. */}
            <li className="discussion-draft-member discussion-draft-member-head" aria-hidden="true">
              <span />
              <span>Agent</span>
              <span>{t('AgentModelPicker.model')}</span>
              <span>{t('DiscussionDraft.nameForMentions')}</span>
              <span>{t('DiscussionDraft.positionOrPerspective')}</span>
              <span />
              <span />
            </li>
            {members.map((member, index) => (
              <MemberRow
                key={member.key}
                member={member}
                index={index}
                agents={installed}
                chair={chair === index}
                busy={busy}
                removable={members.length > MIN_DISCUSSION_MEMBERS}
                onChange={(next) => update(index, next)}
                onRemove={() => remove(index)}
                onChair={() => setChair(index)}
              />
            ))}
          </ul>
          {members.length < MAX_DISCUSSION_MEMBERS && (
            <button type="button" className="link-button discussion-draft-add" disabled={busy} onClick={add}>{t('DiscussionDraft.addMember')}</button>
          )}
          {clash && <p className="discussion-draft-error">{tr('DiscussionDraft.twoMembersAreNamedRenameOneSoThey', { clash: clash })}</p>}
        </div>
        <div className="discussion-draft-options">
          <span className="discussion-draft-rounds">{tr('DiscussionDraft.upToSummarizeEarlyWhenPositionsRemainUnchanged', { value1: <ChatPicker
              label={t('DiscussionDraft.maximumRounds')}
              value={String(rounds)}
              placeholder={t('DiscussionDraft.rounds', { rounds: rounds })}
              placement="above"
              disabled={busy}
              options={Array.from({ length: MAX_DISCUSSION_ROUNDS }, (_, index) => ({ value: String(index + 1), label: t('DiscussionDraft.rounds_823', { value1: index + 1 }) }))}
              onChange={(value) => setRounds(Number(value))}
            /> })}</span>
          <label data-tooltip={t('DiscussionDraft.useMemberABWithoutRevealingAgentOr')}>{tr('DiscussionDraft.anonymousPeerReview', { value1: <input type="checkbox" checked={anonymous} disabled={busy} onChange={(event) => setAnonymous(event.target.checked)} /> })}</label>
          <span className="chat-dock-spacer" />
          <button type="button" className="button primary" disabled={!canStart} onClick={() => void start()}>
            {busy ? t('DiscussionDraft.starting') : mode === 'fanout' ? '开始提问' : t('DiscussionDraft.startDiscussion')}
          </button>
        </div>
      </div>
    </section>
  )
}
