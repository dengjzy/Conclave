import { describe, expect, it } from 'vitest'
import { askProjectTrust, useProjectTrust } from './project-trust'

const info = (path: string) => ({ path, config: { setup: 'pnpm install' }, hash: 'h', trusted: false })

describe('askProjectTrust', () => {
  it('resolves with the answer and closes the question', async () => {
    const answer = askProjectTrust(info('/code/app'))
    expect(useProjectTrust.getState().asking?.info.path).toBe('/code/app')
    useProjectTrust.getState().asking?.answer(true)
    expect(await answer).toBe(true)
    expect(useProjectTrust.getState().asking).toBeNull()
  })

  it('declines a question still open when another comes', async () => {
    const first = askProjectTrust(info('/code/app'))
    const second = askProjectTrust(info('/code/web'))
    expect(await first).toBe(false)
    expect(useProjectTrust.getState().asking?.info.path).toBe('/code/web')
    useProjectTrust.getState().asking?.answer(false)
    expect(await second).toBe(false)
  })
})
