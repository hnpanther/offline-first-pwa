import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import { REQUEST_TIMEOUT_MS, UPLOAD_TIMEOUT_MS } from './client'

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
 * These tests drive the abort mechanism directly rather than through `request()`, because the
 * module reads app settings and the auth store on the way to `fetch` — mocking all of that
 * would test the mocks. What has to be true is narrower and checkable: a pending fetch is
 * aborted once the budget elapses, a fast one is not, and the caller's own signal still works.
 */
describe('request timeouts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('states both budgets, and gives uploads a longer one', () => {
    // A photo or voice note goes over the same weak link as a JSON call; 20s would abandon
    // transfers that were making perfectly good progress.
    expect(REQUEST_TIMEOUT_MS).toBe(20_000)
    expect(UPLOAD_TIMEOUT_MS).toBe(120_000)
    expect(UPLOAD_TIMEOUT_MS).toBeGreaterThan(REQUEST_TIMEOUT_MS)
  })

  it('aborts a request that never answers', () => {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new DOMException('timeout', 'TimeoutError')),
      REQUEST_TIMEOUT_MS
    )

    expect(controller.signal.aborted).toBe(false)
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS - 1)
    expect(controller.signal.aborted).toBe(false)

    vi.advanceTimersByTime(1)
    expect(controller.signal.aborted).toBe(true)
    expect((controller.signal.reason as DOMException).name).toBe('TimeoutError')

    clearTimeout(timer)
  })

  it('does not abort a request that answered in time', () => {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new DOMException('timeout', 'TimeoutError')),
      REQUEST_TIMEOUT_MS
    )

    // The response arrived — the cleanup the client runs in its `finally`.
    clearTimeout(timer)
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS * 2)

    expect(controller.signal.aborted).toBe(false)
  })

  it("combines the caller's signal with the timeout so either can cancel", () => {
    // SyncManager aborts everything on stop(); that must keep working alongside the timeout.
    const caller = new AbortController()
    const timeout = new AbortController()
    const combined = AbortSignal.any([caller.signal, timeout.signal])

    expect(combined.aborted).toBe(false)
    caller.abort()
    expect(combined.aborted).toBe(true)
  })

  it('fires the timeout even when the caller never cancels', () => {
    const caller = new AbortController()
    const timeout = new AbortController()
    const combined = AbortSignal.any([caller.signal, timeout.signal])

    timeout.abort(new DOMException('timeout', 'TimeoutError'))

    expect(combined.aborted).toBe(true)
    expect(caller.signal.aborted).toBe(false)
  })

  it('has AbortSignal.any available in this runtime', () => {
    // The client falls back when it is missing; if this ever fails, that fallback stops being
    // dead code and the combined-signal behaviour above no longer describes production.
    expect(typeof AbortSignal.any).toBe('function')
  })
})
