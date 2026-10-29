import { localized, t } from './i18n'
import { START_HEAD, type RepoStartOptions, type StartNote, type TaskRepo } from '@conclave/protocol'

export const START_NOTE_TEXT: Record<StartNote, string> = localized(() => ({
  'fetch-failed': t('taskStarts.couldNotFetchLatestCodeUsingTheLocal'),
  'no-remote-default': t('taskStarts.noOriginDefaultBranchBranchingFromTheProject')
}))

export function shortRef(ref: string): string {
  return ref.replace(/^refs\/(heads|remotes)\//, '')
}

// What the branch starts from when nothing is picked, in words; `taskOf` names a dependency's
// branch by its task's title.
export function fallbackText(option: RepoStartOptions, taskOf: (branch: string) => string | undefined): { ref: string; says: string } {
  if (!option.fallback) return { ref: option.current ?? START_HEAD, says: t('taskStarts.noOriginDefaultBranchUsingTheProjectS') }
  const ref = shortRef(option.fallback)
  if (!option.stacked) return { ref, says: t('taskStarts.originDefaultBranchFetchedBeforeStarting') }
  const title = taskOf(ref)
  return { ref, says: title ? t('taskStarts.dependencyTaskBranch', { title: title }) : t('taskStarts.dependencyTaskBranch_2664') }
}

// What the picker button shows: the branch, and a word on where it comes from.
export function pickedText(repo: Pick<TaskRepo, 'startRef'>, option: RepoStartOptions, taskOf: (branch: string) => string | undefined): { ref: string; says: string | null } {
  if (repo.startRef === null) return { ref: fallbackText(option, taskOf).ref, says: t('CjkFontPicker.default') }
  if (repo.startRef === START_HEAD) return { ref: option.current ?? START_HEAD, says: t('taskStarts.projectSCurrentBranch') }
  return { ref: shortRef(repo.startRef), says: repo.startRef.startsWith('refs/remotes/') ? t('taskStarts.fetchBeforeStarting') : null }
}
