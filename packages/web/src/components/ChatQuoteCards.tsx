import { t } from '../i18n'
import { removeQuote, setQuoteNote, type ChatQuote } from '../chat-quotes'
import { CloseIcon, QuoteIcon } from './icons'

// The passages quoted into the next message, above the input: each with a line for what the
// user says about it, and a way to drop it. Enter in that line goes on to the message.
export function QuoteCards({ conversationId, quotes, onDone }: { conversationId: string; quotes: readonly ChatQuote[]; onDone: () => void }) {
  return (
    <ul className="chat-quotes" aria-label={t('ChatQuoteCards.quotedPassage')}>
      {quotes.map((quote) => (
        <li key={quote.id} className="chat-quote-card">
          <span className="chat-quote-icon" aria-hidden="true"><QuoteIcon /></span>
          <div className="chat-quote-body">
            <p className="chat-quote-text" title={quote.text}>{quote.text}</p>
            <input
              className="chat-quote-note"
              value={quote.note}
              placeholder={t('ChatQuoteCards.commentOnThisPassageOptional')}
              aria-label={t('ChatQuoteCards.commentOnThisQuote')}
              onChange={(event) => setQuoteNote(conversationId, quote.id, event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  onDone()
                }
              }}
            />
          </div>
          <button type="button" className="chat-quote-remove" aria-label={t('ChatQuoteCards.removeQuote')} data-tooltip={t('ChatQuoteCards.remove')} data-tooltip-side="top-end" onClick={() => removeQuote(conversationId, quote.id)}>
            <CloseIcon />
          </button>
        </li>
      ))}
    </ul>
  )
}
