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

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  authRequired = true
): Promise<T> {
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
    let errorBody: unknown
    try {
      errorBody = await response.json()
    } catch {
      errorBody = await response.text()
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
