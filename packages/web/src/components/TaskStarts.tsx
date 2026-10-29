import { getLocale, t, tr } from '../i18n'
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import { checkEditReference, checkEditStart, START_HEAD, type RepoStartOptions, type Task, type TaskRepo } from '@conclave/protocol'
import { perform, updateTask, useCore, useTaskStartSupported } from '../core-store'
import { dayAndTime, reasonText } from '../labels'
import { fallbackText, pickedText, shortRef, START_NOTE_TEXT } from '../task-starts'
import { CheckIcon, ChevronDownIcon } from './icons'
import { Popover } from './Popover'
import { projectName } from './ProjectPicker'

// Tasks by the branch they made, so a dependency's branch can go by its task's title.
function useBranchTasks(): ReadonlyMap<string, Task> {
  const tasks = useCore((s) => s.tasks)
  return useMemo(() => new Map(Object.values(tasks).flatMap((task) => task.repos.flatMap((repo) => (repo.branch ? [[repo.branch, task] as const] : [])))), [tasks, getLocale()])
}

const titleIn = (branchTasks: ReadonlyMap<string, Task>) => (branch: string) => branchTasks.get(branch)?.title

function Choice({ label, description, checked, disabled = false, onPick }: { label: string; description: string; checked: boolean; disabled?: boolean; onPick: () => void }) {
  return (
    <li className="menu-row">
      <button type="button" className="menu-item task-start-choice" aria-pressed={checked} disabled={disabled} onClick={onPick}>
        <span className="task-start-choice-text">
          <span>{label}</span>
          <span className="task-start-choice-description">{description}</span>
        </span>
        {checked && <span className="menu-check"><CheckIcon /></span>}
      </button>
    </li>
  )
}

// reference: for an additional project, the choice to only read it, with why it cannot be taken
// where it cannot.
function StartMenu({ repo, option, branchTasks, reference, onPick, onClose }: {
  repo: TaskRepo
  option: RepoStartOptions
  branchTasks: ReadonlyMap<string, Task>
  reference: { blocker: string | null; onPick: () => void } | null
  onPick: (ref: string | null) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const refs = needle ? option.refs.filter((ref) => shortRef(ref).toLowerCase().includes(needle)) : option.refs
  const fallback = fallbackText(option, titleIn(branchTasks))
  const onSearchKey = (event: KeyboardEvent) => {
    const first = refs[0]
    if (event.key === 'Enter' && first) {
      event.preventDefault()
      onPick(first)
    }
  }
  return (
    <Popover label={t('TaskStarts.chooseStartingPoint')} onClose={onClose}>
      <ul className="menu-list">
        {option.git && <>
          <Choice label={t('TaskStarts.default', { value1: fallback.ref })} description={fallback.says} checked={!repo.reference && repo.startRef === null} onPick={() => onPick(null)} />
          {option.current && (
            <Choice label={t('TaskStarts.projectSCurrentBranch', { value1: option.current })} description={t('TaskStarts.useWhicheverBranchIsCheckedOutInThis')} checked={!repo.reference && repo.startRef === START_HEAD} onPick={() => onPick(START_HEAD)} />
          )}
        </>}
        {reference && (
          <Choice label={t('TaskStarts.reference')} description={reference.blocker ?? (option.git ? t('TaskStarts.referenceDescription') : t('TaskStarts.aFolderThatIsNoGitRepository'))} checked={Boolean(repo.reference)} disabled={reference.blocker !== null} onPick={reference.onPick} />
        )}
      </ul>
      {option.git && <>
      <div className="menu-separator" role="separator" />
      <input
        className="input menu-search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onSearchKey}
        placeholder={t('DraftBranchPicker.searchBranchesEnterToSelectTheFirst')}
        aria-label={t('ConversationBranches.searchBranches')}
      />
      {refs.length > 0 && (
        <ul className="menu-list task-start-refs">
          {refs.map((ref) => {
            const owner = branchTasks.get(shortRef(ref))
            return (
              <li key={ref} className="menu-row">
                <button type="button" className="menu-item" aria-pressed={!repo.reference && repo.startRef === ref} onClick={() => onPick(ref)}>
                  <span className="menu-item-title mono">{shortRef(ref)}</span>
                  {owner && <span className="menu-item-path">{tr('TaskStarts.task', { value1: owner.title })}</span>}
                  {!repo.reference && repo.startRef === ref && <span className="menu-check"><CheckIcon /></span>}
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <p className="menu-note">{refs.length === 0 ? t('ConversationBranches.noMatchingBranches') : t('TaskStarts.localAndRemoteBranchesRemoteBranchesAreFetched')}</p>
      </>}
    </Popover>
  )
}

// One project's row: its name, and the one control that says where its work starts.
function Row({ repo, named, children }: { repo: TaskRepo; named: boolean; children: ReactNode }) {
  return (
    <div className="task-start">
      {named && <span className="task-start-project" title={repo.path}>{projectName(repo.path)}</span>}
      <span className="task-start-value">{children}</span>
    </div>
  )
}

// Where a project's branch is to start, or, for an additional one, that it is only read: picked in
// one menu, which a folder outside git offers nothing but the latter in.
function StartPicker({ task, repo, option, named, additional }: { task: Task; repo: TaskRepo; option: RepoStartOptions; named: boolean; additional: boolean }) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const branchTasks = useBranchTasks()
  const launching = useCore((s) => s.startingTasks.includes(task.id))
  const startBlocker = checkEditStart(task, repo, launching)
  const referenceBlocker = additional ? checkEditReference(task, repo, launching) : null
  const picked = pickedText(repo, option, titleIn(branchTasks))
  const pick = (ref: string | null) => {
    close()
    if (repo.reference || ref !== repo.startRef) void updateTask(task.id, { ...(repo.reference ? { references: [{ path: repo.path, reference: false }] } : {}), starts: [{ path: repo.path, ref }] })
  }
  const reference = additional ? {
    blocker: referenceBlocker && reasonText(referenceBlocker, referenceBlocker),
    onPick: () => {
      close()
      if (!repo.reference) void updateTask(task.id, { references: [{ path: repo.path, reference: true }] })
    }
  } : null
  // A folder outside git can only be read, and can be read only once it is marked so.
  const needsReference = additional && !option.git && !repo.reference
  const blocker = repo.reference || !option.git ? referenceBlocker : startBlocker
  const fixed = !option.git && Boolean(repo.reference)
  const label = repo.reference ? t('TaskStarts.reference') : needsReference ? t('TaskStarts.needsReference') : picked.ref
  const hint = repo.reference ? t('TaskStarts.referenceDescription')
    : needsReference ? t('TaskStarts.aFolderThatIsNoGitRepository')
    : repo.startRef === null ? fallbackText(option, titleIn(branchTasks)).says
    : picked.says ?? t('TaskStarts.whereToBranchTheTaskFor', { value1: projectName(repo.path) })
  return (
    <Row repo={repo} named={named}>
      <span className="menu-anchor">
        <button
          type="button"
          className="chip task-start-button"
          data-kind={repo.reference ? 'reference' : needsReference ? 'needs-reference' : repo.startRef === null ? 'default' : undefined}
          aria-haspopup="dialog"
          aria-expanded={open}
          disabled={blocker !== null || fixed}
          aria-label={t('TaskStarts.startingPointFor', { value1: projectName(repo.path), value2: label })}
          data-tooltip={blocker ? reasonText(blocker, blocker) : fixed ? t('TaskStarts.aFolderThatIsNoGitRepository') : hint}
          data-tooltip-align="start"
          onClick={() => setOpen((current) => !current)}
        >
          <span className={repo.reference || needsReference ? undefined : 'mono'}>{label}</span>
          {!fixed && <ChevronDownIcon />}
        </button>
        {open && <StartMenu repo={repo} option={option} branchTasks={branchTasks} reference={reference} onPick={pick} onClose={close} />}
      </span>
      {!repo.reference && repo.startRef !== null && option.stacked && <p className="task-start-note">{t('TaskStarts.dependencyTaskChangesAreNotIncluded')}</p>}
    </Row>
  )
}

function StartRecord({ repo, named }: { repo: TaskRepo & { start: NonNullable<TaskRepo['start']> }; named: boolean }) {
  const { start } = repo
  return (
    <Row repo={repo} named={named}>
      <span className="mono">{start.ref}</span>
      <span className="mono muted">{start.commit.slice(0, 7)}</span>
      <span className="muted">{dayAndTime(start.at)}</span>
      {start.note && <p className="task-start-note" data-note={start.note}>{START_NOTE_TEXT[start.note]}</p>}
    </Row>
  )
}

// Where each git repo's branch starts: picked until the branch is made, a record after. A plain
// folder runs in place and has none; neither has a branch made before starts were recorded. An
// additional project may instead be one the agent only reads, with no branch at all.
export function TaskStarts({ task }: { task: Task }) {
  const supported = useTaskStartSupported()
  const referable = useCore((s) => s.rpc?.features.includes('task-references') ?? false)
  const [options, setOptions] = useState<readonly RepoStartOptions[]>([])
  // Read again when what they depend on changes: the repos, their branches, the dependencies.
  const key = `${task.repos.map((repo) => `${repo.path}\n${repo.branch ?? ''}`).join('\n')}\n${task.dependsOn.join(',')}`
  useEffect(() => {
    if (!supported) return
    let live = true
    void perform((rpc) => rpc.call('tasks.startOptions', { id: task.id })).then((result) => {
      if (live && result) setOptions(result)
    })
    return () => {
      live = false
    }
  }, [supported, task.id, key])

  if (!supported) return null
  const named = task.repos.length > 1
  const rows = task.repos.flatMap((repo, index) => {
    const option = options.find((each) => each.path === repo.path)
    const additional = referable && index > 0
    if (repo.start && !repo.reference) return [<StartRecord key={repo.path} repo={{ ...repo, start: repo.start }} named={named} />]
    if (!option || repo.branch || (!option.git && !additional)) return []
    return [<StartPicker key={repo.path} task={task} repo={repo} option={option} named={named} additional={additional && !repo.worktreePath} />]
  })
  if (rows.length === 0) return null
  return (
    <>
      <dt>{t('TaskStarts.startingPoint')}</dt>
      <dd className="task-starts" data-named={named || undefined}>{rows}</dd>
    </>
  )
}
