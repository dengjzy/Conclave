import { t, tr } from '../i18n'
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react'
import { IMAGE_MIME_TYPES, MAX_CHAT_IMAGES, type ChatImage } from '@conclave/protocol'
import { copyImageToClipboard, imageFilesOf, uploadImageFiles, useImageUrl } from '../attachment-images'
import { useCore } from '../core-store'
import { fitChatImage } from '../image-fit'
import { useNearView } from '../near-view'
import { CheckIcon, CloseIcon, CopyIcon, ImageIcon, PlusIcon, SearchIcon } from './icons'
import { ImageViewer } from './ImageViewer'
import { Popover } from './Popover'

// Images the composer holds for its next message, uploaded as they come from a paste, a drop or
// the picker, so that sending only names them. `initial`: those of a draft kept from before.
export function useComposerImages(initial: readonly ChatImage[] = []) {
  const [images, setImages] = useState<ChatImage[]>(() => [...initial])
  const [uploading, setUploading] = useState(0)
  const add = (files: File[]) => {
    if (images.length + uploading >= MAX_CHAT_IMAGES) {
      useCore.setState({ error: t('ChatImages.upToImagesPerMessage', { MAX_CHAT_IMAGES: MAX_CHAT_IMAGES }) })
      return
    }
    setUploading((count) => count + files.length)
    void (async () => {
      const uploaded = await uploadImageFiles(await Promise.all(files.map(fitChatImage)))
      setUploading((count) => count - files.length)
      setImages((current) => {
        const known = new Set(current.map((image) => image.id))
        const fresh = uploaded.filter((image) => !known.has(image.id)).map(({ id, width, height }) => ({ id, width, height }))
        const next = [...current, ...fresh].slice(0, MAX_CHAT_IMAGES)
        if (next.length < current.length + fresh.length) useCore.setState({ error: t('ChatImages.upToImagesPerMessage', { MAX_CHAT_IMAGES: MAX_CHAT_IMAGES }) })
        return next
      })
    })()
  }
  const remove = (id: string) => setImages((current) => current.filter((image) => image.id !== id))
  // Only a clipboard or drag that carries image files is taken; text goes where it was going.
  const handlers = {
    onPaste: (event: ClipboardEvent) => {
      const files = imageFilesOf(event.clipboardData)
      if (files.length > 0) {
        event.preventDefault()
        add(files)
      }
    },
    onDragOver: (event: DragEvent) => {
      if (event.dataTransfer.types.includes('Files')) event.preventDefault()
    },
    onDrop: (event: DragEvent) => {
      const files = imageFilesOf(event.dataTransfer)
      if (files.length > 0) {
        event.preventDefault()
        add(files)
      }
    }
  }
  return { images, uploading, add, remove, setImages, handlers }
}

// The ＋ at the start of the row under the input: a menu of what can go into the message, which
// for now is images; the picker it opens takes several at once.
export function ChatAddMenu({ disabled, onAdd }: { disabled?: boolean; onAdd: (files: File[]) => void }) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const input = useRef<HTMLInputElement>(null)
  return (
    <span className="menu-anchor">
      <button
        type="button"
        className="chat-add-button"
        aria-label={t('ChatImages.addContent')}
        data-tooltip={t('ChatImages.addImages')}
        data-tooltip-side="top"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <PlusIcon />
      </button>
      {open && (
        <Popover label={t('ChatImages.addContent')} onClose={close}>
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              close()
              input.current?.click()
            }}
          >
            <ImageIcon />
            <span className="menu-item-title">{t('ChatImages.addImages')}</span>
          </button>
          <div className="menu-label">{t('ChatImages.youCanAlsoPasteOrDragThemInto')}</div>
        </Popover>
      )}
      <input
        ref={input}
        type="file"
        hidden
        multiple
        accept={IMAGE_MIME_TYPES.join(',')}
        onChange={(event) => {
          const files = [...(event.target.files ?? [])]
          // Cleared so choosing the same file again still fires a change.
          event.target.value = ''
          if (files.length > 0) onAdd(files)
        }}
      />
    </span>
  )
}

// Every thumbnail can be opened or copied; one in the composer can also be removed.
function Thumb({ image, onOpen, onRemove }: { image: ChatImage; onOpen: () => void; onRemove?: () => void }) {
  const frame = useRef<HTMLButtonElement>(null)
  const url = useImageUrl(useNearView(frame) ? image.id : '')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <span className="chat-image">
      {/* Keep the same square before and after sending; the viewer keeps the original shape. */}
      <button ref={frame} type="button" className="chat-image-button" aria-label={t('chatTools.viewImage')} data-square="" onClick={onOpen}>
        {url && <img src={url} alt="" draggable={false} />}
      </button>
      <span className="chat-image-actions">
        <button type="button" className="chat-image-action" aria-label={t('ChatImages.zoomIn')} data-tooltip={t('ChatImages.zoomIn')} onClick={onOpen}>
          <SearchIcon />
        </button>
        <button
          type="button"
          className="chat-image-action"
          data-copied={copied || undefined}
          aria-label={copied ? t('BranchStatus.copied') : t('ChatImages.copyImage')}
          data-tooltip={copied ? t('BranchStatus.copied') : t('ChatImages.copyImage')}
          disabled={!url}
          onClick={() => {
            if (!url) return
            void copyImageToClipboard(url).then(
              () => setCopied(true),
              () => useCore.setState({ error: t('ChatImages.failedToCopyImage') })
            )
          }}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
      </span>
      {/* Taking it out sits on the corner, apart from looking at it, as a task's images have it. */}
      {onRemove && (
        <button type="button" className="chat-image-remove" aria-label={t('ChatImages.removeImage')} data-tooltip={t('ChatCommandSettings.delete')} onClick={onRemove}>
          <CloseIcon />
        </button>
      )}
    </span>
  )
}

// A row of small thumbnails, each opening the viewer: a message's images, or the composer's with
// their actions on each.
export function ChatImageStrip({ images, uploading = 0, onRemove }: { images: readonly ChatImage[]; uploading?: number; onRemove?: (id: string) => void }) {
  const [viewing, setViewing] = useState<number | null>(null)
  if (images.length === 0 && uploading === 0) return null
  return (
    <>
      <div className="chat-images">
        {images.map((image, index) => (
          <Thumb key={image.id} image={image} onOpen={() => setViewing(index)} onRemove={onRemove && (() => onRemove(image.id))} />
        ))}
        {uploading > 0 && <span className="image-uploading" role="status">{tr('ChatImages.uploadingImages', { uploading: uploading })}</span>}
      </div>
      {viewing !== null && images.length > 0 && (
        <ImageViewer
          images={images.map((image) => ({ ...image, name: '' }))}
          index={Math.min(viewing, images.length - 1)}
          onIndex={setViewing}
          onClose={() => setViewing(null)}
        />
      )}
    </>
  )
}
