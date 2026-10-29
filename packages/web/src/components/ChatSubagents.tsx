import { t, tr } from '../i18n'
import { useContext, useId, useState } from 'react'
import type { ChatItem } from '@conclave/protocol'
import { ChatFindExpansion, useChosen } from '../chat-disclosure'
import { itemKey } from '../chat-state'
import { formatTokens, subagentBrief } from '../chat-tools'
import { durationText } from '../stat-format'
import { ChatMarkdown } from './ChatMarkdown'
import { CheckIcon } from './icons'
import { Spinner } from './Spinner'
import { ChatToolIcon } from './ChatToolIcon'
import { useJustFinished } from '../chat-motion'
import { ChatCopyRegion } from './ChatCopyRegion'
import { copyTextForItem } from '../message-copy'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

const failed = (tool: ToolItem) => tool.status === 'failed' || tool.status === 'denied' || tool.status === 'interrupted'
const wireStatus = (tool: ToolItem) => (failed(tool) ? 'failed' : tool.status === 'running' ? 'running' : 'done')

// The wires are drawn in a box 100 high, stretched over the lanes: every lane takes an equal share
// of the column, so a lane's middle is a fixed fraction of it and nothing needs measuring.
const WIRE_WIDTH = 72

// `finished` draws the tick in, for one that came back while the user watched.
function SubagentMark({ tool, finished }: { tool: ToolItem; finished: boolean }) {
  if (tool.status === 'running') return <Spinner label={t('ChatSubagents.stillRunningItsReportWillAppearHereWhen')} />
  if (failed(tool)) return <span className="chat-subagent-mark" data-failed role="img" aria-label={t('ChatSubagents.unfinished')} />
  return <span className="chat-subagent-mark" data-finished={finished || undefined} role="img" aria-label={t('ChatSubagents.done')}><CheckIcon /></span>
}

function SubagentMetrics({ tool }: { tool: ToolItem }) {
  const metrics = tool.metrics
  if (!metrics) return null
  // Some agents report a subagent's time alone (Cursor).
  if (metrics.tools === 0 && metrics.tokens === 0) return metrics.durationMs > 0 ? <span className="chat-subagent-metrics">{tr('ChatSubagents.took', { value1: durationText(metrics.durationMs) })}</span> : null
  return (
    <span className="chat-subagent-metrics" title={metrics.durationMs ? t('ChatSubagents.tookS', { value1: Math.round(metrics.durationMs / 1000) }) : undefined}>
      {metrics.tools > 0 && <span>{tr('ChatSubagents.tools', { value1: metrics.tools })}</span>}
      {metrics.tools > 0 && metrics.tokens > 0 && <span className="chat-subagent-metrics-dot">·</span>}
      {metrics.tokens > 0 && <span>{formatTokens(metrics.tokens)}</span>}
    </span>
  )
}

// One subagent's card on the fan: its kind and task. `lane` staggers its entrance and its wire's
// flow apart from its siblings', so parallel ones read as parallel.
function SubagentCard({ tool, lane, open, panel, onToggle, onHover }: {
  tool: ToolItem
  lane: number
  open: boolean
  panel: string
  onToggle: () => void
  onHover: (hovered: boolean) => void
}) {
  const brief = subagentBrief(tool.input)
  const finished = useJustFinished(tool.status === 'running')
  return (
    <div className="chat-subagent-lane" style={{ '--chat-lane': lane }}>
      <ChatCopyRegion text={copyTextForItem(tool)}>
        <button
          type="button"
          className="chat-subagent-card"
          data-tool-key={itemKey(tool)}
          data-status={wireStatus(tool)}
          data-finished={finished || undefined}
          aria-expanded={open}
          aria-controls={open ? panel : undefined}
          title={tool.title}
          onClick={onToggle}
          onPointerEnter={() => onHover(true)}
          onPointerLeave={() => onHover(false)}
          onFocus={() => onHover(true)}
          onBlur={() => onHover(false)}
        >
          <ChatToolIcon name={tool.name} status={tool.status} />
          <SubagentMark tool={tool} finished={finished} />
          {brief.kind && <span className="chat-subagent-kind">{brief.kind}</span>}
          <span className="chat-subagent-title">{tool.title}</span>
          <SubagentMetrics tool={tool} />
        </button>
      </ChatCopyRegion>
    </div>
  )
}

// What the chosen subagent was told and what it reported back, under the whole fan.
function SubagentDetail({ tool, id }: { tool: ToolItem; id: string }) {
  const brief = subagentBrief(tool.input)
  return (
    <div className="chat-subagent-body" id={id} role="region" aria-label={t('ChatSubagents.subAgent', { value1: tool.title })}>
      {brief.prompt && (
        <section>
          <h4 className="chat-subagent-label">{t('ChatSubagents.instructions')}</h4>
          <ChatCopyRegion text={brief.prompt}><div className="chat-subagent-text">{brief.prompt}</div></ChatCopyRegion>
        </section>
      )}
      <section>
        <h4 className="chat-subagent-label">{t('ChatSubagents.result')}</h4>
        {tool.output
          ? <ChatCopyRegion text={tool.output}><div className="chat-subagent-result"><ChatMarkdown text={tool.output} /></div></ChatCopyRegion>
          : <p className="muted">{tool.status === 'running' ? t('ChatSubagents.stillRunning') : t('ChatSubagents.noResult')}</p>}
      </section>
    </div>
  )
}

// A wire from the main agent's middle to the middle of lane `index` of `count`.
function wirePath(index: number, count: number): string {
  const end = ((index + 0.5) / count) * 100
  const bend = WIRE_WIDTH / 2
  return `M0,50 C${bend},50 ${bend},${end} ${WIRE_WIDTH},${end}`
}

// Subagents the agent sent off together, drawn as a fan: the main agent on the left, a wire out to
// each of them on the right, and under it all the one the user opened. `fresh` is a fan that
// arrived while the chat was open: it unfolds lane by lane.
export function ChatSubagents({ tools, fresh }: { tools: readonly ToolItem[]; fresh?: boolean }) {
  const searching = useContext(ChatFindExpansion)
  const keys = tools.map((tool) => `agent:${itemKey(tool)}`)
  const [chosen, choose] = useChosen(keys)
  const [hovered, setHovered] = useState<number | null>(null)
  const panel = useId()
  const running = tools.filter((tool) => tool.status === 'running').length
  const broken = tools.filter(failed).length
  const open = chosen ? tools[keys.indexOf(chosen)] : undefined
  return (
    <div className="chat-subagents" data-fresh={fresh || undefined}>
      <div className="chat-subagents-graph">
        <div className="chat-subagents-root" data-live={running > 0 || undefined}>
          <span className="chat-subagents-root-name">{t('ChatSubagents.mainAgent')}</span>
          <span className="chat-subagents-summary">{tr('ChatSubagents.dispatched', { value1: tools.length, value2: running > 0 && t('ChatSubagents.running', { running: running }), value3: broken > 0 && <span className="chat-tool-status" data-status="failed">{tr('ChatSubagents.unfinished_512', { broken: broken })}</span> })}</span>
        </div>
        <div className="chat-subagents-fan">
          <svg className="chat-subagents-wires" viewBox={`0 0 ${WIRE_WIDTH} 100`} preserveAspectRatio="none" aria-hidden="true">
            {tools.map((tool, index) => (
              <path
                key={tool.id}
                d={wirePath(index, tools.length)}
                data-status={wireStatus(tool)}
                data-hover={hovered === index || undefined}
                data-chosen={open === tool || undefined}
                style={{ '--chat-lane': index }}
              />
            ))}
          </svg>
          <div className="chat-subagents-lanes">
            {tools.map((tool, index) => (
              <SubagentCard
                key={tool.id}
                tool={tool}
                lane={index}
                open={searching || open === tool}
                panel={searching ? `${panel}-${index}` : panel}
                onToggle={() => choose(open === tool ? null : keys[index] ?? null)}
                onHover={(on) => setHovered((was) => (on ? index : was === index ? null : was))}
              />
            ))}
          </div>
        </div>
      </div>
      {searching ? tools.map((tool, index) => <SubagentDetail key={itemKey(tool)} tool={tool} id={`${panel}-${index}`} />) : open && <SubagentDetail tool={open} id={panel} />}
    </div>
  )
}
