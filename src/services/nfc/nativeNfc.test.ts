import { afterEach, describe, expect, it, vi } from 'vitest'
import { isNFCSupported, parseNativeTag, resolveNfcTagId, startNFCScan } from '@/services/nfc'
import { decodeBase64, hasNativeNfcPlugin } from '@/services/nfc/nativeNfc'

/**
 * Reading tags inside the packaged app, where Web NFC does not exist.
 *
 * <h2>What is actually being pinned</h2>
 *
 * Not `NfcAdapter` — that is Java and needs a tag and a device. What these cover is the seam:
 * that the app picks the native reader only where it exists, that the browser path is untouched,
 * and above all that **a tag decodes identically down both routes**.
 *
 * That last one is the contract with the Java side: the plugin hands over the bytes **Web NFC
 * would have handed over**, so one decoder serves both routes. Web NFC normalises two
 * well-known record types before the page sees them — a text record's status byte and language
 * code, and a URI record's prefix byte — and the native side does the same. Everything past
 * that (mislabelled records, media types that lie, which record holds the asset id) is
 * heuristics learned from real tags, and stays in one place.
 */

type Listener = (payload: unknown) => void

function fakePlugin(overrides: Record<string, unknown> = {}) {
  const listeners: Record<string, Listener[]> = {}
  const removed: string[] = []
  return {
    listeners,
    removed,
    startScan: vi.fn(async () => {}),
    stopScan: vi.fn(async () => {}),
    isAvailable: vi.fn(async () => ({ available: true, enabled: true })),
    addListener: vi.fn(async (event: string, handler: Listener) => {
      ;(listeners[event] ??= []).push(handler)
      return { remove: async () => { removed.push(event) } }
    }),
    ...overrides
  }
}

function installPlugin(plugin: unknown): void {
  ;(globalThis as { window?: unknown }).window = {
    Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { Nfc: plugin } }
  }
}

/** A browser: no Capacitor at all, and Web NFC present or not as the case may be. */
function installBrowser(withWebNfc: boolean): void {
  const win: Record<string, unknown> = {}
  if (withWebNfc) win.NDEFReader = function NDEFReader() {}
  ;(globalThis as { window?: unknown }).window = win
}

/** base64 of the given bytes, the way the Java side encodes a payload. */
function b64(...bytes: number[]): string {
  return Buffer.from(Uint8Array.from(bytes)).toString('base64')
}

const text = (s: string) => Array.from(Buffer.from(s, 'utf8'))

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
  vi.restoreAllMocks()
})

describe('choosing a reader', () => {
  it('reports support when the native plugin is present, though Web NFC is not', () => {
    installPlugin(fakePlugin())

    expect(hasNativeNfcPlugin()).toBe(true)
    expect(isNFCSupported()).toBe(true)
  })

  it('still reports support in a browser with Web NFC', () => {
    installBrowser(true)

    expect(hasNativeNfcPlugin()).toBe(false)
    expect(isNFCSupported()).toBe(true)
  })

  /** A browser without Web NFC — desktop Chrome, or Safari. Unchanged by the plugin existing. */
  it('reports no support in a browser without Web NFC', () => {
    installBrowser(false)

    expect(isNFCSupported()).toBe(false)
  })

  it('uses the native reader when it is there', async () => {
    const plugin = fakePlugin()
    installPlugin(plugin)

    await startNFCScan(() => {})

    expect(plugin.startScan).toHaveBeenCalledOnce()
  })

  /**
   * Stopping removes the listeners as well as the scan. Left attached across a page change they
   * would deliver a tag to a callback whose screen is gone.
   */
  it('removes its listeners when the scan is stopped', async () => {
    const plugin = fakePlugin()
    installPlugin(plugin)

    const stop = await startNFCScan(() => {})
    stop()
    await Promise.resolve()

    expect(plugin.stopScan).toHaveBeenCalledOnce()
    expect(plugin.removed.sort()).toEqual(['nfcError', 'nfcTag'])
  })

  it('reports a reader that will not start, rather than throwing', async () => {
    const plugin = fakePlugin({ startScan: vi.fn(async () => { throw new Error('NFC is off') }) })
    installPlugin(plugin)
    const seen: unknown[] = []

    await startNFCScan(r => seen.push(r))

    expect(seen).toEqual([{ success: false, error: 'NFC is off' }])
  })
})

describe('a tag delivered by the plugin', () => {
  it('reaches the caller decoded', async () => {
    const plugin = fakePlugin()
    installPlugin(plugin)
    const seen: { success: boolean; tagData?: { message?: string } }[] = []

    await startNFCScan(r => seen.push(r))
    plugin.listeners.nfcTag[0]({
      serialNumber: '04:a2:24',
      records: [{ recordType: 'mime', mediaType: 'text/plain', payload: b64(...text('ASSET-42')) }]
    })

    expect(seen[0].success).toBe(true)
    expect(seen[0].tagData?.message).toBe('ASSET-42')
  })

  it('reports a plugin error as a failed read', async () => {
    const plugin = fakePlugin()
    installPlugin(plugin)
    const seen: { success: boolean; error?: string }[] = []

    await startNFCScan(r => seen.push(r))
    plugin.listeners.nfcError[0]({ message: 'تگ ناخوانا' })

    expect(seen[0]).toEqual({ success: false, error: 'تگ ناخوانا' })
  })
})

describe('the payload contract with the Java side', () => {
  /**
   * The plugin must hand over what **Web NFC** would have handed over, not the raw NDEF bytes.
   * Web NFC strips a text record's status byte and language code before the page sees it; the
   * Java side does the same. These cases state that contract, because it is the one thing a
   * change on the Java side could break silently.
   */
  it('reads a text record whose header the native side already stripped', () => {
    const tag = parseNativeTag({
      serialNumber: '01',
      records: [{ recordType: 'text', payload: b64(...text('ASSET-42')) }]
    })

    expect(tag.records?.[0].data).toBe('ASSET-42')
    expect(resolveNfcTagId(tag)).toBe('ASSET-42')
  })

  /**
   * What happens if the Java side ever stops normalising: the shared decoder offers both the
   * raw bytes and its own header-stripping attempt, and prefers the **longer** — so the header
   * survives into the asset id and the lookup silently fails to match anything.
   *
   * Pinned deliberately. It is not desirable behaviour; it is the reason normalisation belongs
   * on the Java side, and this case is what makes a regression there legible instead of
   * mysterious.
   */
  it('shows why: a raw text payload would carry its header into the id', () => {
    const tag = parseNativeTag({
      serialNumber: '01',
      records: [{ recordType: 'text', payload: b64(0x02, ...text('en'), ...text('ASSET-42')) }]
    })

    expect(tag.records?.[0].data).toBe('enASSET-42')
  })

  it('reads a uri record whose prefix the native side already expanded', () => {
    const tag = parseNativeTag({
      serialNumber: '01',
      records: [{ recordType: 'url', payload: b64(...text('https://hnp.local/a/42')) }]
    })

    expect(tag.records?.[0].data).toBe('https://hnp.local/a/42')
  })

  it('reads a plain mime record as it stands', () => {
    const tag = parseNativeTag({
      serialNumber: '01',
      records: [{ recordType: 'mime', mediaType: 'text/plain', payload: b64(...text('PUMP-7')) }]
    })

    expect(tag.records?.[0].data).toBe('PUMP-7')
  })

  /** The asset id is the message, never the hardware serial — the same rule as the browser. */
  it('picks the longest payload as the tag message', () => {
    const tag = parseNativeTag({
      serialNumber: 'DE:AD:BE:EF',
      records: [
        { recordType: 'text', payload: b64(...text('x')) },
        { recordType: 'text', payload: b64(...text('ASSET-1234')) }
      ]
    })

    expect(tag.message).toBe('ASSET-1234')
    expect(resolveNfcTagId(tag)).toBe('ASSET-1234')
  })

  it('survives a tag with no records at all', () => {
    const tag = parseNativeTag({ serialNumber: '01' })

    expect(tag.records).toEqual([])
    expect(resolveNfcTagId(tag)).toBe('')
  })

  it('survives a record with no payload', () => {
    const tag = parseNativeTag({ serialNumber: '01', records: [{ recordType: 'empty' }] })

    expect(tag.records?.[0].data).toBeUndefined()
  })
})

describe('decodeBase64', () => {
  it('round-trips the bytes the Java side sends', () => {
    expect(Array.from(decodeBase64(b64(1, 2, 250)))).toEqual([1, 2, 250])
  })

  it('treats an absent payload as no bytes', () => {
    expect(decodeBase64(undefined).byteLength).toBe(0)
  })
})
