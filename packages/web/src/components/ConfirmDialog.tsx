import { useEffect, useRef } from 'react'
import { useConfirmDialog } from '../confirm-dialog'
import { useOccludesBrowser } from '../browser-occlusion'
import { t } from '../i18n'
import { CloseIcon, TrashIcon, WarningIcon } from './icons'

export function ConfirmDialog() {
  const current = useConfirmDialog((state) => state.current)
  useOccludesBrowser(current !== null)

  const dialogRef = useRef<HTMLDialogElement>(null)
  const confirmBtnRef = useRef<HTMLButtonElement>(null)
  const cancelBtnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    if (current) {
      if (!dialog.open) {
        dialog.showModal()
      }
      // For danger actions (like deletions), focus cancel by default to prevent accidental trigger;
      // for regular confirmations, focus confirm.
      if (current.danger) {
        cancelBtnRef.current?.focus()
      } else {
        confirmBtnRef.current?.focus()
      }
    } else {
      if (dialog.open) {
        dialog.close()
      }
    }
  }, [current])

  if (!current) return null

  const title = current.title || (current.danger ? t('ConfirmDialog.warning') : t('ConfirmDialog.confirm'))
  const confirmLabel = current.confirmLabel || (current.danger ? t('ConfirmDialog.delete') : t('ConfirmDialog.confirm'))
  const cancelLabel = current.cancelLabel || t('ConfirmDialog.cancel')

  const handleCancel = () => {
    current.answer(false)
  }

  const handleConfirm = () => {
    current.answer(true)
  }

  const handleBackdropClick = (event: React.MouseEvent<HTMLDialogElement>) => {
    if (event.target === dialogRef.current) {
      handleCancel()
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="modal confirm-dialog"
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-message"
      onClick={handleBackdropClick}
      onCancel={(event) => {
        event.preventDefault()
        handleCancel()
      }}
    >
      <div className="modal-body confirm-dialog-body">
        <div className="confirm-dialog-content">
          <div className={`confirm-dialog-icon ${current.danger ? 'danger' : 'accent'}`} aria-hidden="true">
            {current.danger ? <TrashIcon /> : <WarningIcon />}
          </div>
          <div className="confirm-dialog-text">
            <h2 id="confirm-dialog-title" className="confirm-dialog-title">
              {title}
            </h2>
            <p id="confirm-dialog-message" className="confirm-dialog-message">
              {current.message}
            </p>
          </div>
          <button
            type="button"
            className="icon-button modal-close confirm-dialog-close"
            aria-label={t('BackdropPicker.close')}
            onClick={handleCancel}
          >
            <CloseIcon />
          </button>
        </div>
        <footer className="modal-footer confirm-dialog-footer">
          <button
            type="button"
            className="button ghost"
            ref={cancelBtnRef}
            onClick={handleCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`button ${current.danger ? 'danger' : 'primary'}`}
            ref={confirmBtnRef}
            onClick={handleConfirm}
          >
            {confirmLabel}
          </button>
        </footer>
      </div>
    </dialog>
  )
}
