import { useContext, useMemo, useState } from 'react'
import { localized, t } from '../i18n'
import type { ChatItem, ChatToolStatus } from '@conclave/protocol'
import { browserActivity } from '../browser-activity'
import { ChatBrowserTabs } from '../browser-state'
import { browserRunTabs, hostLine } from '../chat-browser'
import { toolLabel, toolRunStatus } from '../chat-tools'
import { ExternalIcon } from './icons'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>
const SETTLED: Record<Exclude<ChatToolStatus, 'running'>, string> = localized(() => ({
  done: t('ChatBrowserWindow.browserActionCompleted'), failed: t('ChatBrowserWindow.browserActionFailed'), denied: t('ChatBrowserWindow.browserActionDenied'), interrupted: t('ChatBrowserWindow.browserActionInterrupted')
}))

// A turn's browser work as a small browser window: a schematic, never a screenshot, whose motion
// follows the call running. Closed tabs keep their last page; open ones lead into the panel.
export function ChatBrowserWindow({ tools }: { tools: readonly ToolItem[] }) {
  const liveTabs = useContext(ChatBrowserTabs)
  const tabs = useMemo(() => browserRunTabs(tools, liveTabs), [tools, liveTabs])
  const [selected, setSelected] = useState<{ id: string; operation: string } | null>(null)
  const tool = tools.find((each) => each.status === 'running') ?? tools.at(-1)
  const activity = tool ? browserActivity(tool) : null
  if (!tool || !activity) return null
  const status = toolRunStatus(tools).status
  const operation = `${tool.stageId}/${tool.id}`
  const current = (selected?.operation === operation ? tabs.tabs.find((tab) => tab.id === selected.id) : null) ?? tabs.current
  const caption = status === 'running' ? activity.label : SETTLED[status]
  const address = current ? hostLine(current.url) : activity.address
  const label = status === 'running' ? toolLabel(tool.name, tool.display) : current?.title || address || toolLabel(tool.name, tool.display)
  return (
    <div className="chat-browser-activity" data-status={status} data-action={activity.action}>
      <div key={operation} className="chat-browser-scene" data-tabs={tabs.tabs.length > 0 || undefined}>
        <div className="chat-browser-window">
          {tabs.tabs.length > 0 && (
            <div className="chat-browser-tabs">
              {tabs.tabs.map((tab) => {
                const name = tab.title || hostLine(tab.url)
                return (
                  <button key={tab.id} type="button" className="chat-browser-tab" data-active={tab.id === current?.id || undefined} data-closed={tab.closed || undefined} title={t(tab.closed ? 'ChatBrowserWindow.closedTab' : 'ChatBrowserWindow.openTab', { title: name })} onClick={() => { setSelected({ id: tab.id, operation }); if (!tab.closed && tab.url) window.open(tab.url, '_blank') }}>
                    <i className="chat-browser-tab-dot" aria-hidden="true" /><span>{name}</span>{tab.closed && <span className="chat-browser-tab-state">{t('ChatBrowserWindow.closed')}</span>}
                  </button>
                )
              })}
            </div>
          )}
          <div className="chat-browser-bar">
            <span className="chat-browser-address mono" title={current?.url ?? activity.address ?? undefined}>{address ?? t('BrowserSidePanel.browser')}</span>
            {current && (
              <button type="button" className="chat-browser-open" disabled={current.closed} title={t(current.closed ? 'ChatBrowserWindow.closed' : 'ChatBrowserWindow.openInPanel')} onClick={() => { if (current.url) window.open(current.url, '_blank') }}>
                {current.closed ? t('ChatBrowserWindow.closed') : <>{t('ChatBrowserCard.open')}<ExternalIcon /></>}
              </button>
            )}
          </div>
          <div className="chat-browser-loading" aria-hidden="true" />
          <div className="chat-browser-body" aria-hidden="true">
            <div className="chat-browser-page">
              <div className="chat-browser-page-label">{label}</div>
              <div className="chat-browser-page-line" /><div className="chat-browser-page-line" data-short />
              <div className="chat-browser-page-field"><span className="chat-browser-typed" /></div>
              <div className="chat-browser-page-button" />
            </div>
            <span className="chat-browser-click-ring" /><span className="chat-browser-cursor" />
          </div>
        </div>
      </div>
      <div className="chat-browser-activity-caption" role="status">
        <span className="chat-browser-activity-dot" aria-hidden="true" />
        <span>{caption}</span>
      </div>
    </div>
  )
}
