import type { HighlightedDiffRow } from '../diff-highlight'

export function DiffCode({ row }: { row: HighlightedDiffRow }) {
  return row.tokens && row.text ? <>{row.tokens.map((token, index) => token.className ? <span key={index} className={token.className}>{token.text}</span> : token.text)}</> : <>{row.text || ' '}</>
}
