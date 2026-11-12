import { rm } from 'node:fs/promises'
import net from 'node:net'

type ProbeResult = 'live' | 'stale' | 'absent' | 'unknown'

function probe(socketPath: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath)
    socket.setTimeout(1000, () => {
      socket.destroy()
      resolve('unknown')
    })
    socket.once('connect', () => {
      socket.destroy()
      resolve('live')
    })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      resolve(error.code === 'ENOENT' ? 'absent' : error.code === 'ECONNREFUSED' ? 'stale' : 'unknown')
    })
  })
}

// Only a refused connection proves the old daemon is gone; a timeout proves nothing,
// and deleting a live socket would orphan every terminal it still serves.
export async function claimEndpoint(
  socketPath: string,
  options: { reuseExisting?: boolean } = {}
): Promise<'claimed' | 'reused'> {
  if (process.platform === 'win32') {
    return 'claimed'
  }
  const state = await probe(socketPath)
  if (state === 'live') {
    if (options.reuseExisting) {
      return 'reused'
    }
    throw new Error(`another Conclave daemon is already serving ${socketPath}`)
  }
  if (state === 'unknown') {
    throw new Error(`cannot tell whether ${socketPath} is in use; refusing to replace it`)
  }
  if (state === 'stale') {
    await rm(socketPath, { force: true })
  }
  return 'claimed'
}
