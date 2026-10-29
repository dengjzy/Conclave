import { describe, expect, it } from 'vitest'
import { askConfirm, useConfirmDialog } from './confirm-dialog'

describe('confirm-dialog', () => {
  it('opens a dialog and resolves true when confirmed', async () => {
    const promise = askConfirm({
      title: '删除会话',
      message: '确定要删除会话吗？',
      danger: true
    })

    const current = useConfirmDialog.getState().current
    expect(current).not.toBeNull()
    expect(current?.title).toBe('删除会话')
    expect(current?.message).toBe('确定要删除会话吗？')
    expect(current?.danger).toBe(true)

    current?.answer(true)
    const result = await promise
    expect(result).toBe(true)
    expect(useConfirmDialog.getState().current).toBeNull()
  })

  it('resolves false when canceled', async () => {
    const promise = askConfirm('确定继续吗？')
    const current = useConfirmDialog.getState().current
    expect(current).not.toBeNull()
    expect(current?.message).toBe('确定继续吗？')

    current?.answer(false)
    const result = await promise
    expect(result).toBe(false)
    expect(useConfirmDialog.getState().current).toBeNull()
  })

  it('cancels previous dialog if a new one is opened', async () => {
    const firstPromise = askConfirm('第一个确认')
    const secondPromise = askConfirm('第二个确认')

    const firstResult = await firstPromise
    expect(firstResult).toBe(false)

    const current = useConfirmDialog.getState().current
    expect(current?.message).toBe('第二个确认')
    current?.answer(true)

    const secondResult = await secondPromise
    expect(secondResult).toBe(true)
  })
})
