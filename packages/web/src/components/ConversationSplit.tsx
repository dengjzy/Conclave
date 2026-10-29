import { getLocale, t } from '../i18n'
import { useEffect, useMemo, useRef, useState } from 'react'
import { closeSplitPane, selectConversation, useCore } from '../core-store'
import type { SplitPanes } from '../conversation-split'
import { setPreference, usePreferences } from '../preferences'
import { ConversationInspector } from './ConversationInspector'
import { ConversationPaneContext, type ConversationPane } from './conversation-pane'
import { ConversationView, useConversationPanel } from './ConversationView'
import { PanelSeparator } from './PanelSeparator'
import { DEFAULT_SIDE_PANEL_RATIO } from './side-panel-size'

// Narrower than this a column cannot hold the chat's toolbar: below two of them, only the one in
// front shows, the other a keystroke (or a click in the list) away.
const MIN_PANE_WIDTH = 400

// Two conversations side by side. The one in front is the selected conversation: it has the full
// composer, the keys and the inspector, which sits at the far right and names its column.
export function ConversationSplit({ panes, active }: { panes: SplitPanes; active: string }) {
  const ratio = usePreferences((p) => p.splitRatio)
  const [inspectorRatio, setInspectorRatio] = useState(DEFAULT_SIDE_PANEL_RATIO)
  const inspectorOpen = useCore((s) => s.conversationInspectorOpen)
  const front = useCore((s) => s.conversations[active])
  const { hasPanel, wire } = useConversationPanel(front)
  const box = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const element = box.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setNarrow((entry?.contentRect.width ?? 0) < MIN_PANE_WIDTH * 2))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const [left, right] = panes
  const columns = useMemo(() => [left, right].map((id, index): ConversationPane & { id: string; onClose: () => void } => ({
    id,
    index: index === 0 ? 0 : 1,
    active: id === active,
    focus: () => selectConversation(id),
    onClose: () => closeSplitPane(id)
  })), [left, right, active, getLocale()])
  const frontIndex = panes.indexOf(active)
  return (
    <div className="conversation-split" data-narrow={narrow || undefined}>
      <div className="conversation-split-panes" ref={box}>
        {columns.map((column) => (
          <ConversationPaneContext.Provider key={column.id} value={column}>
            {column.index === 1 && !narrow && (
              <PanelSeparator panelName={t('ConversationSplit.rightPane')} ratio={ratio} onRatioChange={(value) => setPreference('splitRatio', value)} onReset={() => setPreference('splitRatio', 0.5)} />
            )}
            <div
              className="split-pane"
              hidden={narrow && !column.active}
              style={column.index === 1 && !narrow ? { flex: `0 0 calc((100% - var(--side-panel-separator-size)) * ${ratio})` } : undefined}
            >
              <ConversationView id={column.id} pane={column} />
            </div>
          </ConversationPaneContext.Provider>
        ))}
      </div>
      {front && hasPanel && inspectorOpen && (
        <ConversationInspector
          key={front.id}
          conversation={front}
          widthRatio={inspectorRatio}
          onWidthRatioChange={setInspectorRatio}
          wire={wire}
          owner={<><span className="pane-chip" data-active="true">{frontIndex + 1}</span><span className="inspector-owner-title">{front.title}</span></>}
        />
      )}
    </div>
  )
}
