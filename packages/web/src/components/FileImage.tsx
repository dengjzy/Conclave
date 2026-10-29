import { t } from '../i18n'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { previewUrl } from '../file-links'
import { ImageViewer } from './ImageViewer'

function ImagePreview({ path, src }: { path: string; src: string | undefined }) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [failed, setFailed] = useState(false)
  const [viewing, setViewing] = useState(false)
  const name = path.split(/[\\/]/).at(-1) ?? path
  return <div className="file-image" role="region" aria-label={t('FileImage.imagePreview')} aria-busy={!size && !failed}>
    {failed ? <p className="inspector-empty muted" role="status">{t('FileImage.cannotPreviewImageItMayHaveBeenMoved')}</p> : <>
      <button type="button" className="file-image-stage" aria-label={t('FileImage.viewFullImage', { name: name })} title={t('FileImage.clickToViewFullImage')} disabled={!size} onClick={() => setViewing(true)}>
        {src && <img src={src} alt={name} draggable={false} decoding="async"
          onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          onError={() => setFailed(true)} />}
        {!size && <span className="muted" role="status">{t('FileImage.loadingImage')}</span>}
      </button>
      {size && <div className="file-image-info muted"><span>{size.width} × {size.height}</span><span>{t('FileImage.clickToViewFullImage')}</span></div>}
    </>}
    {viewing && src && size && createPortal(<ImageViewer images={[{ id: src, name, src, ...size }]} index={0} onIndex={() => {}} onClose={() => setViewing(false)} />, document.body)}
  </div>
}

// SVG source stays an image, so scripts and document links cannot run in the app.
export function FileImage({ path, version, text }: { path: string; version?: string; text?: string }) {
  const [inline, setInline] = useState<{ text: string; url: string } | null>(null)
  useEffect(() => {
    if (text === undefined) return
    const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }))
    setInline({ text, url })
    return () => URL.revokeObjectURL(url)
  }, [text])
  const src = text === undefined ? `${previewUrl(path)}${version === undefined ? '' : `?v=${encodeURIComponent(version)}`}` : inline?.text === text ? inline.url : undefined
  return <ImagePreview key={src ?? ''} path={path} src={src} />
}
