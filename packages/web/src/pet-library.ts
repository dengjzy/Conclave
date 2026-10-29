import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { PetCatalog, PetManifest, type PetLibraryState, type RpcConnection } from '@conclave/protocol'
import catalog from '../../protocol/src/pet-catalog.json'
import manifest from './assets/pets/clay-manifest.json'
import atlas from './assets/pets/clay.webp'
import walk from './assets/pets/clay-walk.webp'
import texture from './assets/pets/face-textures.webp'
import typing from './assets/pets/clay-typing.webp'
import typingBase from './assets/pets/clay-typing-base.webp'
import { base64ToBytes } from './base64'
import { useCore } from './core-store'
import { PetResourceCache, type PetResource } from './pet-resource-cache'

export const BUILTIN_PET: PetResource = { manifest: PetManifest.parse(manifest), atlas, walk, texture, typing: { image: typing, base: typingBase } }
const initial: PetLibraryState = { catalog: PetCatalog.parse(catalog).pets, installed: [], downloads: [] }
export const usePetLibraryStore = create<{ state: PetLibraryState; ready: boolean }>(() => ({ state: initial, ready: false }))
const followers = new WeakMap<RpcConnection, { count: number; stop(): void }>()
function follow(rpc: RpcConnection): () => void {
  let follower = followers.get(rpc)
  if (!follower) {
    let live = true
    usePetLibraryStore.setState({ state: initial, ready: false })
    const stop = rpc.on('pets.changed', (state) => { if (live) usePetLibraryStore.setState({ state }) })
    void rpc.call('pets.list', {}).then((state) => { if (live) usePetLibraryStore.setState({ state, ready: true }) }).catch(() => {})
    follower = { count: 0, stop: () => { live = false; stop() } }; followers.set(rpc, follower)
  }
  follower.count++
  const current = follower
  return () => { if (!--current.count) { current.stop(); followers.delete(rpc) } }
}

export function usePetLibrary(): { state: PetLibraryState; ready: boolean; supported: boolean } {
  const rpc = useCore((s) => s.rpc), state = usePetLibraryStore((s) => s.state), ready = usePetLibraryStore((s) => s.ready)
  const supported = rpc?.features.includes('pets') ?? false
  useEffect(() => rpc && supported ? follow(rpc) : undefined, [rpc, supported])
  return { state, ready: supported && ready, supported }
}

function connection(): RpcConnection {
  const rpc = useCore.getState().rpc
  if (!rpc?.features.includes('pets')) throw new Error('pets-unavailable')
  return rpc
}
export async function refreshPets(): Promise<void> {
  const state = await connection().call('pets.list', { refresh: true }); usePetLibraryStore.setState({ state, ready: true })
}
export async function installPet(id: string): Promise<void> {
  const state = await connection().call('pets.install', { id }); usePetLibraryStore.setState({ state })
}
export async function cancelPet(id: string): Promise<void> { await connection().call('pets.cancel', { id }) }
export async function removePet(id: string): Promise<void> {
  const state = await connection().call('pets.remove', { id }); usePetLibraryStore.setState({ state })
}

const caches = new WeakMap<RpcConnection, PetResourceCache>()
function resources(rpc: RpcConnection): PetResourceCache {
  let cache = caches.get(rpc)
  if (!cache) {
    cache = new PetResourceCache(async (key) => {
      const id = key.split('@')[0] ?? ''
      const { manifest, assets } = await rpc.call('pets.read', { id })
      const url = (base64: string) => URL.createObjectURL(new Blob([base64ToBytes(base64)], { type: 'image/webp' }))
      return { manifest, atlas: url(assets['poses.webp']), walk: url(assets['walk.webp']), texture: url(assets['face.webp']),
        ...(manifest.rig.typing && assets['typing.webp'] && assets['typing-base.webp'] ? { typing: { image: url(assets['typing.webp']), base: url(assets['typing-base.webp']) } } : {}) }
    }, (resource) => { for (const url of [resource.atlas, resource.walk, resource.texture, ...(resource.typing ? [resource.typing.image, resource.typing.base] : [])]) URL.revokeObjectURL(url) })
    caches.set(rpc, cache)
  }
  return cache
}
export function usePetResource(id: string, disabled = false): PetResource {
  const { state } = usePetLibrary(), rpc = useCore((s) => s.rpc)
  const version = state.installed.find((p) => p.id === id)?.version
  const [loaded, setLoaded] = useState<{ key: string; resource: PetResource } | null>(null)
  const key = `${id}@${version ?? ''}`
  useEffect(() => {
    if (id === 'clay' || disabled || !version || !rpc?.features.includes('pets')) return
    const handle = resources(rpc).acquire(key); let live = true
    void handle.resource.then((resource) => { if (live) setLoaded({ key, resource }) }).catch(() => { if (live) setLoaded(null) })
    return () => { live = false; handle.release(); setLoaded(null) }
  }, [key, id, disabled, version, rpc])
  return !disabled && version && loaded?.key === key ? loaded.resource : BUILTIN_PET
}
