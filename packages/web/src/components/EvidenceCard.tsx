import { DocumentIcon } from './icons'
import { CopyButton } from './CopyButton'

export function EvidenceCard({ text }: { text: string }) {
  const lines = text.trim().split(/\r?\n/)
  let file = ''
  let lineRange = ''
  let snippetLines: string[] = []
  let conclusion = ''
  let inSnippet = false

  for (const line of lines) {
    const trimmed = line.trim()
    const fileMatch = /^文件\s*[:：]\s*(.*)$/i.exec(trimmed) || /^File\s*[:：]\s*(.*)$/i.exec(trimmed)
    const lineMatch = /^行号\s*[:：]\s*(.*)$/i.exec(trimmed) || /^Lines?\s*[:：]\s*(.*)$/i.exec(trimmed)
    const conclusionMatch = /^(?:论据结论|结论|证明|Conclusion)\s*[:：]\s*(.*)$/i.exec(trimmed)
    const snippetStartMatch = /^(?:关键内容|内容|Snippet|Log)\s*[:：]\s*(.*)$/i.exec(trimmed)

    if (fileMatch) {
      file = (fileMatch[1] ?? '').trim()
      inSnippet = false
    } else if (lineMatch) {
      lineRange = (lineMatch[1] ?? '').trim()
      inSnippet = false
    } else if (conclusionMatch) {
      conclusion = (conclusionMatch[1] ?? '').trim()
      inSnippet = false
    } else if (snippetStartMatch) {
      const val = (snippetStartMatch[1] ?? '').trim()
      if (val) {
        snippetLines.push(val)
      }
      inSnippet = true
    } else if (inSnippet) {
      snippetLines.push(line)
    } else if (!conclusion && !file && !lineRange) {
      snippetLines.push(line)
    }
  }

  const snippet = snippetLines.join('\n').trim()

  return (
    <div className="evidence-card">
      <div className="evidence-card-header">
        <span className="evidence-card-tag">证据线索</span>
        {file && (
          <span className="evidence-card-file" title={file}>
            <DocumentIcon />
            <code>{file}{lineRange ? `:${lineRange}` : ''}</code>
          </span>
        )}
        <span className="evidence-card-actions">
          <CopyButton text={text} label="复制证据" />
        </span>
      </div>
      {conclusion && (
        <div className="evidence-card-conclusion">
          <strong>推演结论：</strong>{conclusion}
        </div>
      )}
      {snippet && (
        <div className="evidence-card-snippet">
          <pre><code>{snippet}</code></pre>
        </div>
      )}
    </div>
  )
}
