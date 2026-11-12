import { useCore } from '../core-store'
import { ConversationDraft } from './ConversationDraft'
import './conversation-create.css'

export function ConversationDrafts() {
  const key = useCore((state) => state.conversationDraftKey)
  return (
    <div className="conversation-drafts">
      <div className="conversation-draft-pane">
        <ConversationDraft key={key} />
      </div>
    </div>
  )
}
