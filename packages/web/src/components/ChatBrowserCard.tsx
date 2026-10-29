import { t, tr } from '../i18n'
import { useContext, useEffect, useRef, useState, type RefObject } from 'react'
import { browserToolKind, CODEX_IMAGE_GENERATION, toolImagePath, type ChatItem } from '@conclave/protocol'
import { useImageUrl } from '../attachment-images'
import { useNearView } from '../near-view'
import { ChatFindExpansion, useDisclosure } from '../chat-disclosure'
import { itemKey } from '../chat-state'
import { toolLabel } from '../chat-tools'
import { ChatPaths, ChevronRightIcon, ToolStatus, clipped } from './chat-tool-parts'
import { previewUrl } from '../file-links'
import { LocalImageViewer } from './ChatMarkdown'
import { ImageViewer } from './ImageViewer'
import { ChatToolIcon } from './ChatToolIcon'
import { ChatToolInput } from './ChatToolInput'
import { ChatToolRun } from './ChatToolCard'
import { ChatBrowserWindow } from './ChatBrowserWindow'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

// Whether the shot's frame cuts the picture short: a full-page capture is far taller than the
// frame lets a shot be, and shrunk to fit it would be a sliver nobody can read.
function useCropped(frame: RefObject<HTMLElement | null>, ratio: number): boolean {
  const [cropped, setCropped] = useState(false)
  useEffect(() => {
    const element = frame.current
    if (!element) return
    const measure = () => setCropped(element.offsetWidth * ratio > element.offsetHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [frame, ratio])
  return cropped
}

// A page as the agent saw it: the picture is the point, so it is shown at the card's width, not as
// a thumbnail. One too tall for the frame shows its top, the way the page reads, and opens whole.
function BrowserShot({ image, onOpen }: { image: NonNullable<ToolItem['images']>[number]; onOpen: () => void }) {
  const frame = useRef<HTMLButtonElement>(null)
  const url = useImageUrl(useNearView(frame) ? image.id : '')
  const cropped = useCropped(frame, image.height / image.width)
  return (
    <button ref={frame} type="button" className="chat-browser-shot" data-cropped={cropped || undefined} style={{ aspectRatio: `${image.width} / ${image.height}` }} aria-label={cropped ? t('ChatBrowserCard.viewFullPageScreenshot') : t('ChatBrowserCard.viewScreenshot')} onClick={onOpen}>
      {url && <img src={url} alt="" draggable={false} />}
      {cropped && <span className="chat-browser-shot-more">{t('ChatBrowserCard.fullPageScreenshotClickToView')}</span>}
    </button>
  )
}

// A picture the call looked at on disk, read from where it is (main's preview protocol): what it
// shows is the file as it is now, which a later shot under the same name replaces.
function FileShot({ path }: { path: string }) {
  const [viewing, setViewing] = useState(false)
  const [missing, setMissing] = useState(false)
  if (missing) return <p className="chat-tool-io chat-file-shot-missing muted">{tr('ChatBrowserCard.imageIsNoLongerAvailable', { path: path })}</p>
  const src = previewUrl(path)
  return (
    <>
      <button type="button" className="chat-browser-shot chat-file-shot" aria-label={t('ChatBrowserCard.viewImage', { path: path })} onClick={() => setViewing(true)}>
        <img src={src} alt="" draggable={false} onError={() => setMissing(true)} />
      </button>
      {viewing && <LocalImageViewer images={[{ path, src }]} index={0} onIndex={() => {}} onClose={() => setViewing(false)} />}
    </>
  )
}

// What a result says besides its pictures: the placeholder a picture left is dropped where it shows.
function outputBeside(output: string | null, shown: boolean): string | null {
  if (!shown || output === null) return output
  return output.split('\n').filter((line) => line.trim() !== '[图片]').join('\n').trim() || null
}

// A turn's browser work: its calls folded into one line, and a window on the tabs they left.
export function ChatBrowserRun({ tools }: { tools: readonly ToolItem[] }) {
  return (
    <div className="chat-browser-work">
      <ChatToolRun tools={tools} summary={t('ChatBrowserCard.browserActions', { value1: tools.length })} />
      <ChatBrowserWindow tools={tools} />
    </div>
  )
}

// A browser call that brought back a picture: what it did on the page, and the page as it looked.
export function ChatBrowserCard({ item }: { item: ToolItem }) {
  if (browserToolKind(item.name) === 'navigate' && !item.images?.length) return <ChatBrowserWindow tools={[item]} />
  return <ChatShotCard item={item} />
}

// A call that brought back pictures, or looked at one on disk. Pictures it brought back are the
// point, so they show whole under the call's line: a browser screenshot, an MCP one. A picture it
// read is mostly the agent checking its own work, often shown again as a preview, so it waits
// behind a click and is only loaded once opened. One it drew is the point again, and shows whole.
export function ChatShotCard({ item }: { item: ToolItem }) {
  const searching = useContext(ChatFindExpansion)
  const [open, setOpen] = useDisclosure(`card:${itemKey(item)}`)
  const [viewing, setViewing] = useState<number | null>(null)
  const shorten = useContext(ChatPaths)
  const images = item.images ?? []
  const path = item.status === 'failed' || item.status === 'denied' ? null : toolImagePath(item)
  const drawn = item.name === CODEX_IMAGE_GENERATION
  const output = outputBeside(item.output, images.length > 0 || path !== null)
  const details = Boolean(item.input || output || (path && !drawn))
  return (
    <div className="chat-tool chat-browser" data-status={item.status}>
      <button type="button" className="chat-tool-header" aria-expanded={details ? open : undefined} disabled={!details} onClick={() => setOpen(!open)}>
        <ChatToolIcon name={item.name} display={item.display} status={item.status} />
        <span className="chat-tool-name">{toolLabel(item.name, item.display)}{item.title ? ':' : ''}</span>
        <span className="chat-tool-title mono" title={item.title}>{shorten(item.title)}</span>
        {details && <span className="chat-tool-chevron" aria-hidden="true"><ChevronRightIcon /></span>}
        <ToolStatus status={item.status} since={item.at} />
      </button>
      {item.status === 'running' && <ChatBrowserWindow tools={[item]} />}
      {images.map((image, index) => <BrowserShot key={image.id} image={image} onOpen={() => setViewing(index)} />)}
      {path && (open || drawn) && <FileShot path={path} />}
      {open && item.input && <ChatToolInput name={item.name} input={item.input} />}
      {open && output && <pre className="chat-tool-io">{searching ? output : clipped(output)}</pre>}
      {viewing !== null && images.length > 0 && (
        <ImageViewer
          images={images.map((image) => ({ ...image, name: '' }))}
          index={Math.min(viewing, images.length - 1)}
          onIndex={setViewing}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  )
}
