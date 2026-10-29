import { useDiffHighlight } from '../diff-highlight'
import { DiffCode } from './DiffCode'

// A unified diff, one line per row, coloured by what each line does.
export function DiffLines({ patch, path }: { patch: string; path: string }) {
  const rows = useDiffHighlight(patch, path)
  return (
    <pre className="diff-view">
      {rows.map((row, index) => (
        <div key={index} className={row.kind}><DiffCode row={row} /></div>
      ))}
    </pre>
  )
}
