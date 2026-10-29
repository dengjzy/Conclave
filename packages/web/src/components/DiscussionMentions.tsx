import { t, tr } from '../i18n'
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject, type TextareaHTMLAttributes } from 'react'
import type { DiscussionMember } from '@conclave/protocol'
import { EVERYONE, mentionChoices, mentionQuery } from '../discussions'
import { agentLabel } from '../labels'
import { AgentIcon } from './icons'

type Choice = DiscussionMember | typeof EVERYONE
type InputProps = Pick<TextareaHTMLAttributes<HTMLTextAreaElement>, 'aria-autocomplete' | 'aria-expanded' | 'aria-controls' | 'aria-activedescendant' | 'onSelect'>

function MentionOption({ choice, id, active, onHover, onPick }: { choice: Choice; id: string; active: boolean; onHover: () => void; onPick: () => void }) {
  const row = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (active) row.current?.scrollIntoView({ block: 'nearest' })
  }, [active])
  const everyone = choice === EVERYONE
  return (
    <li
      ref={row}
      id={id}
      role="option"
      aria-selected={active}
      className="chat-command-option discussion-mention-option"
      // Keeps the focus in the input, which goes on taking the keys.
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={(event) => {
        if (!active && (event.movementX !== 0 || event.movementY !== 0)) onHover()
      }}
      onClick={onPick}
    >
      <span className="discussion-mention-mark" aria-hidden="true">{everyone ? '@' : <AgentIcon agent={choice.agent} />}</span>
      <span className="chat-command-option-name">{everyone ? t('discussions.everyone') : choice.name}</span>
      <span className="chat-command-option-description">
        {everyone ? t('DiscussionMentions.askEveryMemberToAnswerNow') : choice.status !== 'idle' ? t('DiscussionMentions.stillSpeaking') : t('DiscussionMentions.askOnlyThem', { value1: choice.model ?? agentLabel(choice.agent) })}
      </span>
    </li>
  )
}

// The @ list over a group chat's input: everyone, then the members, narrowed as a name is typed.
// Enter or Tab puts the pick in as @name, Esc puts the list away until the text changes.
export function useDiscussionMentionMenu({ text, setText, members, input }: {
  text: string
  setText: (text: string) => void
  members: readonly DiscussionMember[]
  input: RefObject<HTMLTextAreaElement | null>
}): {
  menu: ReactNode
  inputProps: InputProps
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean
  track: (element: HTMLTextAreaElement) => void
} {
  const listId = useId()
  const [caret, setCaret] = useState(0)
  const [highlight, setHighlight] = useState(0)
  const [closedAt, setClosedAt] = useState<string | null>(null)
  const found = mentionQuery(text, caret)
  const choices = found ? mentionChoices(members, found.query) : []
  const open = found !== null && text !== closedAt && choices.length > 0
  const active = Math.min(highlight, choices.length - 1)
  const query = found?.query ?? null
  useEffect(() => setHighlight(0), [query])

  const track = (element: HTMLTextAreaElement) => setCaret(element.selectionStart)
  const pick = (choice: Choice) => {
    if (!found) return
    const inserted = `@${choice === EVERYONE ? t('discussions.everyone').toLowerCase() : choice.name} `
    const before = text.slice(0, found.start)
    const next = `${before}${inserted}${text.slice(caret).replace(/^ /, '')}`
    const at = before.length + inserted.length
    setText(next)
    setCaret(at)
    requestAnimationFrame(() => {
      input.current?.focus()
      input.current?.setSelectionRange(at, at)
    })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey) return false
    const choice = choices[active]
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const step = event.key === 'ArrowDown' ? 1 : -1
      setHighlight((active + step + choices.length) % choices.length)
    } else if (event.key === 'Escape') {
      setClosedAt(text)
    } else if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
      if (choice) pick(choice)
    } else {
      return false
    }
    event.preventDefault()
    return true
  }

  const optionId = (index: number) => `${listId}-${index}`
  const menu = open ? (
    <div className="menu menu-up chat-command-menu discussion-mention-menu">
      <ul id={listId} role="listbox" aria-label={t('DiscussionMentions.mentionMember')} className="menu-list">
        {choices.map((choice, index) => (
          <MentionOption
            key={choice === EVERYONE ? EVERYONE : choice.id}
            choice={choice}
            id={optionId(index)}
            active={index === active}
            onHover={() => setHighlight(index)}
            onPick={() => pick(choice)}
          />
        ))}
      </ul>
      <div className="chat-command-keys" aria-hidden="true">{tr('DiscussionMentions.navigateSelectClose', { value1: <kbd>↑↓</kbd>, value2: <kbd>Enter</kbd>, value3: <kbd>Esc</kbd> })}</div>
    </div>
  ) : null

  const inputProps: InputProps = {
    'aria-autocomplete': 'list',
    'aria-expanded': open,
    'aria-controls': open ? listId : undefined,
    'aria-activedescendant': open ? optionId(active) : undefined,
    onSelect: (event) => track(event.currentTarget)
  }
  return { menu, inputProps, onKeyDown, track }
}
