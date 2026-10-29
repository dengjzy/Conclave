import { localized, t, tr } from '../i18n'
import { useEffect, useState } from 'react'
import type { ChatItem } from '@conclave/protocol'
import { formatTokens, isSubagent, workedFor } from '../chat-tools'
import { useTick } from '../chat-motion'
import { itemKey } from '../chat-state'
import { backgroundLabel, bareCommand, isBackgroundCommand, limitAt, limitText, LIMIT_SOON_MS } from '../background-work'
import { ChatToolIcon } from './ChatToolIcon'
import { Popover } from './Popover'
import { BackgroundStopButton } from './BackgroundStopButton'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

// What kind of thing the agent is at, when nothing more specific is known.
export type WorkingPhase = 'tools' | 'thinking' | 'replying' | 'waiting' | 'asking' | 'working'
const PHASE: Record<WorkingPhase, string> = localized(() => ({ tools: t('ChatWorking.runningTools'), thinking: t('chatTools.thinking'), replying: t('ChatWorking.writingReply'), waiting: t('chatTools.wait'), asking: t('ChatWorking.waitingForYourAnswer'), working: t('ChatWorking.processing') }))

// What the agent is at, at a glance: thinking, running a tool, writing the reply, waiting on work it
// left in the background, or on the user. Keyed by phase, so each starts its motion afresh. The
// brain is Lucide's (ISC licence).
function PhaseIcon({ phase }: { phase: WorkingPhase }) {
  const icon = (() => {
    switch (phase) {
      case 'tools':
        return (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor">
            <circle className="chat-working-gear-teeth" cx="8" cy="8" r="5.6" strokeWidth="2.2" />
            <circle cx="8" cy="8" r="4.1" strokeWidth="1.3" />
            <circle cx="8" cy="8" r="1.4" strokeWidth="1.2" />
          </svg>
        )
      case 'replying':
        return (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path className="chat-working-line" d="M2.5 4h11" />
            <path className="chat-working-line" d="M2.5 8h11" />
            <path className="chat-working-line" data-short="" d="M2.5 12h7" />
          </svg>
        )
      case 'waiting':
        return (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round">
            <path d="M4 2h8M4 14h8M5 2c0 3 3 4 3 6s-3 3-3 6M11 2c0 3-3 4-3 6s3 3 3 6" />
            <path d="M6.2 12.8 8 11l1.8 1.8Z" fill="currentColor" stroke="none" />
          </svg>
        )
      case 'asking':
        return <span className="chat-working-ask" />
      default:
        return (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
            <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
            <path d="M17.599 6.5a3 3 0 0 0 .399-1.375M6.003 5.125A3 3 0 0 0 6.401 6.5M3.477 10.896a4 4 0 0 1 .585-.396M19.938 10.5a4 4 0 0 1 .585.396M6 18a4 4 0 0 1-1.967-.516M19.967 17.484A4 4 0 0 1 18 18" />
            <path className="chat-working-signal" d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
            <circle className="chat-working-spark" cx="7" cy="9" r="1.3" stroke="none" />
            <circle className="chat-working-spark" cx="17" cy="9.5" r="1.3" stroke="none" />
            <circle className="chat-working-spark" cx="12" cy="15.5" r="1.3" stroke="none" />
          </svg>
        )
    }
  })()
  return <span key={phase} className="chat-working-icon" data-phase={phase} aria-hidden="true">{icon}</span>
}

// What runs in the background, a row each: what it is, how long it has run, the command itself, and
// when its time limit falls where the agent set one. A row leads to the call in the conversation,
// and stops it where the agent lets the chat do that.
function BackgroundList({ tools, now, onPick }: { tools: readonly ToolItem[]; now: number; onPick: (tool: ToolItem) => void }) {
  return (
    <div className="background-list">
      <div className="menu-label">{t('backgroundWork.listTitle')}</div>
      {tools.map((tool) => {
        const command = isBackgroundCommand(tool)
        const at = command ? limitAt(tool) : null
        const limit = at === null ? null : limitText(at, now)
        return (
          <div key={itemKey(tool)} className="background-item">
            <button type="button" className="background-row" onClick={() => onPick(tool)}>
              <ChatToolIcon name={tool.name} display={tool.display} status="running" />
              <span className="background-row-title">{backgroundLabel(tool)}</span>
              <span className="background-row-time">{t('backgroundWork.ranFor', { time: workedFor(Math.max(0, now - tool.at)) })}</span>
              {command && <span className="background-row-command mono">{bareCommand(tool.input ?? tool.title)}</span>}
              {limit && <span className="background-row-limit" data-soon={limit.soon || undefined}>{limit.text}</span>}
            </button>
            <BackgroundStopButton tool={tool} />
          </div>
        )
      })}
      <div className="background-list-hint">{t('backgroundWork.listHint')}</div>
    </div>
  )
}

// While a turn runs, at the end of the conversation: the numbers that say how it goes, as Claude
// Code's own status reads: how long, how many tokens written, how many subagents out, and what
// kind of step this is. What the agent is at shows in the conversation itself, just above. The
// clock ticks for the eye only; a screen reader hears the phase, not every second. What runs in the
// background is named: the one thing itself, or a list of them, each leading to its call.
export function ChatWorking({ phase, tokens, background, since, onReveal }: {
  phase: WorkingPhase
  // Output tokens the turn has written so far, where the agent reports them as it goes.
  tokens: number | null
  // What works in the background: subagents, and commands run there.
  background: readonly ToolItem[]
  since: number | null
  onReveal: (tool: ToolItem) => void
}) {
  const [started] = useState(() => since ?? Date.now())
  const [now, setNow] = useState(() => Date.now())
  const [listing, setListing] = useState(false)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const subagents = background.filter((tool) => isSubagent(tool.name)).length
  const commands = background.length - subagents
  // With the turn over and only background work out, it is the step: "后台运行中：2 个子 Agent、1 个命令".
  // While the turn itself runs, it is a count beside its step.
  const out = [
    subagents > 0 ? t('ChatWorking.subAgents', { value1: subagents }) : null,
    commands > 0 ? t('ChatWorking.commands', { value1: commands }) : null
  ].filter((part): part is string => part !== null).join('、')
  const waiting = phase === 'waiting' && out !== ''
  const only = background.length === 1 ? background[0] : undefined
  // The nearest time limit, once it is close enough to warn of.
  const nearest = Math.min(...background.filter(isBackgroundCommand).map(limitAt).filter((at): at is number => at !== null))
  const soon = Number.isFinite(nearest) && nearest - now <= LIMIT_SOON_MS ? limitText(nearest, now).text : null
  const named = only
    ? <button type="button" className="chat-working-link" title={isBackgroundCommand(only) ? bareCommand(only.input ?? only.title) : undefined} onClick={() => onReveal(only)}>{backgroundLabel(only)}</button>
    : (
      <span className="menu-anchor">
        <button type="button" className="chat-working-link" aria-haspopup="dialog" aria-expanded={listing} onClick={() => setListing(!listing)}>{out}</button>
        {listing && (
          <Popover label={t('backgroundWork.listTitle')} onClose={() => setListing(false)}>
            <BackgroundList tools={background} now={now} onPick={(tool) => { setListing(false); onReveal(tool) }} />
          </Popover>
        )}
      </span>
    )
  // The count of tokens ticks up as the agent writes: each change lands with a small motion.
  const tick = useTick(tokens)
  const parts = [
    workedFor(Math.max(0, now - (since ?? started))),
    ...(tokens !== null && tokens > 0 ? [<>↓ <span key={tick ?? 0} className="chat-working-tick">{formatTokens(tokens)}</span></>] : [])
  ]
  return (
    <div className="chat-working" role="status">
      <PhaseIcon phase={phase} />
      {parts.map((part, index) => (
        <span key={index} className="chat-working-part" aria-hidden="true">
          {index > 0 && <span className="chat-working-dot">·</span>}
          {part}
        </span>
      ))}
      {out && !waiting && <span className="chat-working-part"><span className="chat-working-dot" aria-hidden="true">·</span>{tr('ChatWorking.background', { out: named })}</span>}
      <span className="chat-working-part">
        <span className="chat-working-dot" aria-hidden="true">·</span>
        {waiting
          ? <span className="chat-sheen chat-working-sheen">{tr('ChatWorking.runningInBackground', { out: named })}</span>
          : <span className={phase === 'asking' ? undefined : 'chat-sheen chat-working-sheen'}>{`${PHASE[phase]}${phase === 'asking' ? '' : t('ChatWorking.inProgressSuffix')}`}</span>}
      </span>
      {waiting && only && <span className="chat-working-part" aria-hidden="true"><span className="chat-working-dot">·</span>{t('backgroundWork.ranFor', { time: workedFor(Math.max(0, now - only.at)) })}</span>}
      {only && <BackgroundStopButton tool={only} />}
      {soon && <span className="chat-working-part chat-working-soon"><span className="chat-working-dot" aria-hidden="true">·</span>{soon}</span>}
    </div>
  )
}
