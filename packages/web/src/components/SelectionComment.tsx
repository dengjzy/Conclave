import { t } from '../i18n'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { addQuote, useQuotes } from '../chat-quotes'
import { placeCommentBox } from '../plan-comment-place'
import { selectedTextIn, type SelectedText } from '../text-selection'
import { ContextMenu, MenuItem, type MenuPoint } from './ContextMenu'
import { ChatIcon } from './icons'
import { useOccludesBrowser } from '../browser-occlusion'

// Where each comment's passage lies, by conversation and quote id, for its highlight. A range lasts
// while its text stays rendered; one whose text is gone simply marks nothing.
const passages = new Map<string, Map<string, Range>>()

function passagesOf(conversationId: string): Map<string, Range> {
  const known = passages.get(conversationId) ?? new Map<string, Range>()
  passages.set(conversationId, known)
  return known
}

type SelectionMenu = { at: MenuPoint; text: string }

function containsPoint(range: Range, x: number, y: number): boolean {
  return [...range.getClientRects()].some((rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)
}

function mark(name: string, ranges: readonly Range[]): void {
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return
  if (ranges.length === 0) CSS.highlights.delete(name)
  else CSS.highlights.set(name, new Highlight(...ranges))
}

// Text selected in one region of the container (a plan, a reply) opens a box over it to say
// something about it. The comment joins the chat's quotes, as a quote the user picked would, and
// goes on from there the same way; the passages commented on stay marked while their quotes wait.
// name: which highlights it draws (conclave-<name>-draft, conclave-<name>-comments; see styles.css).
// focus: the box takes the focus as it opens, where a selection is made to comment on; elsewhere it
// waits for the user to type, so a selection made to copy still copies. A right-click closes the box
// for the menu; copyMenu: that menu is this one, copying the passage, for a box that took the focus
// and with it the live selection.
export function SelectionComment({ conversationId, container, region, sourceOf, name, label, focus = false, copyMenu = false, hidden = false, onAdded }: {
  conversationId: string
  container: RefObject<HTMLElement | null>
  region: string
  sourceOf: (region: HTMLElement) => string | null
  name: string
  label: string
  focus?: boolean
  copyMenu?: boolean
  // Kept, but out of sight, while something else (the chat's own menu) is over the passage.
  hidden?: boolean
  onAdded?: () => void
}) {
  const [draft, setDraft] = useState<SelectedText | null>(null)
  const [comment, setComment] = useState('')
  const [menu, setMenu] = useState<SelectionMenu | null>(null)
  // Bumped when the container scrolls under a box being written in, which then follows its passage.
  const [, setMoved] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const quotes = useQuotes(conversationId)
  const draftName = `conclave-${name}-draft`
  const commentedName = `conclave-${name}-comments`

  // A new selection opens the box; with the box open, the focus in it must not close it.
  useEffect(() => {
    const element = container.current
    if (!element || draft) return
    // A right button's release is the menu's, not a new selection.
    const settle = (event: Event) => event instanceof MouseEvent && event.button !== 0 ? undefined : setTimeout(() => {
      const picked = selectedTextIn(element, region)
      if (picked) {
        setComment('')
        setDraft(picked)
      }
    }, 0)
    document.addEventListener('mouseup', settle)
    element.addEventListener('keyup', settle)
    return () => {
      document.removeEventListener('mouseup', settle)
      element.removeEventListener('keyup', settle)
    }
  }, [container, region, draft])

  // A right-click is for the menu: the box goes and the menu shows alone. With copyMenu that menu
  // is this one, which copies the passage; the focus the box took has the browser's live selection
  // gone by then, so the cloned range says what was chosen.
  useEffect(() => {
    const element = container.current
    if (!element) return
    const open = (event: MouseEvent) => {
      const picked = copyMenu ? selectedTextIn(element, region) ?? (draft && containsPoint(draft.range, event.clientX, event.clientY) ? draft : null) : null
      setDraft(null)
      if (!picked) return
      event.preventDefault()
      setMenu({ at: { x: event.clientX, y: event.clientY }, text: picked.text })
    }
    element.addEventListener('contextmenu', open)
    return () => element.removeEventListener('contextmenu', open)
  }, [container, region, draft, copyMenu])

  // Without the focus, the first key typed while the passage is selected starts the comment.
  useEffect(() => {
    if (!draft || focus) return
    const type = (event: KeyboardEvent) => {
      if (document.activeElement === input.current || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === 'Escape') setDraft(null)
      else if (event.key.length === 1 || event.key === 'Process') input.current?.focus()
    }
    document.addEventListener('keydown', type, true)
    return () => document.removeEventListener('keydown', type, true)
  }, [draft, focus])

  useEffect(() => {
    mark(draftName, draft ? [draft.range] : [])
    return () => mark(draftName, [])
  }, [draft, draftName])

  // Of the quotes still waiting, the passages in this container.
  useEffect(() => {
    const element = container.current
    const live = new Set(quotes.map((quote) => quote.id))
    const known = passagesOf(conversationId)
    for (const id of known.keys()) if (!live.has(id)) known.delete(id)
    mark(commentedName, quotes.flatMap((quote) => {
      const range = known.get(quote.id)
      return range && element?.contains(range.commonAncestorContainer) ? [range] : []
    }))
  }, [quotes, commentedName, container, conversationId])
  useEffect(() => () => mark(commentedName, []), [commentedName])

  useEffect(() => {
    if (!draft) return
    const close = () => setDraft(null)
    const outside = (event: PointerEvent) => {
      // A right-click in the container closes it as its menu opens (see above), knowing the passage.
      if (event.button === 2 && event.target instanceof Node && container.current?.contains(event.target)) return
      if (!(event.target instanceof Element && event.target.closest('.selection-comment-box'))) close()
    }
    // A box with nothing written yet goes with a scroll; one being written follows its passage.
    const scrolled = () => (comment ? setMoved((count) => count + 1) : close())
    const element = container.current
    document.addEventListener('pointerdown', outside, true)
    element?.addEventListener('scroll', scrolled)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      element?.removeEventListener('scroll', scrolled)
      window.removeEventListener('resize', close)
    }
  }, [draft, container, comment])

  const add = () => {
    if (!draft) return
    const id = addQuote(conversationId, sourceOf(draft.region), draft.text, comment)
    if (id) passagesOf(conversationId).set(id, draft.range)
    document.getSelection()?.removeAllRanges()
    setDraft(null)
    onAdded?.()
  }
  const bounds = container.current?.closest('.side-panel, .chat-view')?.getBoundingClientRect()
  const passage = draft?.range.getBoundingClientRect()
  const place = draft && passage ? placeCommentBox({
    passage,
    anchorX: draft.x,
    panel: bounds ? { left: bounds.left, right: bounds.right } : null,
    viewport: { width: window.innerWidth, height: window.innerHeight }
  }) : null
  useOccludesBrowser(Boolean(draft && place && !hidden))
  return (
    <>
      {draft && place && !hidden && createPortal(
        <div className="selection-comment-box" style={{ left: place.left, top: place.top }} role="dialog" aria-label={label}>
          <ChatIcon />
          <input
            ref={input}
            className="selection-comment-input"
            autoFocus={focus}
            value={comment}
            placeholder={t('SelectionComment.commentOnThisPassage')}
            aria-label={t('SelectionComment.commentOnThisPassageEnterToAddQuote')}
            onChange={(event) => setComment(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'Enter') {
                event.preventDefault()
                add()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setDraft(null)
              }
            }}
          />
          <button type="button" className="selection-comment-save" aria-label={t('SelectionComment.addQuote')} data-tooltip={t('SelectionComment.addQuoteEnter')} data-tooltip-side="top-end" onMouseDown={(event) => event.preventDefault()} onClick={add}>
            ↵
          </button>
        </div>,
        document.body
      )}
      {menu && (
        <ContextMenu at={menu.at} label={t('SelectionComment.selectedText')} onClose={closeMenu}>
          <MenuItem
            label={t('CopyButton.copy')}
            onSelect={() => {
              closeMenu()
              void navigator.clipboard.writeText(menu.text).catch(() => {})
            }}
          />
        </ContextMenu>
      )}
    </>
  )
}
