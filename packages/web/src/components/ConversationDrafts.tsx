import { useEffect, useState } from 'react'
import { useCore, type ConversationDraftMode } from '../core-store'
import { ConversationDraft } from './ConversationDraft'
import { DiscussionDraft } from './DiscussionDraft'
import './conversation-create.css'

export function ConversationDrafts() {
  const key = useCore((state) => state.conversationDraftKey)
  return <DraftSession key={key} />
}

function DraftSession() {
  const mode = useCore((state) => state.conversationDraftMode)
  const from = useCore((state) => state.discussionDraftFrom?.discussion ?? null)
  const projects = useCore((state) => state.conversationDraftProjects?.paths)
  const [visited, setVisited] = useState<readonly ConversationDraftMode[]>([mode])
  useEffect(() => { setVisited((known) => known.includes(mode) ? known : [...known, mode]) }, [mode])
  const modes = visited.includes(mode) ? visited : [...visited, mode]
  return <div className="conversation-drafts">
    {modes.map((each) => <div key={each} className="conversation-draft-pane" hidden={each !== mode}>
      {each === 'single' ? <ConversationDraft /> : <DiscussionDraft from={from} mode={each} initialProjects={projects} />}
    </div>)}
  </div>
}
