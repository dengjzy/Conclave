import { useEffect, useState, type RefObject } from 'react'
import { t } from '../i18n'
import { messageTime } from '../labels'

export type TurnStop = {
  key: string
  prompt: string
  reply: string
  at: number | null
}

function cleanSnippet(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`~[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function buildTurnStops(
  userTurns: readonly { key: string; prompt: string; reply: string; at: number | null }[]
): TurnStop[] {
  return userTurns.map((turn) => ({
    key: turn.key,
    prompt: cleanSnippet(turn.prompt) || t('ChatComposer.imagesOnly'),
    reply: cleanSnippet(turn.reply),
    at: turn.at
  }))
}

export function ChatTurnRail({
  turns,
  container,
  onJump
}: {
  turns: readonly TurnStop[]
  container: RefObject<HTMLDivElement | null>
  onJump: (key: string) => void
}) {
  const [activeIndex, setActiveIndex] = useState<number>(() => Math.max(0, turns.length - 1))
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)

  useEffect(() => {
    const element = container.current
    if (!element || turns.length < 2) {
      setActiveIndex(Math.max(0, turns.length - 1))
      return
    }
    const sync = () => {
      if (element.scrollHeight - element.scrollTop - element.clientHeight < 48) {
        setActiveIndex(turns.length - 1)
        return
      }
      const threshold = element.scrollTop + Math.min(120, element.clientHeight * 0.3)
      let current = 0
      turns.forEach((turn, idx) => {
        const node = element.querySelector<HTMLElement>(`[data-entry-key="${CSS.escape(turn.key)}"]`)
        if (node && node.offsetTop <= threshold) current = idx
      })
      setActiveIndex(current)
    }
    sync()
    element.addEventListener('scroll', sync, { passive: true })
    return () => element.removeEventListener('scroll', sync)
  }, [container, turns])

  if (turns.length < 2) return null

  const preview = previewIndex !== null ? turns[previewIndex] ?? null : null

  return (
    <nav
      className="chat-turn-rail"
      aria-label={t('ChatTurnRail.label')}
      onMouseLeave={() => setPreviewIndex(null)}
    >
      <div className="chat-turn-dots">
        {turns.map((turn, index) => {
          const active = index === activeIndex
          const number = index + 1
          return (
            <button
              key={turn.key}
              type="button"
              className="chat-turn-dot"
              data-active={active || undefined}
              aria-current={active ? 'step' : undefined}
              aria-label={t('ChatTurnRail.turnButton', {
                index: number,
                total: turns.length,
                prompt: turn.prompt.slice(0, 60)
              })}
              onMouseEnter={() => setPreviewIndex(index)}
              onFocus={() => setPreviewIndex(index)}
              onBlur={() => setPreviewIndex((prev) => (prev === index ? null : prev))}
              onClick={() => {
                setActiveIndex(index)
                onJump(turn.key)
              }}
            >
              <span className="chat-turn-dot-pip" aria-hidden="true" />
            </button>
          )
        })}
      </div>

      {preview && previewIndex !== null && (
        <div className="chat-turn-card" role="tooltip">
          <p className="chat-turn-card-prompt">{`${previewIndex + 1}. ${preview.prompt}`}</p>
          {preview.reply && <p className="chat-turn-card-reply">{preview.reply}</p>}
          <div className="chat-turn-card-meta">
            <span>{t('ChatTurnRail.counter', { index: previewIndex + 1, total: turns.length })}</span>
            {preview.at !== null && <span>{messageTime(preview.at)}</span>}
          </div>
        </div>
      )}
    </nav>
  )
}
