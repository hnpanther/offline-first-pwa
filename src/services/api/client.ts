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
  try {
    response = await fetch(url, {
      method,
      headers: await buildHeaders(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal
    })
  } catch {
    useAppStore.getState().setServerReachable(false)
    throw new ApiError(0, 'ارتباط با سرور برقرار نشد.')
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

export const apiClient = {
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
