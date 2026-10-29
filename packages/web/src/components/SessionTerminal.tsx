import { t } from '../i18n'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useCore } from '../core-store'
import { createTerminalSurface } from './terminal-surface'

const ignore = () => {}

// Where a mouse selection ended, in the frame's box: what is done with it shows there.
type Picked = { x: number; y: number }

// selectionAction: shown by a passage just selected with the mouse, until it is cleared, the view
// scrolls or the user types; dismiss puts it away.
export function SessionTerminal({ sessionId, selectionAction }: { sessionId: string; selectionAction?: (dismiss: () => void) => ReactNode }) {
  const container = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const rpc = useCore((s) => s.rpc)
  const [picked, setPicked] = useState<Picked | null>(null)
  const dismiss = useCallback(() => setPicked(null), [])

  useEffect(() => {
    const element = container.current
    if (!element || !rpc) {
      return
    }
    const surface = createTerminalSurface(element, rpc, sessionId)
    const { term, sendSize } = surface
    // Opened by the user, so keystrokes should reach the shell at once.
    term.focus()

    let disposed = false
    let attached = false
    let cursor = 0
    const queued: Array<{ offset: number; data: string }> = []
    const writeAt = (offset: number, data: string) => {
      const skip = Math.max(0, cursor - offset)
      if (skip < data.length) {
        term.write(data.slice(skip))
        cursor = offset + data.length
      }
    }
    const stopData = rpc.on('sessions.data', (event) => {
      if (event.sessionId !== sessionId || disposed) return
      if (!attached) queued.push(event)
      else writeAt(event.offset, event.data)
    })
    const stopExit = rpc.on('sessions.exit', (event) => {
      if (event.sessionId === sessionId && !disposed) term.write(t('SessionTerminal.2mProcessExitedCode0m', { value1: event.exitCode }))
    })

    rpc
      .call('sessions.attach', { sessionId })
      .then(({ buffer, bufferStart, exited }) => {
        if (disposed) {
          return
        }
        writeAt(bufferStart, buffer)
        queued.sort((a, b) => a.offset - b.offset).forEach((event) => writeAt(event.offset, event.data))
        queued.length = 0
        attached = true
        if (exited) {
          term.write(t('SessionTerminal.2mSessionEnded0m'))
          return
        }
        sendSize()
      })
      .catch((error: unknown) => {
        term.write(t('SessionTerminal.cannotConnectToSession', { value1: error instanceof Error ? error.message : String(error) }))
      })

    const input = term.onData((data) => {
      setPicked(null)
      void rpc.call('sessions.write', { sessionId, data }).catch(ignore)
    })
    // Read once the mouse is up, when xterm has settled the selection; a click that cleared it shows nothing.
    const released = (event: MouseEvent) => {
      if (event.button !== 0) return
      setTimeout(() => {
        const box = frame.current?.getBoundingClientRect()
        if (disposed || !box || !term.hasSelection() || !term.getSelection().trim()) return
        setPicked({ x: event.clientX - box.left, y: event.clientY - box.top })
      }, 0)
    }
    element.addEventListener('mouseup', released)
    const selection = term.onSelectionChange(() => { if (!term.hasSelection()) setPicked(null) })
    const scroll = term.onScroll(() => setPicked(null))
    return () => {
      disposed = true
      stopData()
      stopExit()
      input.dispose()
      element.removeEventListener('mouseup', released)
      selection.dispose()
      scroll.dispose()
      surface.dispose()
      void rpc.call('sessions.detach', { sessionId }).catch(ignore)
    }
  }, [rpc, sessionId])

  // FitAddon sizes rows from the host's box and ignores its padding, so the
  // padding and background live on a frame around a padding-free host.
  return (
    <div className="terminal-frame" ref={frame}>
      <div className="terminal" ref={container} />
      {picked && selectionAction && <SelectionAction at={picked} frame={frame.current}>{selectionAction(dismiss)}</SelectionAction>}
    </div>
  )
}

// Just under where the mouse let go, kept inside the frame: above the point near its bottom, and
// short of its right edge.
function SelectionAction({ at, frame, children }: { at: Picked; frame: HTMLDivElement | null; children: ReactNode }) {
  const width = frame?.clientWidth ?? Infinity
  const height = frame?.clientHeight ?? Infinity
  const left = Math.max(4, Math.min(at.x - 12, width - 140))
  const top = at.y + 40 > height ? Math.max(4, at.y - 36) : at.y + 10
  return <div className="terminal-selection-action" style={{ left, top }}>{children}</div>
}
