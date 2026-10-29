import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PluginManifest } from '@conclave/protocol'

export async function pluginFixture(directory: string, options: { id?: string; version?: string; source?: string; behavior?: Record<string, unknown>; env?: string[] } = {}) {
  await mkdir(directory, { recursive: true })
  const manifest = PluginManifest.parse({
    id: options.id ?? 'demo.source', version: options.version ?? '1.0.0', engines: { conclave: '>=0.0.1-0 <1.0.0' },
    contributes: { sources: [{ id: options.source ?? 'demo', name: 'Demo', settings: [{ key: 'query', type: 'text', label: 'Query', required: false }] }] },
    entry: { runtime: 'node', main: 'main.mjs' }, env: options.env ?? []
  })
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest))
  await writeFile(path.join(directory, 'behavior.json'), JSON.stringify(options.behavior ?? {}))
  await copyFile(new URL('./fixtures/plugin.mjs', import.meta.url), path.join(directory, 'main.mjs'))
  return manifest
}

// A stored ZIP fixture, allowing deliberately unsafe names without an external ZIP executable.
export function pluginZip(files: Record<string, string>): Buffer {
  const parts: Buffer[] = []
  const directory: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const file = Buffer.from(name)
    const data = Buffer.from(text)
    let crc = 0xffffffff
    for (const byte of data) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
    crc = (crc ^ 0xffffffff) >>> 0
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50)
    header.writeUInt16LE(20, 4)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(data.length, 18)
    header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(file.length, 26)
    parts.push(header, file, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(file.length, 28)
    central.writeUInt32LE(offset, 42)
    directory.push(central, file)
    offset += header.length + file.length + data.length
  }
  const central = Buffer.concat(directory)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, central, end])
}
