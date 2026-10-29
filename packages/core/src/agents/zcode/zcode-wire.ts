import { crc32 } from 'node:zlib'
import type { WireFrame } from './zcode-schema'

// ZCode splits a topic frame too large for one line into fragments: the frame's UTF-8 bytes in
// base64 pieces, checked by a crc32 of the whole. Pieces gather by frame until the last is in.
export class WireAssembler {
  private readonly parts = new Map<string, { count: number; pieces: Map<number, Buffer>; checksum: string | null }>()

  // The frame whole, once it is: at once for a complete one, at its last piece for a split one;
  // null while pieces are missing, or for one that came apart wrong (it is dropped).
  take(wire: WireFrame): unknown | null {
    if (wire.kind === 'complete') return wire.frame ?? null
    const { fragmentIndex: index, fragmentCount: count, dataBase64: data } = wire
    if (index === undefined || count === undefined || data === undefined || index < 0 || index >= count) return null
    const entry = this.parts.get(wire.logicalFrameId) ?? { count, pieces: new Map<number, Buffer>(), checksum: wire.checksum?.algorithm === 'crc32' ? wire.checksum.value : null }
    entry.pieces.set(index, Buffer.from(data, 'base64'))
    this.parts.set(wire.logicalFrameId, entry)
    if (entry.pieces.size < entry.count) return null
    this.parts.delete(wire.logicalFrameId)
    const bytes = Buffer.concat(Array.from({ length: entry.count }, (_, i) => entry.pieces.get(i) ?? Buffer.alloc(0)))
    if (entry.checksum !== null && crc32(bytes).toString(16).padStart(8, '0') !== entry.checksum) return null
    try {
      return JSON.parse(bytes.toString('utf8'))
    } catch {
      return null
    }
  }
}
