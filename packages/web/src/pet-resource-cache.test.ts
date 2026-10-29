import { describe, expect, it, vi } from 'vitest'
import { PetManifest } from '@conclave/protocol'
import manifest from './assets/pets/clay-manifest.json'
import { PetResourceCache, type PetResource } from './pet-resource-cache'

const resource = (): PetResource => ({ manifest: PetManifest.parse(manifest), atlas: 'blob:poses', walk: 'blob:walk', texture: 'blob:face' })

describe('pet resource lifetime', () => {
  it('shares a load and releases all textures after the last mounted consumer leaves', async () => {
    const pet = resource(), load = vi.fn(async () => pet), dispose = vi.fn()
    const cache = new PetResourceCache(load, dispose)
    const first = cache.acquire('moss@1'), second = cache.acquire('moss@1')
    expect(await first.resource).toBe(pet); expect(await second.resource).toBe(pet)
    expect(load).toHaveBeenCalledTimes(1)
    first.release(); first.release(); expect(dispose).not.toHaveBeenCalled()
    second.release(); expect(dispose).toHaveBeenCalledExactlyOnceWith(pet)
    const third = cache.acquire('moss@1'); await third.resource
    expect(load).toHaveBeenCalledTimes(2); third.release()
  })

  it('disposes a late load without revoking a replacement mounted resource', async () => {
    let finish: ((pet: PetResource) => void) | undefined
    const stale = resource(), active = { ...resource(), atlas: 'blob:new' }, dispose = vi.fn()
    const load = vi.fn<() => Promise<PetResource>>().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve })).mockResolvedValue(active)
    const cache = new PetResourceCache(load, dispose)
    const first = cache.acquire('moss@1'); await Promise.resolve(); first.release()
    const second = cache.acquire('moss@1'); await second.resource
    finish?.(stale); await first.resource
    expect(dispose).toHaveBeenCalledExactlyOnceWith(stale)
    second.release(); expect(dispose).toHaveBeenLastCalledWith(active)
  })

  it('retries a failed load and treats package versions separately', async () => {
    const load = vi.fn<() => Promise<PetResource>>().mockRejectedValueOnce(new Error('connection lost')).mockImplementation(async () => resource())
    const cache = new PetResourceCache(load, vi.fn())
    const failed = cache.acquire('moss@1'); await expect(failed.resource).rejects.toThrow('connection lost'); failed.release()
    const one = cache.acquire('moss@1'), two = cache.acquire('moss@2')
    await Promise.all([one.resource, two.resource]); expect(load).toHaveBeenCalledTimes(3)
    one.release(); two.release()
  })
})
