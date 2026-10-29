import { useContext, useState } from 'react'
import type { ChatItem } from '@conclave/protocol'
import { t } from '../i18n'
import { backgroundLabel, canStop, StopBackground } from '../background-work'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

// Stops one piece of background work where the chat names it. Once asked, it waits for the work to
// report stopped, which takes the button away; it comes back only if the stop did not go through.
export function BackgroundStopButton({ tool }: { tool: ToolItem }) {
  const stop = useContext(StopBackground)
  const [stopping, setStopping] = useState(false)
  if (!stop || !canStop(tool)) return null
  return (
    <button
      type="button"
      className="chat-background-stop"
      disabled={stopping}
      aria-label={t('backgroundWork.stopNamed', { name: backgroundLabel(tool) })}
      onClick={(event) => {
        event.stopPropagation()
        setStopping(true)
        void stop(tool).then((sent) => { if (!sent) setStopping(false) })
      }}
    >
      {stopping ? t('backgroundWork.stopping') : t('backgroundWork.stop')}
    </button>
  )
}
