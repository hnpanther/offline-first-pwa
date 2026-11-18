import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WEB_NFC_STOP_GRACE_MS, startNFCScan, stopNFCScan } from '@/services/nfc'

/**
 * A stopped Web NFC scan keeps the reader for a moment before it is aborted (2026-11-18).
 *
 * <h2>Why</h2>
 *
 * The fill page stops the scan the instant a tag is read, with the tag still against the tablet.
 * Aborting at that moment hands the antenna back to Android's own tag dispatch, which reads the
 * same tag a second time and opens Chrome or the system Tags app over the app. Holding the scan
 * for `WEB_NFC_STOP_GRACE_MS` keeps the tag with the page.
 *
 * <h2>What must hold, and is pinned here</h2>
 *
 * - The abort comes after the grace period, not at the stop.
 * - Nothing read during the grace period reaches anyone: a stopped scan delivers nothing.
 * - A new scan takes over at once: the lingering one is aborted when it starts, and the new one
 *   is not stopped by the old one's timer or by its stale handle.
 */

interface FakeReader {
  listeners: Record<string, ((event: unknown) => void) | undefined>
  signal?: AbortSignal
}

let readers: FakeReader[] = []

function installWebNfcBrowser(): void {
  readers = []
  ;(globalThis as { window?: unknown }).window = {
    NDEFReader: function NDEFReader() {
      const reader: FakeReader & {
        addEventListener: (type: string, handler: (event: unknown) => void) => void
        scan: (options?: { signal?: AbortSignal }) => Promise<void>
      } = {
        listeners: {},
        addEventListener(type, handler) {
          reader.listeners[type] = handler
        },
        async scan(options) {
          reader.signal = options?.signal
        }
      }
      readers.push(reader)
      return reader
    }
  }
}

const tag = (id: string) => ({
  serialNumber: '04:a2:24',
  message: { records: [{ recordType: 'text', data: new TextEncoder().encode(id) }] }
})

beforeEach(() => {
  vi.useFakeTimers()
  installWebNfcBrowser()
})

afterEach(() => {
  stopNFCScan()
  vi.runAllTimers()
  vi.useRealTimers()
  delete (globalThis as { window?: unknown }).window
})

describe('stopping a Web NFC scan', () => {
  it('holds the reader for the grace period, then aborts it', async () => {
    await startNFCScan(() => {})
    const signal = readers[0].signal!

    stopNFCScan()
    expect(signal.aborted).toBe(false)

    vi.advanceTimersByTime(WEB_NFC_STOP_GRACE_MS - 1)
    expect(signal.aborted).toBe(false)

    vi.advanceTimersByTime(1)
    expect(signal.aborted).toBe(true)
  })

  it('delivers nothing read after the stop: the tag still against the tablet is swallowed', async () => {
    const seen: unknown[] = []
    await startNFCScan(r => seen.push(r))

    readers[0].listeners.reading?.(tag('ASSET-1'))
    stopNFCScan()
    readers[0].listeners.reading?.(tag('ASSET-1'))
    readers[0].listeners.readingerror?.(new Event('readingerror'))

    expect(seen).toHaveLength(1)
  })

  it('stops through the handle the same way', async () => {
    const seen: unknown[] = []
    const stop = await startNFCScan(r => seen.push(r))
    const signal = readers[0].signal!

    stop()
    readers[0].listeners.reading?.(tag('ASSET-1'))

    expect(seen).toHaveLength(0)
    expect(signal.aborted).toBe(false)
    vi.advanceTimersByTime(WEB_NFC_STOP_GRACE_MS)
    expect(signal.aborted).toBe(true)
  })
})

describe('starting again inside the grace period', () => {
  it('aborts the lingering scan at once and gives the reader to the new one', async () => {
    const first: unknown[] = []
    const second: unknown[] = []
    await startNFCScan(r => first.push(r))
    stopNFCScan()

    await startNFCScan(r => second.push(r))

    expect(readers[0].signal!.aborted).toBe(true)
    expect(readers[1].signal!.aborted).toBe(false)

    readers[0].listeners.reading?.(tag('OLD'))
    readers[1].listeners.reading?.(tag('NEW'))
    expect(first).toHaveLength(0)
    expect(second).toHaveLength(1)
  })

  it('is not stopped by the earlier scan\'s timer', async () => {
    await startNFCScan(() => {})
    stopNFCScan()
    vi.advanceTimersByTime(WEB_NFC_STOP_GRACE_MS / 2)

    const seen: unknown[] = []
    await startNFCScan(r => seen.push(r))
    vi.advanceTimersByTime(WEB_NFC_STOP_GRACE_MS * 2)

    expect(readers[1].signal!.aborted).toBe(false)
    readers[1].listeners.reading?.(tag('NEW'))
    expect(seen).toHaveLength(1)
  })

  it('is not stopped by the earlier scan\'s stale handle', async () => {
    const staleStop = await startNFCScan(() => {})
    stopNFCScan()

    const seen: unknown[] = []
    await startNFCScan(r => seen.push(r))
    staleStop()

    readers[1].listeners.reading?.(tag('NEW'))
    expect(seen).toHaveLength(1)
    vi.advanceTimersByTime(WEB_NFC_STOP_GRACE_MS * 2)
    expect(readers[1].signal!.aborted).toBe(false)
  })

  it('holds only one stopped scan at a time', async () => {
    await startNFCScan(() => {})
    stopNFCScan()
    stopNFCScan()
    stopNFCScan()

    expect(readers[0].signal!.aborted).toBe(false)
    vi.advanceTimersByTime(WEB_NFC_STOP_GRACE_MS)
    expect(readers[0].signal!.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})
