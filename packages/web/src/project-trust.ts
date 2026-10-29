import { create } from 'zustand'
import type { ProjectConfigInfo } from '@conclave/protocol'

// The project whose setup and check the user is asked to allow, and where their answer goes.
type Asking = { info: ProjectConfigInfo; answer(allowed: boolean): void }

export const useProjectTrust = create<{ asking: Asking | null }>()(() => ({ asking: null }))

// Resolves with the user's answer; a second question while one is open declines the first.
export function askProjectTrust(info: ProjectConfigInfo): Promise<boolean> {
  useProjectTrust.getState().asking?.answer(false)
  return new Promise((resolve) => {
    const asking: Asking = {
      info,
      answer: (allowed) => {
        if (useProjectTrust.getState().asking === asking) useProjectTrust.setState({ asking: null })
        resolve(allowed)
      }
    }
    useProjectTrust.setState({ asking })
  })
}
