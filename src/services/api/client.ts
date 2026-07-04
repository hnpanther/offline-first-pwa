import { getSettings } from '@/services/storage'
import { getAccessToken, clearAuthSession } from '@/services/auth'

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
  return settings.serverUrl.replace(/\/$/, '')
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

  const response = await fetch(url, {
    method,
    headers: await buildHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal
  })

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
    throw new ApiError(response.status, message, errorBody)
  }

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
