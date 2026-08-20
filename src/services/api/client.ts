import { getSettings } from '@/services/storage'
import { getAccessToken, clearAuthSession } from '@/services/auth'
import { useAppStore } from '@/store'

/**
 * Centralized HTTP client for all server communication.
 * The base URL is read from app settings so it can be changed at runtime.
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * How long a request may take before it is abandoned.
 *
 * <p>There was no limit at all, which on a plant network is not a theoretical gap. A half-open
 * TCP connection — an access point that dropped, a NAT that forgot the flow — leaves `fetch`
 * pending until the OS gives up, which can be minutes. `SyncManager` keeps the in-flight sync
 * in a single shared promise and hands that same promise to every later caller, so one hung
 * request stopped *all* subsequent syncing: no sheets, no attachments, and no error to show for
 * it. The tablet looked fine and quietly stopped delivering work.
 *
 * Two limits, because two very different things are being waited on:
 *  - JSON is small and either answers quickly or is not coming.
 *  - Uploads carry a compressed photo or voice note over the same weak link, and 15s would
 *    abandon transfers that were making perfectly good progress.
 */
export const REQUEST_TIMEOUT_MS = 20_000
export const UPLOAD_TIMEOUT_MS = 120_000

/** The abort reason a timeout raises, so callers can tell it from a network failure. */
export function timeoutReason(): DOMException {
  return new DOMException('timeout', 'TimeoutError')
}

/**
 * Merges abort signals without `AbortSignal.any`.
 *
 * Exists because the fallback that replaced `any` was worse than no fallback: it returned the
 * caller's signal alone, which silently detached the timeout — and `SyncManager` passes a
 * caller signal on essentially every request, so on any runtime lacking `AbortSignal.any` the
 * timeout did nothing at all and the shared-promise deadlock came straight back. A feature
 * detection that quietly disables the feature it is detecting for is not a fallback.
 *
 * Listeners are registered `once`, and an already-aborted input is honoured immediately rather
 * than waited on.
 */
function mergeAbortSignals(signals: readonly AbortSignal[]): AbortSignal {
  const controller = new AbortController()
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      return controller.signal
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}

/**
 * Combines the caller's own abort signal with a timeout.
 *
 * The caller can still cancel — `SyncManager` aborts everything on `stop()` — and the timeout
 * fires independently if nothing answers. `done()` clears the timer so a fast response does not
 * leave one pending.
 *
 * Exported so it can be tested directly. The first version of this was only tested by
 * reconstructing its behaviour in the test file, which is how the fallback bug above survived:
 * the test asserted that `AbortSignal.any` composes two controllers, which was true, while the
 * function under test was not using it.
 */
export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal
  done: () => void
} {
  const timeoutController = new AbortController()
  const timer = setTimeout(() => timeoutController.abort(timeoutReason()), timeoutMs)
  const done = () => clearTimeout(timer)

  if (!signal) {
    return { signal: timeoutController.signal, done }
  }

  // Native where available; the merge above is behaviourally identical, so the timeout is
  // attached either way.
  const combined =
    typeof AbortSignal.any === 'function'
      ? AbortSignal.any([signal, timeoutController.signal])
      : mergeAbortSignals([signal, timeoutController.signal])

  return { signal: combined, done }
}

/** True when a caught error is our timeout rather than a genuine network failure. */
function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError'
}

type UnauthorizedHandler = () => void
let onUnauthorized: UnauthorizedHandler | null = null

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  onUnauthorized = handler
}

function extractErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && 'message' in body) {
    const msg = (body as { message: unknown }).message
    if (typeof msg === 'string' && msg.trim()) return msg
  }
  return fallback
}

async function getBaseUrl(): Promise<string> {
  const settings = await getSettings()
  const configured = settings.serverUrl.replace(/\/$/, '')
  if (typeof window !== 'undefined') {
    try {
      if (new URL(configured).origin === window.location.origin) {
        return ''
      }
    } catch {
      /* keep configured URL */
    }
  }
  return configured
}

async function buildHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json'
  }
  const token = await getAccessToken()
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  return headers
}

/**
 * True when the token has already been dropped underneath a UI that still thinks
 * it is signed in.
 *
 * `getAuthSession()` deletes an expired session as a side effect of reading it,
 * and it does so silently: the Zustand store keeps the old session, the app keeps
 * rendering as if logged in, and the user only finds out when some later request
 * comes back 401 — or, on a flaky link, sees a misleading "could not reach the
 * server" instead. Detecting it here sends them to the login screen with the real
 * reason straight away.
 */
async function sessionSilentlyExpired(): Promise<boolean> {
  if (!useAppStore.getState().authSession) return false
  return (await getAccessToken()) == null
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  authRequired = true
): Promise<T> {
  if (authRequired && (await sessionSilentlyExpired())) {
    onUnauthorized?.()
    throw new ApiError(401, 'نشست شما به پایان رسیده است. دوباره وارد شوید.')
  }

  const baseUrl = await getBaseUrl()
  const url = `${baseUrl}${path}`

  let response: Response
  const timeout = withTimeout(signal, REQUEST_TIMEOUT_MS)
  try {
    response = await fetch(url, {
      method,
      headers: await buildHeaders(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: timeout.signal
    })
  } catch (error) {
    useAppStore.getState().setServerReachable(false)
    throw new ApiError(0, isTimeout(error)
      ? 'پاسخی از سرور دریافت نشد (زمان انتظار به پایان رسید).'
      : 'ارتباط با سرور برقرار نشد.')
  } finally {
    timeout.done()
  }

  if (response.status === 401 && authRequired) {
    await clearAuthSession()
    onUnauthorized?.()
  }

  if (!response.ok) {
    // Read the body ONCE. Calling response.json() and then response.text() as a
    // fallback is a trap: json() consumes the stream even when parsing fails, so
    // the text() call throws "body stream already read" and that TypeError escapes
    // instead of the ApiError callers catch. Any error response with an empty or
    // non-JSON body hit this — e.g. Spring's ResponseEntity.notFound().build().
    const rawBody = await response.text().catch(() => '')
    let errorBody: unknown = rawBody
    if (rawBody) {
      try {
        errorBody = JSON.parse(rawBody)
      } catch {
        /* not JSON — keep the raw text */
      }
    }
    const message = extractErrorMessage(
      errorBody,
      `HTTP ${response.status}: ${response.statusText}`
    )
    if (response.status >= 502 && response.status <= 504) {
      useAppStore.getState().setServerReachable(false)
    }
    throw new ApiError(response.status, message, errorBody)
  }

  useAppStore.getState().setServerReachable(true)

  if (response.status === 204) return undefined as T

  return response.json() as Promise<T>
}

/**
 * Multipart upload and raw-blob download.
 *
 * These bypass {@link request} because it is JSON-only: it sets a JSON Content-Type (which
 * must be left to the browser for multipart, so it can add the boundary) and parses the reply
 * as JSON (wrong for a downloaded image). The auth, base-URL, unauthorized and reachability
 * handling is reproduced here deliberately rather than generalised — the JSON path is used by
 * everything and is not worth destabilising for two callers.
 */
async function multipart<T>(path: string, form: FormData, signal?: AbortSignal): Promise<T> {
  if (await sessionSilentlyExpired()) {
    onUnauthorized?.()
    throw new ApiError(401, 'نشست شما به پایان رسیده است. دوباره وارد شوید.')
  }
  const token = await getAccessToken()
  let response: Response
  // The upload budget, not the JSON one: this is carrying a compressed photo or voice note.
  const timeout = withTimeout(signal, UPLOAD_TIMEOUT_MS)
  try {
    response = await fetch(`${await getBaseUrl()}${path}`, {
      method: 'POST',
      // No Content-Type: the browser must set it, including the multipart boundary.
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
      signal: timeout.signal
    })
  } catch (error) {
    useAppStore.getState().setServerReachable(false)
    throw new ApiError(0, isTimeout(error)
      ? 'ارسال فایل در زمان مجاز کامل نشد.'
      : 'ارتباط با سرور برقرار نشد.')
  } finally {
    timeout.done()
  }
  if (response.status === 401) {
    await clearAuthSession()
    onUnauthorized?.()
  }
  if (!response.ok) {
    const raw = await response.text().catch(() => '')
    let body: unknown = raw
    if (raw) {
      try { body = JSON.parse(raw) } catch { /* not JSON */ }
    }
    throw new ApiError(response.status, extractErrorMessage(body, `HTTP ${response.status}`), body)
  }
  useAppStore.getState().setServerReachable(true)
  return response.json() as Promise<T>
}

async function fetchBlob(path: string, signal?: AbortSignal): Promise<Blob> {
  const token = await getAccessToken()
  let response: Response
  // A download of the same kind of file an upload carries, so the same budget.
  const timeout = withTimeout(signal, UPLOAD_TIMEOUT_MS)
  try {
    response = await fetch(`${await getBaseUrl()}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: timeout.signal
    })
  } catch (error) {
    useAppStore.getState().setServerReachable(false)
    throw new ApiError(0, isTimeout(error)
      ? 'دریافت فایل در زمان مجاز کامل نشد.'
      : 'ارتباط با سرور برقرار نشد.')
  } finally {
    timeout.done()
  }
  if (response.status === 401) {
    await clearAuthSession()
    onUnauthorized?.()
  }
  if (!response.ok) {
    throw new ApiError(response.status, `HTTP ${response.status}`)
  }
  useAppStore.getState().setServerReachable(true)
  return response.blob()
}

export const apiClient = {
  multipart,
  fetchBlob,
  get: <T>(path: string, signal?: AbortSignal, authRequired = true) =>
    request<T>('GET', path, undefined, signal, authRequired),
  post: <T>(path: string, body: unknown, signal?: AbortSignal, authRequired = true) =>
    request<T>('POST', path, body, signal, authRequired),
  put: <T>(path: string, body: unknown, signal?: AbortSignal, authRequired = true) =>
    request<T>('PUT', path, body, signal, authRequired),
  patch: <T>(path: string, body: unknown, signal?: AbortSignal, authRequired = true) =>
    request<T>('PATCH', path, body, signal, authRequired),
  delete: <T>(path: string, signal?: AbortSignal, authRequired = true) =>
    request<T>('DELETE', path, undefined, signal, authRequired)
}
