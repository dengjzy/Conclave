import remarkBreaks from 'remark-breaks'
import remarkCjkFriendly from 'remark-cjk-friendly'
import remarkGfm from 'remark-gfm'

// The parts of a Markdown tree an alert is found in; the rest of a node goes untouched.
type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[]; data?: { hProperties?: Record<string, unknown> } }

// GitHub wants the marker on a line of its own; agents also write the text right after it.
const ALERT = /^\[!(note|tip|important|warning|caution)\](?:[ \t]*\n|[ \t]+|$)/i

// GitHub's alerts: a quote opening with [!NOTE], [!TIP], [!IMPORTANT], [!WARNING] or [!CAUTION]
// is drawn as a callout of that kind, its marker taken out of the text.
function markAlert(quote: MarkdownNode): void {
  const paragraph = quote.children?.[0]
  const text = paragraph?.type === 'paragraph' ? paragraph.children?.[0] : undefined
  if (!paragraph || text?.type !== 'text' || text.value === undefined) return
  const match = ALERT.exec(text.value)
  const kind = match?.[1]?.toLowerCase()
  if (!match || !kind) return
  text.value = text.value.slice(match[0].length)
  // A marker on a line of its own leaves an empty paragraph, which would show as a gap.
  if (text.value === '' && paragraph.children?.length === 1) quote.children?.shift()
  quote.data = { ...quote.data, hProperties: { ...quote.data?.hProperties, className: ['chat-alert'], dataAlert: kind } }
}

function remarkAlerts() {
  const walk = (node: MarkdownNode): void => {
    for (const child of node.children ?? []) {
      if (child.type === 'blockquote') markAlert(child)
      walk(child)
    }
  }
  return walk
}

// The Markdown a reply is read as. A newline is a line break, as it is in the agent's terminal, not
// a space. CommonMark will not close `**加粗：**正文` (punctuation inside, a letter after), which
// Chinese writes all the time: emphasis is relaxed next to CJK text, and only there. Alerts are read
// before line breaks split the marker's line from the text after it.
export const remarkPlugins = [remarkGfm, remarkAlerts, remarkBreaks, remarkCjkFriendly]
