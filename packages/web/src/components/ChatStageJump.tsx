import { useEffect, useState, type RefObject } from 'react'
import { finishStageJump, loadStageHistory, useStageJump, type StageHistoryResult } from '../chat-stage-jump'
import { useChat } from '../chat-state'
import { t } from '../i18n'
import { Spinner } from './Spinner'

export function ChatStageJump({ conversationId, ready, container, loadOlder, onStart }: {
  conversationId: string; ready: boolean; container: RefObject<HTMLDivElement | null>
  loadOlder: () => Promise<'loaded' | 'done' | 'failed'>; onStart: () => void
}) {
  const request = useStageJump((state) => state.request?.conversationId === conversationId ? state.request : null)
  const [result, setResult] = useState<StageHistoryResult | 'loading'>('loading')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!request || !ready) return
    let cancelled = false
    let frame = 0
    let nextFrame = 0
    onStart()
    setResult('loading')
    void loadStageHistory(request.stageId, () => useChat.getState()[conversationId], loadOlder, () => cancelled).then((result) => {
      if (cancelled) return
      if (result !== 'ready') { setResult(result); return }
      frame = requestAnimationFrame(() => { nextFrame = requestAnimationFrame(() => {
        if (cancelled) return
        const target = container.current?.querySelector<HTMLElement>(`[data-stage-id="${CSS.escape(request.stageId)}"]`)
        if (!target || !container.current) { setResult('missing'); return }
        // An immediate history jump cannot be repinned by the old bottom's pending scroll event.
        onStart()
        const top = container.current.scrollTop + target.getBoundingClientRect().top - container.current.getBoundingClientRect().top - 8
        container.current.scrollTo({ top, behavior: 'instant' })
        finishStageJump(request.seq)
      }) })
    }).catch(() => { if (!cancelled) setResult('failed') })
    return () => { cancelled = true; cancelAnimationFrame(frame); cancelAnimationFrame(nextFrame) }
  }, [request?.seq, ready, retry, conversationId, container, loadOlder, onStart])
  if (!request) return null
  return <div className="chat-stage-jump" role="status">
    {result === 'loading' && <Spinner />}
    <span>{t(result === 'loading' ? 'WorkflowProcess.loadingRecord' : result === 'limited' ? 'WorkflowProcess.recordLimit' : result === 'missing' ? 'WorkflowProcess.recordMissing' : 'WorkflowProcess.recordFailed')}</span>
    {result !== 'loading' && result !== 'missing' && <button type="button" className="button ghost" onClick={() => setRetry((count) => count + 1)}>{t('WorkflowProcess.retry')}</button>}
    <button type="button" className="button ghost" onClick={() => finishStageJump(request.seq)}>{t('BackdropPicker.close')}</button>
  </div>
}
