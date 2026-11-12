import { t, tr } from '../i18n'
import { useContext, useEffect, useRef, useState, type RefObject } from 'react'
import { CODEX_IMAGE_GENERATION, toolImagePath, type ChatItem } from '@conclave/protocol'
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

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

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

function ToolShot({ image, onOpen }: { image: NonNullable<ToolItem['images']>[number]; onOpen: () => void }) {
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

function outputBeside(output: string | null, shown: boolean): string | null {
  if (!shown || output === null) return output
  return output.split('\n').filter((line) => line.trim() !== '[图片]').join('\n').trim() || null
}

// A call that brought back pictures (e.g. an MCP screenshot), looked at one on disk, or drew one.
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
      {images.map((image, index) => <ToolShot key={image.id} image={image} onOpen={() => setViewing(index)} />)}
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
