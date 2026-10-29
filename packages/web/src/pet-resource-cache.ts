import type { PetManifest } from '@conclave/protocol'

export type PetTypingImages = { image: string; base: string }
export type PetResource = { manifest: PetManifest; atlas: string; walk: string; texture: string; typing?: PetTypingImages }

// Only mounted consumers keep full atlases; settings thumbnails never acquire a resource.
export class PetResourceCache {
  private entries = new Map<string, { refs: number; promise: Promise<PetResource>; resource?: PetResource }>()
  constructor(private readonly load: (key: string) => Promise<PetResource>, private readonly dispose: (resource: PetResource) => void) {}
  acquire(key: string): { resource: Promise<PetResource>; release(): void } {
    let entry = this.entries.get(key)
    if (!entry) {
      entry = { refs: 0, promise: Promise.resolve().then(() => this.load(key)) }
      // Install the entry before the loader can resolve synchronously.
      const current = entry
      current.promise = current.promise.then((resource) => {
        current.resource = resource
        if (!current.refs) this.dispose(resource)
        return resource
      }).catch((error: unknown) => {
        if (this.entries.get(key) === current) this.entries.delete(key)
        throw error
      })
      this.entries.set(key, entry)
    }
    entry.refs++
    const current = entry; let released = false
    return {
      resource: current.promise,
      release: () => {
        if (released) return
        released = true; current.refs--
        if (!current.refs) {
          if (this.entries.get(key) === current) this.entries.delete(key)
          if (current.resource) this.dispose(current.resource)
        }
      }
    }
  }
}
