import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LOW_STORAGE_THRESHOLD_BYTES,
  getStorageStatus,
  requestPersistentStorage
} from '@/utils/storageQuota'

const MB = 1024 * 1024

function withNavigator(storage: unknown) {
  vi.stubGlobal('navigator', storage === undefined ? {} : { storage })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getStorageStatus', () => {
  it('reports low when the remaining space is under the threshold', async () => {
    withNavigator({ estimate: async () => ({ usage: 495 * MB, quota: 500 * MB }) })
    const status = await getStorageStatus()
    expect(status.available).toBe(5 * MB)
    expect(status.low).toBe(true)
  })

  it('does not report low when there is room', async () => {
    withNavigator({ estimate: async () => ({ usage: 100 * MB, quota: 500 * MB }) })
    expect((await getStorageStatus()).low).toBe(false)
  })

  it('treats a browser that reports nothing as not low', async () => {
    // Refusing to let an operator photograph a fault because we could not measure the disk
    // would be a worse failure than the one this guard exists to prevent.
    withNavigator(undefined)
    expect(await getStorageStatus()).toEqual({ low: false })
  })

  it('treats partial figures as not low', async () => {
    withNavigator({ estimate: async () => ({ usage: 10 * MB }) })
    expect((await getStorageStatus()).low).toBe(false)
  })

  it('survives an estimate that throws (private browsing)', async () => {
    withNavigator({
      estimate: async () => {
        throw new Error('denied')
      }
    })
    expect(await getStorageStatus()).toEqual({ low: false })
  })

  it('honours a caller-supplied threshold', async () => {
    withNavigator({ estimate: async () => ({ usage: 400 * MB, quota: 500 * MB }) })
    expect((await getStorageStatus(50 * MB)).low).toBe(false)
    expect((await getStorageStatus(200 * MB)).low).toBe(true)
  })

  it('keeps a threshold large enough for several captures', () => {
    expect(LOW_STORAGE_THRESHOLD_BYTES).toBeGreaterThanOrEqual(10 * MB)
  })
})

describe('requestPersistentStorage', () => {
  it('returns true without re-asking when the grant already exists', async () => {
    const persist = vi.fn(async () => true)
    withNavigator({ persisted: async () => true, persist })
    expect(await requestPersistentStorage()).toBe(true)
    expect(persist).not.toHaveBeenCalled()
  })

  it('asks when no grant exists yet', async () => {
    const persist = vi.fn(async () => true)
    withNavigator({ persisted: async () => false, persist })
    expect(await requestPersistentStorage()).toBe(true)
    expect(persist).toHaveBeenCalledOnce()
  })

  it('reports a refusal without throwing — a browser saying no is normal', async () => {
    withNavigator({ persisted: async () => false, persist: async () => false })
    expect(await requestPersistentStorage()).toBe(false)
  })

  it('reports false when the API is missing entirely', async () => {
    withNavigator(undefined)
    expect(await requestPersistentStorage()).toBe(false)
  })

  it('swallows a throwing implementation', async () => {
    withNavigator({
      persisted: async () => false,
      persist: async () => {
        throw new Error('not allowed')
      }
    })
    expect(await requestPersistentStorage()).toBe(false)
  })
})
