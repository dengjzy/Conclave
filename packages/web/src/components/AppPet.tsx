import { useMemo } from 'react'
import { selectConversation, selectTask, useCore } from '../core-store'
import { t, useLocale } from '../i18n'
import { petMood } from '../pet-mood'
import { usePreferences } from '../preferences'
import { useReducedMotion } from '../reduced-motion'
import { PetStage } from './PetStage'
import { usePetSkin } from './PetSprite'

export function AppPet() {
  const style = usePreferences((s) => s.petStyle)
  const size = usePreferences((s) => s.petSize)
  const level = usePreferences((s) => s.petLevel)
  const settingsOpen = useCore((s) => s.settingsOpen)
  const guiding = usePreferences((s) => s.setup.status === 'active')
  const tasks = useCore((s) => s.tasks)
  const conversations = useCore((s) => s.conversations)
  const unseen = useCore((s) => s.unseen)
  const squadRuns = useCore((s) => s.squadRuns)
  const locale = useLocale((s) => s.locale)
  const reduced = useReducedMotion()
  const skin = usePetSkin(style, size, level === 'off' || settingsOpen || guiding)
  const status = useMemo(() => petMood({ tasks, conversations, unseen, squadRuns }), [tasks, conversations, unseen, squadRuns])
  const message = useMemo(() => {
    const item = status.attention
    if (!item) return null
    const { target } = item
    return {
      key: `${target.kind}:${target.id}:${item.primaryReason}:${item.updatedAt}`,
      text: t(item.primaryReason === 'crashed' ? 'Pet.crashed' : 'Pet.awaiting', { title: item.title }),
      anchor: () => {
        const s = useCore.getState()
        const opened = target.kind === 'task' ? s.selectedId === target.id && s.section === 'tasks' : s.selectedConversationId === target.id && s.section === 'conversations'
        const selector = opened ? '.chat-dock' : target.kind === 'task' ? `[data-task-id="${CSS.escape(target.id)}"]` : `[data-conversation-id="${CSS.escape(target.id)}"]`
        return (document.querySelector(selector) ?? document.querySelector('.sidebar, .statusbar'))?.getBoundingClientRect() ?? null
      },
      open: () => target.kind === 'task' ? selectTask(target.id) : selectConversation(target.id),
      holdMs: 12_000
    }
  }, [status.attention, locale])
  if (level === 'off' || settingsOpen || guiding) return null
  return <PetStage skin={skin} level={level} mood={status.mood} message={message} reduced={reduced} />
}
