import { getLocale, t } from '../i18n'
import { useEffect, useId, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { imageLabel, MAX_IMAGE_NAME_LENGTH, type TaskImage } from '@conclave/protocol'
import { useImageUrl } from '../attachment-images'
import { useOccludesBrowser } from '../browser-occlusion'
import { clampPan, FITTED, fitScale, MAX_SCALE, MIN_SCALE, overhangs, scaleOf, turn, ZOOM_STEP, zoomBy, type ImageView, type Point, type Size } from '../image-view'
import { RotateLeftIcon, RotateRightIcon, ZoomInIcon, ZoomOutIcon } from './icons'

// A wheel notch is about 100 pixels of delta; a trackpad pinch arrives as small ones with ctrlKey.
const WHEEL_ZOOM = 0.0015
const PINCH_ZOOM = 0.01

// An image kept in core, or with `src`, one read from elsewhere (a file a reply names), whose size
// is learned as it loads.
export type ViewerImage = TaskImage & { src?: string }

// One image, fitted to the window, then zoomed, turned and dragged about; the neighbours a keypress away. `onRename` makes the name
// editable; without it (an issue's images) the viewer is read-only.
export function ImageViewer({
  images,
  index,
  note,
  onIndex,
  onClose,
  onRename
}: {
  images: readonly ViewerImage[]
  index: number
  note?: string
  onIndex: (index: number) => void
  onClose: () => void
  onRename?: (id: string, name: string) => void
}) {
  useOccludesBrowser()
  const dialog = useRef<HTMLDialogElement>(null)
  const ids = useId()
  const image = images[index]
  const stored = useImageUrl(image && !image.src ? image.id : '')
  const url = image?.src ?? stored
  const [name, setName] = useState(image?.name ?? '')
  const [loaded, setLoaded] = useState<{ width: number; height: number } | null>(null)
  const [failed, setFailed] = useState(false)
  const stageRef = useRef<HTMLDivElement>(null)
  const [stage, setStage] = useState<Size>({ width: 0, height: 0 })
  const [view, setView] = useState<ImageView>(FITTED)
  const [drag, setDrag] = useState<{ pointer: number; from: Point; pan: Point } | null>(null)
  const natural: Size | null = image && image.width > 0 ? { width: image.width, height: image.height } : loaded
  // What the wheel listener, attached once, reads.
  const sizes = useRef({ natural, stage })
  sizes.current = { natural, stage }

  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) {
      element.showModal()
    }
    return () => element?.close()
  }, [])

  useEffect(() => {
    setName(image?.name ?? '')
  }, [image?.id, image?.name])

  useEffect(() => {
    setLoaded(null)
    setFailed(false)
    setView(FITTED)
  }, [url])

  useEffect(() => {
    const element = stageRef.current
    if (!element) return
    const observer = new ResizeObserver(() => setStage({ width: element.clientWidth, height: element.clientHeight }))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Zooms toward the pointer. Attached by hand: React's wheel listener is passive, and a pinch left
  // to the page would zoom the whole window.
  useEffect(() => {
    const element = stageRef.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      const { natural, stage } = sizes.current
      if (!natural) return
      event.preventDefault()
      const bounds = element.getBoundingClientRect()
      const at = { x: event.clientX - bounds.left - bounds.width / 2, y: event.clientY - bounds.top - bounds.height / 2 }
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? PINCH_ZOOM : WHEEL_ZOOM))
      setView((view) => zoomBy(view, factor, natural, stage, at))
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [])

  if (!image) {
    return null
  }
  const go = (step: number) => onIndex((index + step + images.length) % images.length)
  const scale = natural ? scaleOf(view, natural, stage) : 1
  const zoom = (factor: number) => natural && setView((view) => zoomBy(view, factor, natural, stage))
  const rotate = (by: 1 | -1) => setView((view) => turn(view, by))
  const fit = () => setView((view) => ({ ...view, zoom: 1, pan: { x: 0, y: 0 } }))
  const movable = natural !== null && overhangs(natural, stage, view)
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!movable || event.button !== 0 || event.target !== event.currentTarget.querySelector('img')) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setDrag({ pointer: event.pointerId, from: { x: event.clientX, y: event.clientY }, pan: view.pan })
  }
  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag || drag.pointer !== event.pointerId || !natural) return
    const pan = { x: drag.pan.x + event.clientX - drag.from.x, y: drag.pan.y + event.clientY - drag.from.y }
    setView((view) => ({ ...view, pan: clampPan(pan, natural, stage, view) }))
  }
  // A double click toggles between fitted and the image's own size, at the point clicked.
  const toggleActualSize = (event: ReactMouseEvent<HTMLImageElement>) => {
    if (!natural) return
    if (view.zoom !== 1) {
      fit()
      return
    }
    const bounds = stageRef.current?.getBoundingClientRect()
    const at = bounds ? { x: event.clientX - bounds.left - bounds.width / 2, y: event.clientY - bounds.top - bounds.height / 2 } : undefined
    setView((view) => zoomBy(view, 1 / fitScale(natural, stage, view.turns), natural, stage, at))
  }
  const commitName = () => {
    if (onRename && name.trim() !== image.name) {
      onRename(image.id, name.trim())
    }
  }

  return (
    <dialog
      ref={dialog}
      className="image-viewer"
      aria-labelledby={`${ids}-title`}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => event.target === dialog.current && onClose()}
      onKeyDown={(event) => {
        if (event.target instanceof HTMLInputElement) {
          return
        }
        if (event.key === 'ArrowLeft') {
          go(-1)
        } else if (event.key === 'ArrowRight') {
          go(1)
        } else if (event.key === '+' || event.key === '=') {
          zoom(ZOOM_STEP)
        } else if (event.key === '-') {
          zoom(1 / ZOOM_STEP)
        } else if (event.key === '0') {
          fit()
        } else if (event.key === 'r' || event.key === 'R') {
          rotate(event.shiftKey ? -1 : 1)
        }
      }}
    >
      <header className="image-viewer-header">
        <span id={`${ids}-title`} className="image-viewer-title">
          {imageLabel({ name: '' }, index, getLocale())}
          <span className="muted"> / {images.length}</span>
        </span>
        {onRename ? (
          <input
            className="input image-viewer-name"
            value={name}
            placeholder={t('ImageViewer.nameThisImageOptional')}
            maxLength={MAX_IMAGE_NAME_LENGTH}
            aria-label={t('ImageViewer.imageName')}
            onChange={(event) => setName(event.target.value)}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.currentTarget.blur()
              }
            }}
          />
        ) : (
          <span className="image-viewer-name-static">{image.name}</span>
        )}
        {note && <span className="muted image-viewer-note">{note}</span>}
        <button type="button" className="icon-button" aria-label={t('BackdropPicker.close')} onClick={onClose}>
          ×
        </button>
      </header>
      <div
        ref={stageRef}
        className="image-viewer-stage"
        data-movable={movable || undefined}
        data-dragging={drag ? true : undefined}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={() => setDrag(null)}
        onPointerCancel={() => setDrag(null)}
      >
        {images.length > 1 && (
          <button type="button" className="image-viewer-step" aria-label={t('ImageViewer.previousImage')} onClick={() => go(-1)}>
            ‹
          </button>
        )}
        {failed ? (
          <span className="muted">{t('ImageViewer.cannotOpenImageFileDoesNotExistOr')}</span>
        ) : url ? (
          <img
            src={url}
            alt={image.name || imageLabel(image, index, getLocale())}
            draggable={false}
            style={natural ? {
              width: natural.width,
              height: natural.height,
              transform: `translate(-50%, -50%) translate(${view.pan.x}px, ${view.pan.y}px) rotate(${view.turns * 90}deg) scale(${scale})`
            } : { visibility: 'hidden' }}
            onLoad={(event) => setLoaded({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
            onError={() => setFailed(true)}
            onDoubleClick={toggleActualSize}
          />
        ) : (
          <span className="muted">{t('ImageViewer.loading')}</span>
        )}
        {images.length > 1 && (
          <button type="button" className="image-viewer-step" aria-label={t('ImageViewer.nextImage')} onClick={() => go(1)}>
            ›
          </button>
        )}
      </div>
      <footer className="image-viewer-footer">
        <div className="image-viewer-tools" role="toolbar" aria-label={t('ImageViewer.zoomAndRotate')}>
          <button type="button" className="icon-button" aria-label={t('ImageViewer.zoomOut')} data-tooltip={t('ImageViewer.zoomOut_1114')} disabled={!natural || scale <= MIN_SCALE} onClick={() => zoom(1 / ZOOM_STEP)}>
            <ZoomOutIcon />
          </button>
          <button type="button" className="image-viewer-scale" aria-label={t('ImageViewer.fitToWindow')} data-tooltip={t('ImageViewer.fitToWindow0')} disabled={!natural} onClick={fit}>
            {Math.round(scale * 100)}%
          </button>
          <button type="button" className="icon-button" aria-label={t('ChatImages.zoomIn')} data-tooltip={t('ImageViewer.zoomIn')} disabled={!natural || scale >= MAX_SCALE} onClick={() => zoom(ZOOM_STEP)}>
            <ZoomInIcon />
          </button>
          <span className="image-viewer-tools-gap" />
          <button type="button" className="icon-button" aria-label={t('ImageViewer.rotateLeft')} data-tooltip={t('ImageViewer.rotateLeftShiftR')} disabled={!natural} onClick={() => rotate(-1)}>
            <RotateLeftIcon />
          </button>
          <button type="button" className="icon-button" aria-label={t('ImageViewer.rotateRight')} data-tooltip={t('ImageViewer.rotateRightR')} disabled={!natural} onClick={() => rotate(1)}>
            <RotateRightIcon />
          </button>
        </div>
        <span className="muted">{natural && `${natural.width} × ${natural.height}`}</span>
      </footer>
    </dialog>
  )
}
