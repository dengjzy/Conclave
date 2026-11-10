import { useEffect, useMemo, useRef, useState } from 'react'
import { IDEA_STATUSES, type Idea, type IdeaStatus } from '@conclave/protocol'
import { t } from '../i18n'
import { perform, selectConversation, setNewTaskOpen, useCore } from '../core-store'
import { defaultAgent } from '../default-agent'
import { useInstalledAgents } from '../installed-agents'
import { PencilIcon, PlusIcon, TrashIcon } from './icons'

const STATUS_LABEL: Record<IdeaStatus, string> = {
  idea: t('Ideas.idea'),
  todo: t('Ideas.todo'),
  doing: t('Ideas.doing'),
  done: t('Ideas.done'),
  archived: t('Ideas.archived')
}

export function IdeasView({ embedded = false }: { embedded?: boolean } = {}) {
  const rpc = useCore((state) => state.rpc)
  const revision = useCore((state) => state.ideasRevision)
  const [ideas, setIdeas] = useState<Idea[]>([])
  const [creating, setCreating] = useState(false)
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<IdeaStatus | null>(null)

  useEffect(() => {
    if (!rpc || !rpc.features.includes('ideas')) return
    let live = true
    void rpc.call('ideas.list', {}).then((list) => { if (live) setIdeas(list) }).catch(() => {})
    return () => { live = false }
  }, [rpc, revision])

  const columns = useMemo(() => IDEA_STATUSES.map((status) => ({ status, ideas: ideas.filter((idea) => idea.status === status) })), [ideas])

  const update = async (id: string, fields: Partial<Idea>) => {
    const next = await perform((rpc) => rpc.call('ideas.update', { id, ...fields }))
    if (next) setIdeas((current) => current.map((idea) => idea.id === id ? next : idea))
  }
  const remove = async (id: string) => {
    if (!await perform((rpc) => rpc.call('ideas.remove', { id }))) return
    setIdeas((current) => current.filter((idea) => idea.id !== id))
  }

  return <section className={embedded ? 'ideas-view ideas-view-embedded' : 'ideas-view'} aria-label={t('Ideas.title')}>
    <div className="ideas-inner">
      {!embedded && <header className="ideas-header">
        <h2>{t('Ideas.title')}</h2>
        <span className="muted">{t('Ideas.subtitle')}</span>
        <button type="button" className="button primary ideas-new-button" onClick={() => setCreating(true)}><PlusIcon /> {t('Ideas.new')}</button>
      </header>}
      {creating && <NewIdea onDone={(idea) => { if (idea) setIdeas((current) => [idea, ...current]); setCreating(false) }} onCancel={() => setCreating(false)} />}
      <div className="ideas-board">
        {columns.map((column) => <section
          key={column.status}
          className="ideas-column"
          data-status={column.status}
          data-over={over === column.status || undefined}
          onDragOver={(event) => { event.preventDefault(); setOver(column.status) }}
          onDragLeave={() => setOver((current) => current === column.status ? null : current)}
          onDrop={(event) => {
            event.preventDefault()
            const id = event.dataTransfer.getData('text/plain')
            if (id) {
              const idea = ideas.find((each) => each.id === id)
              if (idea && idea.status !== column.status) void update(id, { status: column.status })
            }
            setOver(null)
            setDragging(null)
          }}
        >
          <header className="ideas-column-head">
            <span className="ideas-column-title">{STATUS_LABEL[column.status]}</span>
            <span className="ideas-column-count">{column.ideas.length}</span>
          </header>
          <ul className="ideas-list">
            {column.ideas.map((idea) => <IdeaCard
              key={idea.id}
              idea={idea}
              dragging={dragging === idea.id}
              onDragStart={setDragging}
              onDragEnd={() => { setDragging(null); setOver(null) }}
              onUpdate={update}
              onRemove={remove}
            />)}
          </ul>
        </section>)}
      </div>
    </div>
  </section>

}

function NewIdea({ onDone, onCancel }: { onDone: (idea: Idea | null) => void; onCancel: () => void }) {
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [projectPath, setProjectPath] = useState('')
  const [tags, setTags] = useState('')
  const [busy, setBusy] = useState(false)
  const ready = title.trim() !== '' && !busy
  const submit = async () => {
    if (!ready) return
    setBusy(true)
    const idea = await perform((rpc) => rpc.call('ideas.create', {
      title: title.trim(), notes, status: 'idea',
      tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean).slice(0, 20),
      projectPath: projectPath.trim() || null
    }))
    setBusy(false)
    onDone(idea)
  }
  return <form className="idea-new" onSubmit={(event) => { event.preventDefault(); void submit() }}>
    <input className="input idea-new-title" autoFocus placeholder={t('Ideas.titlePlaceholder')} value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
    <textarea className="input" rows={3} placeholder={t('Ideas.notesPlaceholder')} value={notes} onChange={(event) => setNotes(event.target.value)} />
    <div className="idea-new-row">
      <input className="input" placeholder={t('Ideas.projectPlaceholder')} value={projectPath} onChange={(event) => setProjectPath(event.target.value)} />
      <input className="input" placeholder={t('Ideas.tagsPlaceholder')} value={tags} onChange={(event) => setTags(event.target.value)} />
    </div>
    <div className="idea-new-actions">
      <button type="button" className="button ghost" onClick={onCancel}>{t('ChatCommandSettings.cancel')}</button>
      <button type="submit" className="button primary" disabled={!ready}>{t('Ideas.create')}</button>
    </div>
  </form>
}

function IdeaCard({ idea, dragging, onDragStart, onDragEnd, onUpdate, onRemove }: {
  idea: Idea
  dragging: boolean
  onDragStart: (id: string) => void
  onDragEnd: () => void
  onUpdate: (id: string, fields: Partial<Idea>) => Promise<void>
  onRemove: (id: string) => Promise<void>
}) {
  const card = useRef<HTMLLIElement>(null)
  const installed = useInstalledAgents()
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(idea.title)
  const [notes, setNotes] = useState(idea.notes)
  const [projectPath, setProjectPath] = useState(idea.projectPath ?? '')
  const [tags, setTags] = useState(idea.tags.join(', '))
  const [busy, setBusy] = useState(false)
  const save = async () => {
    if (title.trim() === '') return
    setBusy(true)
    await onUpdate(idea.id, {
      title: title.trim(), notes,
      tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean).slice(0, 20),
      projectPath: projectPath.trim() || null
    })
    setBusy(false)
    setEditing(false)
  }
  const startConversation = async () => {
    const agent = defaultAgent(useCore.getState().tasks, useCore.getState().conversations) ?? installed[0]
    if (!agent) return
    setBusy(true)
    const conversation = await perform((rpc) => rpc.call('conversations.create', { agent, projectPaths: idea.projectPath ? [idea.projectPath] : [] }))
    if (conversation) {
      await perform((rpc) => rpc.call('conversations.send', { id: conversation.id, text: `${idea.title}\n\n${idea.notes}`.trim() }))
      await onUpdate(idea.id, { conversationId: conversation.id, status: 'doing' })
      selectConversation(conversation.id)
    }
    setBusy(false)
  }
  const startTask = () => {
    setNewTaskOpen(true, { title: idea.title, repos: idea.projectPath ? [idea.projectPath] : [], agent: null })
  }
  return <li ref={card} className="idea-card" data-status={idea.status} data-dragging={dragging || undefined}>
    <div className="idea-card-head">
      <span
        className="idea-drag"
        draggable
        role="button"
        tabIndex={-1}
        aria-label={t('Ideas.move')}
        title={t('Ideas.move')}
        onDragStart={(event) => {
          event.dataTransfer.setData('text/plain', idea.id)
          event.dataTransfer.effectAllowed = 'move'
          if (card.current) event.dataTransfer.setDragImage(card.current, 16, 16)
          onDragStart(idea.id)
        }}
        onDragEnd={onDragEnd}
      >⋮⋮</span>
      <button type="button" className="idea-status" data-status={idea.status} onClick={() => void onUpdate(idea.id, { status: idea.status === 'done' ? 'idea' : 'done' })} title={t('Ideas.toggleDone')}>
        <span aria-hidden="true">{idea.status === 'done' ? '✓' : '○'}</span>
      </button>
      {editing
        ? <input className="input idea-title-input" autoFocus value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void save() } }} />
        : <h3 className="idea-title">{idea.title}</h3>}
      <span className="idea-card-actions">
        <select className="input idea-status-select" aria-label={t('Ideas.status')} value={idea.status} onChange={(event) => void onUpdate(idea.id, { status: event.target.value as IdeaStatus })}>
          {IDEA_STATUSES.map((status) => <option key={status} value={status}>{STATUS_LABEL[status]}</option>)}
        </select>
        <button type="button" className="icon-button" aria-label={t('chatTools.edit')} title={t('chatTools.edit')} onClick={() => setEditing((value) => !value)}>{editing ? <span aria-hidden="true">✓</span> : <PencilIcon />}</button>
        <button type="button" className="icon-button" aria-label={t('Ideas.delete')} title={t('Ideas.delete')} disabled={busy} onClick={() => void onRemove(idea.id)}><TrashIcon /></button>
      </span>
    </div>
    {editing ? <>
      <textarea className="input" rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder={t('Ideas.notesPlaceholder')} />
      <div className="idea-edit-row">
        <input className="input" value={projectPath} onChange={(event) => setProjectPath(event.target.value)} placeholder={t('Ideas.projectPlaceholder')} />
        <input className="input" value={tags} onChange={(event) => setTags(event.target.value)} placeholder={t('Ideas.tagsPlaceholder')} />
      </div>
      <div className="idea-new-actions"><button type="button" className="button ghost" onClick={() => setEditing(false)}>{t('ChatCommandSettings.cancel')}</button><button type="button" className="button primary" disabled={busy || title.trim() === ''} onClick={() => void save()}>{t('FileEditor.save')}</button></div>
    </> : idea.notes && <p className="idea-notes">{idea.notes}</p>}
    <footer className="idea-card-foot">
      <span className="idea-meta">{idea.tags.map((tag) => <span key={tag} className="idea-tag">{tag}</span>)}{idea.projectPath && <span className="muted" title={idea.projectPath}>{idea.projectPath.split('/').at(-1)}</span>}</span>
      <span className="idea-card-buttons">
        {idea.conversationId
          ? <button type="button" className="button ghost" onClick={() => selectConversation(idea.conversationId!)}>{t('Ideas.openConversation')}</button>
          : <button type="button" className="button ghost" disabled={busy} onClick={() => void startConversation()}>{t('Ideas.startChat')}</button>}
        <button type="button" className="button ghost" onClick={startTask}>{t('Ideas.startTask')}</button>
      </span>
    </footer>
  </li>
}
