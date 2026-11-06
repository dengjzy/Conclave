import { createContext, useContext } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatItem, ChatToolStatus, RemoteParams } from '@conclave/protocol'
import { commandExitCode, toolDisplayStatus, toolLabel, toolRunStatus } from '../chat-tools'

type RequestItem = Extract<ChatItem, { kind: 'approval' | 'question' }>
type ProcessItem = Extract<ChatItem, { kind: 'tool' | 'reasoning' }>
type Respond = (item: RequestItem, answer: Omit<RemoteParams<'conversations.respond'>, 'id' | 'requestId'>) => Promise<void>
type Segment = { kind: 'process'; items: ProcessItem[] } | { kind: 'item'; item: ChatItem }
const statusLabel: Record<ChatToolStatus, string> = { running: '进行中', done: '已完成', failed: '失败', denied: '已拒绝', interrupted: '已停止' }
const decisionLabel = { allow: '允许一次', allowForSession: '本次会话允许', deny: '拒绝' }
const resolutionLabel = { allowed: '已允许', allowedForSession: '本次会话已允许', denied: '已拒绝', cancelled: '已取消' }
const insideLink = createContext(false)

function safeHref(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : undefined
  } catch { return undefined }
}

const markdownComponents: Components = {
  a({ href, children }) {
    const safe = safeHref(href)
    return safe ? <insideLink.Provider value={true}><a href={safe} target="_blank" rel="nofollow noreferrer noopener">{children}</a></insideLink.Provider> : <>{children}</>
  },
  img: function MarkdownImage({ src, alt }) {
    const nested = useContext(insideLink)
    const href = safeHref(typeof src === 'string' ? src : undefined)
    const label = alt ? `图片：${alt}` : '查看图片'
    return href && !nested ? <a href={href} target="_blank" rel="nofollow noreferrer noopener">{label}</a> : <span>{label}</span>
  }
}

function finishedProcess(item: ChatItem): item is ProcessItem {
  return item.kind === 'reasoning' ? !item.streaming : item.kind === 'tool' && toolDisplayStatus(item) !== 'running'
}

function segments(items: ChatItem[]): Segment[] {
  const result: Segment[] = []
  for (const item of items) {
    const previous = result.at(-1)
    if (!finishedProcess(item)) result.push({ kind: 'item', item })
    else if (previous?.kind === 'process' && previous.items[0]?.stageId === item.stageId) previous.items.push(item)
    else result.push({ kind: 'process', items: [item] })
  }
  return result
}

export function MobileMessages({ items, busy, respond }: { items: ChatItem[]; busy: boolean; respond: Respond }) {
  return <>{segments(items).map((segment) => segment.kind === 'process'
    ? <Process key={segment.items[0]?.id} items={segment.items} />
    : <Message key={segment.item.id} item={segment.item} busy={busy} respond={respond} />)}</>
}

function Process({ items }: { items: ProcessItem[] }) {
  const status = toolRunStatus(items.filter((item) => item.kind === 'tool'))
  const summary = [`处理过程 · ${items.length} 项`, status.failed && `${status.failed} 失败`, status.denied && `${status.denied} 已拒绝`, status.interrupted && `${status.interrupted} 已停止`].filter(Boolean).join(' · ')
  return <details className="mobile-process" data-status={status.status}>
    <summary>{summary}</summary>
    {items.map((item) => <ProcessItemView key={item.id} item={item} />)}
  </details>
}

function ProcessItemView({ item }: { item: ProcessItem }) {
  if (item.kind === 'reasoning') return <section className="mobile-message" data-kind="reasoning"><strong>{item.streaming ? '正在思考' : '思考过程'}</strong><p className="mobile-text">{item.text}</p></section>
  const status = toolDisplayStatus(item)
  const exitCode = commandExitCode(item)
  return <section className="mobile-message" data-kind="tool" data-status={status}>
    <strong>{item.title || toolLabel(item.name, item.display)}</strong> <span className="mobile-muted">{statusLabel[status]}{exitCode !== null && exitCode !== 0 ? ` · 退出码 ${exitCode}` : ''}</span>
    {item.input && <pre>{item.input}</pre>}{item.output && <pre>{item.output}</pre>}
  </section>
}

function Message({ item, busy, respond }: { item: ChatItem; busy: boolean; respond: Respond }) {
  if (item.kind === 'user') return <article className="mobile-message" data-role="user"><p className="mobile-text">{item.text}</p></article>
  if (item.kind === 'assistant') return <article className="mobile-message" data-role="assistant"><div className="mobile-markdown"><Markdown remarkPlugins={[remarkGfm]} components={markdownComponents} skipHtml>{item.text}</Markdown></div></article>
  if (item.kind === 'reasoning' || item.kind === 'tool') return <ProcessItemView item={item} />
  if (item.kind === 'turn') return item.error ? <p className="mobile-error">{item.error}</p> : <p className="mobile-muted">本轮{item.state === 'interrupted' ? '已停止' : item.state === 'failed' ? '失败' : '已结束'}</p>
  if (item.kind === 'notice') return <p className={item.level === 'error' ? 'mobile-error' : 'mobile-muted'}>{item.text}</p>
  if (item.kind === 'approval') return <article className="mobile-request"><h3>{item.title}</h3>{item.detail && <pre>{item.detail}</pre>}{item.reason && <p>{item.reason}</p>}
    {item.resolution ? <p>{resolutionLabel[item.resolution]}</p> : <div className="mobile-message-actions mobile-toolbar">{item.choices?.length ? item.choices.map((choice) => <button type="button" key={choice.id} disabled={busy} onClick={() => { if (!busy) void respond(item, { decision: choice.decision, choice: choice.id }) }}>{choice.label || decisionLabel[choice.decision]}</button>) : item.decisions.map((decision) => <button type="button" key={decision} disabled={busy} onClick={() => { if (!busy) void respond(item, { decision }) }}>{decisionLabel[decision]}</button>)}</div>}
  </article>
  if (item.kind === 'question') return <QuestionForm item={item} busy={busy} respond={respond} />
  return null
}

function QuestionForm({ item, busy, respond }: { item: Extract<ChatItem, { kind: 'question' }>; busy: boolean; respond: Respond }) {
  return <form className="mobile-request" onSubmit={(event) => {
    event.preventDefault()
    if (busy || item.resolution) return
    const data = new FormData(event.currentTarget)
    const answers = Object.fromEntries(item.questions.map((question) => {
      const custom = String(data.get(`${question.id}:text`) ?? '').trim()
      return [question.id, custom ? [custom] : data.getAll(question.id).map(String)]
    }))
    void respond(item, { decision: 'allow', answers })
  }}>{item.questions.map((question) => <fieldset key={question.id} disabled={busy || item.resolution !== null}>
    <legend>{question.question}</legend>
    {question.options.map((option) => <label className="mobile-choice" key={option.id ?? option.label}><input type={question.multiSelect ? 'checkbox' : 'radio'} name={question.id} value={option.id ?? option.label} defaultChecked={item.answers?.[question.id]?.includes(option.id ?? option.label)} />{option.label}{option.description && <small>{option.description}</small>}</label>)}
    <label>补充回答<input name={`${question.id}:text`} maxLength={2000} defaultValue={item.answers?.[question.id]?.filter((answer) => !question.options.some((option) => (option.id ?? option.label) === answer)).join('，')} /></label>
  </fieldset>)}{item.resolution ? <p>{item.resolution === 'cancelled' ? '已取消' : '已回答'}</p> : <div className="mobile-message-actions"><button type="submit" disabled={busy}>提交回答</button></div>}</form>
}
