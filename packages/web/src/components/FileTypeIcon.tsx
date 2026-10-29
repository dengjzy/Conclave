import { fileIconId, fileIconUrl } from '../file-icons'
import { DocumentIcon } from './icons'

export function FileTypeIcon({ path, directory = false, expanded = false, root = false, dark }: {
  path: string; directory?: boolean; expanded?: boolean; root?: boolean; dark: boolean
}) {
  const url = fileIconUrl(fileIconId(path, { directory, expanded, root, dark }))
  return <span className="file-tree-icon" aria-hidden>
    {url ? <img src={url} alt="" width={16} height={16} loading="lazy" decoding="async" /> : <DocumentIcon />}
  </span>
}
