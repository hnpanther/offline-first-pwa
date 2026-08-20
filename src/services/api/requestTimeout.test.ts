import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import { REQUEST_TIMEOUT_MS, UPLOAD_TIMEOUT_MS, withTimeout } from './client'

/**
 * Requests give up instead of hanging.
 *
 * Why this matters more than it sounds: `SyncManager` keeps the in-flight sync in one shared
 * promise and hands that same promise to every later caller. Before there was a timeout, a
 * half-open connection — an access point that dropped, a NAT that forgot the flow — left
 * `fetch` pending for as long as the OS allowed, and every subsequent sync attached itself to
 * that dead promise. Sheets and attachments stopped being delivered, with nothing shown to the
 * operator and no error anywhere. On a plant network that is an ordinary Tuesday.
 *
 * **These tests call `withTimeout` itself.** The first version of this file reconstructed the
 * behaviour instead — it asserted that `AbortSignal.any` composes two controllers, which was
 * perfectly true while the function under test was not reaching that branch. The fallback
 * returned the caller's signal alone and silently detached the timeout, and since `SyncManager`
 * passes a caller signal on nearly every request, the timeout did nothing at all on any runtime
 * without `AbortSignal.any`. A test that rebuilds the logic it is checking cannot see that.
 */
describe('withTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('states both budgets, and gives uploads a longer one', () => {
    // A photo or voice note goes over the same weak link as a JSON call; 20s would abandon
    // transfers that were making perfectly good progress.
    expect(REQUEST_TIMEOUT_MS).toBe(20_000)
    expect(UPLOAD_TIMEOUT_MS).toBe(120_000)
    expect(UPLOAD_TIMEOUT_MS).toBeGreaterThan(REQUEST_TIMEOUT_MS)
  })

  it('aborts when nothing answers, with no caller signal', () => {
    const { signal, done } = withTimeout(undefined, REQUEST_TIMEOUT_MS)

    expect(signal.aborted).toBe(false)
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS - 1)
    expect(signal.aborted).toBe(false)

    vi.advanceTimersByTime(1)
    expect(signal.aborted).toBe(true)
    expect((signal.reason as DOMException).name).toBe('TimeoutError')

    done()
  })

  it('aborts when nothing answers even though the caller passed a signal', () => {
    // The exact case the old fallback broke, and the one SyncManager always takes.
    const caller = new AbortController()
    const { signal, done } = withTimeout(caller.signal, REQUEST_TIMEOUT_MS)

    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS)

    expect(signal.aborted).toBe(true)
    expect((signal.reason as DOMException).name).toBe('TimeoutError')
    expect(caller.signal.aborted).toBe(false)
    done()
  })

  it("honours the caller's own cancellation", () => {
    const caller = new AbortController()
    const { signal, done } = withTimeout(caller.signal, REQUEST_TIMEOUT_MS)

    caller.abort()

    expect(signal.aborted).toBe(true)
    done()
  })

  it('does not abort once done() has cleared the timer', () => {
    const caller = new AbortController()
    const { signal, done } = withTimeout(caller.signal, REQUEST_TIMEOUT_MS)

    done() // the response arrived — what the client's `finally` does
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS * 5)

    expect(signal.aborted).toBe(false)
  })

  it('is already aborted when the caller signal was aborted before the call', () => {
    const caller = new AbortController()
    caller.abort()

    const { signal, done } = withTimeout(caller.signal, REQUEST_TIMEOUT_MS)

    expect(signal.aborted).toBe(true)
    done()
  })

  // ── The fallback, which is the half that was broken ──────────────────────

  describe('without AbortSignal.any', () => {
    beforeEach(() => {
      // Simulate a WebView that predates AbortSignal.any. The minimum Chrome version is not
      // pinned in deployment, so this is not a hypothetical runtime.
      vi.stubGlobal('AbortSignal', Object.assign(
        function AbortSignalStub() {} as unknown as typeof AbortSignal,
        { ...AbortSignal, any: undefined }
      ))
    })

    it('still aborts on timeout when a caller signal is present', () => {
      const caller = new AbortController()
      const { signal, done } = withTimeout(caller.signal, REQUEST_TIMEOUT_MS)

      vi.advanceTimersByTime(REQUEST_TIMEOUT_MS)

      expect(signal.aborted)
        .toBe(true)
      expect((signal.reason as DOMException).name).toBe('TimeoutError')
      done()
    })

    it("still honours the caller's cancellation", () => {
      const caller = new AbortController()
      const { signal, done } = withTimeout(caller.signal, REQUEST_TIMEOUT_MS)

      caller.abort()

      expect(signal.aborted).toBe(true)
      done()
    })

    it('still does nothing after done()', () => {
      const caller = new AbortController()
      const { signal, done } = withTimeout(caller.signal, REQUEST_TIMEOUT_MS)

      done()
      vi.advanceTimersByTime(REQUEST_TIMEOUT_MS * 5)

      expect(signal.aborted).toBe(false)
    })

    it('honours a caller signal that was already aborted', () => {
      const caller = new AbortController()
      caller.abort()

      const { signal, done } = withTimeout(caller.signal, REQUEST_TIMEOUT_MS)

      expect(signal.aborted).toBe(true)
      done()
    })
  })
})
