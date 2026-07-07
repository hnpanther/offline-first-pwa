import { ApiError } from '@/services/api/client'

/** Network up but host/API unreachable (connection refused, timeout, 502/503). */
export function isTransientNetworkError(err: unknown): boolean {
  if (err instanceof ApiError && err.status === 0) return true
  if (err instanceof TypeError) return true
  if (err instanceof ApiError && err.status >= 502 && err.status <= 504) return true
  const msg = err instanceof Error ? err.message.toLowerCase() : ''
  return (
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('network request failed') ||
    msg.includes('load failed') ||
    msg.includes('econnrefused')
  )
}
