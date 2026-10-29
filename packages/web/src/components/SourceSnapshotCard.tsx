import { t, tr } from '../i18n'
import { useState } from 'react'
import type { Task } from '@conclave/protocol'
import { perform } from '../core-store'
import { dayAndTime } from '../labels'
import { ChevronDownIcon, RefreshIcon } from './icons'
import { ImageStrip } from './ImageStrip'
import { ImageViewer } from './ImageViewer'
import { MarkdownEditor } from './MarkdownEditor'

const ignore = () => {}

// The issue as the tracker had it, read-only: the plan belongs in the details below, and agents
// get this text only as untrusted reference data.
export function SourceSnapshotCard({ task }: { task: Task }) {
  const { source, sourceSnapshot: snapshot } = task
  // Open while there is no plan yet: then the issue is all there is to read.
  const [open, setOpen] = useState(task.details.trim() === '')
  const [busy, setBusy] = useState(false)
  const [viewing, setViewing] = useState<number | null>(null)
  if (!source || !snapshot) {
    return null
  }
  const resync = async () => {
    setBusy(true)
    await perform((rpc) => rpc.call('sources.resync', { taskId: task.id }))
    setBusy(false)
  }
  return (
    <section className="snapshot" data-open={open || undefined} aria-label={t('SourceSnapshotCard.original', { value1: source.name })}>
      <header className="snapshot-header">
        <button type="button" className="snapshot-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>{tr('SourceSnapshotCard.original_1826', { value1: <ChevronDownIcon />, value2: source.name })}</button>
        <span className="muted">{tr('SourceSnapshotCard.fetched', { value1: dayAndTime(snapshot.fetchedAt) })}</span>
        <button
          type="button"
          className="tool-button snapshot-resync"
          aria-label={t('SourceSnapshotCard.fetchAgain')}
          data-tooltip={t('SourceSnapshotCard.fetchAgain')}
          aria-busy={busy || undefined}
          disabled={busy}
          onClick={() => void resync()}
        >
          <RefreshIcon />
        </button>
      </header>
      {open && (
        <MarkdownEditor
          key={snapshot.fetchedAt}
          value={snapshot.markdown || t('SourceSnapshotCard.originalContentIsEmpty')}
          onSave={ignore}
          label={t('SourceSnapshotCard.original_1830', { value1: source.name, value2: source.key })}
          hint=""
          readOnly
        />
      )}
      {open && snapshot.images.length > 0 && (
        <div className="snapshot-images">
          <span className="muted">{tr('SourceSnapshotCard.imagesFromProvidedAsReferenceLikeTheOriginal', { value1: source.name, value2: snapshot.images.length })}</span>
          <ImageStrip images={snapshot.images} onOpen={setViewing} />
        </div>
      )}
      {viewing !== null && snapshot.images.length > 0 && (
        <ImageViewer
          images={snapshot.images}
          index={Math.min(viewing, snapshot.images.length - 1)}
          note={t('SourceSnapshotCard.from', { value1: source.name })}
          onIndex={setViewing}
          onClose={() => setViewing(null)}
        />
      )}
    </section>
  )
}
