import { t } from '../i18n'
import { showTerminal, useCore } from '../core-store'

// A project's setup or check that Conclave is running for this conversation: the agent waits on
// setup, and a task is not handed in until its check ends.
export function ProjectRunNotice({ conversationId }: { conversationId: string }) {
  const running = useCore((state) => state.terminals.find((terminal) => terminal.conversationId === conversationId && terminal.purpose && !terminal.exited))
  if (!running) return null
  const what = running.purpose === 'setup' ? t('ProjectRunNotice.runningProjectSetupAgentStartsAfterward') : t('ProjectRunNotice.runningProjectChecksSubmittingForReviewAfterThey')
  return (
    <div className="chat-notice chat-notice-actionable project-run-notice" role="status">
      <span>{what}</span>
      <button type="button" className="button chat-notice-action" onClick={() => showTerminal(running.id)}>{t('ChatToolCard.viewInTerminalPanel')}</button>
    </div>
  )
}

export function useProjectCheckRunning(conversationId: string | null): boolean {
  return useCore((state) => conversationId !== null && state.terminals.some((terminal) => terminal.conversationId === conversationId && terminal.purpose === 'check' && !terminal.exited))
}
