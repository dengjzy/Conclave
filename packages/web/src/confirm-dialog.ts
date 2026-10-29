import { create } from 'zustand'

export type ConfirmOptions = {
  title?: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

export type ConfirmRequest = ConfirmOptions & {
  id: string
  answer: (confirmed: boolean) => void
}

export const useConfirmDialog = create<{ current: ConfirmRequest | null }>()(() => ({
  current: null
}))

let nextConfirmId = 1

/**
 * Displays an elegant in-app modal confirmation dialog.
 * Resolves to `true` if confirmed, `false` if canceled or dismissed.
 */
export function askConfirm(options: ConfirmOptions | string): Promise<boolean> {
  const normalized: ConfirmOptions = typeof options === 'string'
    ? {
        message: options,
        danger: /删除|delete|remove|清除|销毁|discard|drop|clean|移除|停止/i.test(options)
      }
    : options

  // Decline any previous pending confirmation dialog gracefully
  useConfirmDialog.getState().current?.answer(false)

  return new Promise<boolean>((resolve) => {
    const id = `confirm-${nextConfirmId++}`
    const request: ConfirmRequest = {
      ...normalized,
      id,
      answer: (confirmed: boolean) => {
        if (useConfirmDialog.getState().current?.id === id) {
          useConfirmDialog.setState({ current: null })
        }
        resolve(confirmed)
      }
    }
    useConfirmDialog.setState({ current: request })
  })
}
