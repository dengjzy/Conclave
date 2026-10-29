import { useEffect } from 'react'
import { create } from 'zustand'
import type { ExternalSession } from '@conclave/protocol'
import { perform, selectConversation, useCore } from './core-store'

type ExternalSessionsState = { sessions: ExternalSession[] | null; loading: boolean }
// What the first visit offers to go on with; null until the first scan answers.
export const useExternalSessions = create<ExternalSessionsState>()(() => ({ sessions: null, loading: false }))

// Quietly: a first visit is no place for an error about a folder the user never opened here.
export async function loadExternalSessions(): Promise<void> {
  const { rpc } = useCore.getState()
  if (!rpc || useExternalSessions.getState().loading) return
  if (!rpc.features.includes('session-import')) {
    useExternalSessions.setState({ sessions: [] })
    return
  }
  useExternalSessions.setState({ loading: true })
  try {
    const { sessions } = await rpc.call('sessionImports.list', {})
    useExternalSessions.setState({ sessions, loading: false })
  } catch {
    useExternalSessions.setState((state) => ({ sessions: state.sessions ?? [], loading: false }))
  }
}

export function useExternalSessionsWhen(wanted: boolean): ExternalSession[] | null {
  const connected = useCore((state) => state.connection === 'connected')
  const sessions = useExternalSessions((state) => state.sessions)
  useEffect(() => { if (wanted && connected && sessions === null) void loadExternalSessions() }, [wanted, connected, sessions])
  return sessions
}

export async function resumeSession(session: ExternalSession): Promise<boolean> {
  const result = await perform((rpc) => rpc.call('sessionImports.import', { sessions: [{ agent: session.agent, sessionId: session.sessionId }] }))
  const conversation = result?.conversations[0]
  if (!conversation) return false
  useExternalSessions.setState(({ sessions }) => ({
    sessions: sessions?.map((each) => each.agent === session.agent && each.sessionId === session.sessionId ? { ...each, status: 'imported', conversationId: conversation.id } : each) ?? null
  }))
  selectConversation(conversation.id)
  return true
}
