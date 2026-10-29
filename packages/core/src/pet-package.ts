import { createHash } from 'node:crypto'
import { fromBuffer } from 'yauzl'
import { PET_FILES, PET_TYPING_FILES, petAssetFiles, PetManifest, type PetCatalogEntry } from '@conclave/protocol'

export const MAX_PET_PACKAGE_BYTES = 4 * 1024 * 1024
const FILES = ['manifest.json', ...PET_FILES, ...PET_TYPING_FILES]
export const petDigest = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

export function webpSize(data: Buffer): { width: number; height: number } {
  if (data.length < 30 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WEBP' || data.readUInt32LE(4) + 8 !== data.length) throw new Error('Invalid pet image')
  switch (data.toString('ascii', 12, 16)) {
    case 'VP8X':
      if (data[20] === undefined || (data[20] & 2)) throw new Error('Animated pet atlases are not supported')
      return { width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1 }
    case 'VP8 ': return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff }
    case 'VP8L': {
      if (data[20] !== 0x2f) throw new Error('Invalid lossless pet image')
      const bits = data.readUInt32LE(21)
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
    }
    default: throw new Error('Unsupported pet image')
  }
}

export function validatePetFiles(manifest: PetManifest, files: ReadonlyMap<string, Buffer>): void {
  for (const name of petAssetFiles(manifest)) {
    const data = files.get(name), expected = manifest.assets[name]
    if (!data || !expected || data.length !== expected.size || petDigest(data) !== expected.sha256) throw new Error('Pet asset checksum mismatch')
    const { width, height } = webpSize(data)
    const [w, h] = name === 'poses.webp' ? [1024, 1024] : name === 'walk.webp' ? [1024, 768] : name === 'face.webp' ? [288, 80] : [512, 512]
    if (width !== w || height !== h) throw new Error('Pet atlas dimensions do not match format 1')
  }
}

export async function unpackPet(data: Buffer, entry: PetCatalogEntry): Promise<{ manifest: PetManifest; files: Map<string, Buffer> }> {
  if (data.length > MAX_PET_PACKAGE_BYTES || data.length !== entry.size || petDigest(data) !== entry.sha256) throw new Error('Pet package checksum mismatch')
  const files = await new Promise<Map<string, Buffer>>((resolve, reject) => {
    fromBuffer(data, { lazyEntries: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) { reject(error ?? new Error('Invalid pet ZIP')); return }
      const files = new Map<string, Buffer>(); let total = 0
      const fail = (error: unknown) => { zip.close(); reject(error) }
      zip.on('error', fail)
      zip.on('end', () => resolve(files))
      zip.on('entry', (entry) => {
        void (async () => {
          const mode = (entry.externalFileAttributes >>> 16) & 0o170000
          if (!FILES.some((name) => name === entry.fileName) || files.has(entry.fileName) || (mode && mode !== 0o100000)) throw new Error('Pet packages only accept the manifest and supported image files')
          total += entry.uncompressedSize
          if (total > MAX_PET_PACKAGE_BYTES || entry.uncompressedSize > (entry.fileName === 'manifest.json' ? 64 * 1024 : 2 * 1024 * 1024)) throw new Error('Pet package is too large')
          const contents = await new Promise<Buffer>((done, failed) => {
            zip.openReadStream(entry, (error, stream) => {
              if (error || !stream) { failed(error ?? new Error('Cannot read pet ZIP')); return }
              const chunks: Buffer[] = []; let size = 0
              stream.on('data', (chunk: Buffer) => {
                size += chunk.length
                if (size > entry.uncompressedSize) stream.destroy(new Error('Pet file exceeds declared size'))
                else chunks.push(chunk)
              })
              stream.on('error', failed)
              stream.on('end', () => done(Buffer.concat(chunks)))
            })
          })
          files.set(entry.fileName, contents); zip.readEntry()
        })().catch(fail)
      })
      zip.readEntry()
    })
  })
  const manifest = PetManifest.parse(JSON.parse(files.get('manifest.json')?.toString('utf8') ?? 'null'))
  const expected = ['manifest.json', ...petAssetFiles(manifest)]
  if (files.size !== expected.length || [...files.keys()].some((name) => !expected.includes(name))) throw new Error('Pet package is incomplete or contains undeclared images')
  if (manifest.id !== entry.id || manifest.version !== entry.version) throw new Error('Pet package identity mismatch')
  validatePetFiles(manifest, files)
  return { manifest, files }
}
