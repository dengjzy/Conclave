import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import path from 'node:path'
import { z } from 'zod'

export const REMOTE_DEVICE_WRITE_LIMIT = 4096

const SavedDevice = z.object({
  id: z.string().uuid(), name: z.string().min(1).max(80),
  createdAt: z.number(), lastSeenAt: z.number(),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  writes: z.array(z.object({ requestId: z.string().min(1).max(128), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(REMOTE_DEVICE_WRITE_LIMIT)
}).strict()
export type SavedRemoteDevice = z.infer<typeof SavedDevice>
const SavedState = z.object({
  version: z.literal(1), nodeId: z.string().uuid(), nodeName: z.string().min(1).max(80),
  port: z.number().int().min(1).max(65535).optional(), devices: z.array(SavedDevice).max(64)
}).strict().refine((state) => state.devices.length === 0 || state.port !== undefined, 'Paired devices require a stable gateway port')
type State = z.infer<typeof SavedState>

function writeState(file: string, state: State): void {
  const temporary = `${file}.${randomUUID()}.partial`
  try {
    const fd = openSync(temporary, 'wx', 0o600)
    try { writeFileSync(fd, `${JSON.stringify(state)}\n`); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temporary, file)
    const directory = openSync(path.dirname(file), 'r')
    try { fsyncSync(directory) } finally { closeSync(directory) }
  } finally {
    try { unlinkSync(temporary) } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
  }
}

export class RemoteState {
  private constructor(private readonly file: string, private state: State) {}

  static async open(directory: string): Promise<RemoteState> {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    const file = path.join(directory, 'devices.json')
    let state: State
    try {
      const text = await readFile(file, 'utf8')
      if (Buffer.byteLength(text) > 64 * 1024 * 1024) throw new Error('Remote device state is too large')
      state = SavedState.parse(JSON.parse(text))
      if (new Set(state.devices.map((device) => device.id)).size !== state.devices.length) throw new Error('Duplicate remote devices')
      for (const device of state.devices) if (new Set(device.writes.map((write) => write.requestId)).size !== device.writes.length) throw new Error('Duplicate remote write records')
      await chmod(file, 0o600)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      state = { version: 1, nodeId: randomUUID(), nodeName: hostname().trim().slice(0, 80) || 'Conclave', devices: [] }
      writeState(file, state)
    }
    return new RemoteState(file, state)
  }

  get identity(): { nodeId: string; nodeName: string } { return { nodeId: this.state.nodeId, nodeName: this.state.nodeName } }
  get port(): number | undefined { return this.state.port }
  get devices(): readonly SavedRemoteDevice[] { return this.state.devices }

  save(port: number | undefined, devices: SavedRemoteDevice[]): void {
    const next = SavedState.parse({ ...this.state, port, devices })
    // The durable tombstone must precede a side effect, including process crashes.
    writeState(this.file, next)
    this.state = next
  }
}
