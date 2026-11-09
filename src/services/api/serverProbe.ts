/**
 * Whether the server answers — for the dot beside its address on the login page.
 *
 * <h2>What "reachable" means here, and what it deliberately does not</h2>
 *
 * The backend answered `GET /api/health` with its own JSON (`{"status": "ok"}`). Nothing more:
 * the database is not asked about, and nothing about the server's state reaches the tablet. That
 * is a choice, not a gap — the login that follows is the real test, and it reports a database
 * problem in its own words.
 *
 * Each condition below is something that has really answered a request in this deployment:
 *
 * - **A 2xx is required.** With nginx in front, a backend that is down still gets an answer —
 *   a 502 from nginx. That is the proxy, not the server, and a login would fail.
 * - **JSON with `status: "ok"` is required.** A wrong address can land on any web server, and a
 *   single-page app's fallback answers every path with `200` and an HTML page. Green for that
 *   would be the dot lying in exactly the case it exists for.
 * - **A time limit.** A half-open connection on a plant network can leave a request pending for
 *   minutes; the dot must settle on red, not spin.
 *
 * It deliberately does **not** go through `apiClient`, which records every outcome in the global
 * `serverReachable` flag that session validity reads. A probe from the login page must not be
 * able to change what the rest of the app believes.
 */

export type Reachability = 'checking' | 'reachable' | 'unreachable'

export const PROBE_TIMEOUT_MS = 5_000

/** How often the login page re-asks while it is on screen. */
export const PROBE_INTERVAL_MS = 15_000

/** Whether a response is this backend saying it is up. Pure, so every rule above is tested. */
export function isHealthyResponse(status: number, contentType: string | null, body: unknown): boolean {
  if (status < 200 || status >= 300) return false
  if (!contentType || !contentType.toLowerCase().includes('json')) return false
  return (
    body !== null &&
    typeof body === 'object' &&
    (body as { status?: unknown }).status === 'ok'
  )
}

export interface ProbeOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** Aborts the probe — the page went away, or the address changed. */
  signal?: AbortSignal
}

/**
 * Asks `{baseUrl}/api/health` once.
 *
 * @param baseUrl what `resolveBaseUrl` produces: `''` for same-origin, else the server address
 * @returns true only for a healthy answer within the time limit; every failure is false
 */
export async function probeServer(baseUrl: string, options: ProbeOptions = {}): Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? PROBE_TIMEOUT_MS)
  const forwardAbort = () => controller.abort()
  options.signal?.addEventListener('abort', forwardAbort)
  try {
    const response = await fetchImpl(`${baseUrl}/api/health`, {
      method: 'GET',
      // Never a cached answer: a health response from the cache says nothing about now.
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: controller.signal
    })
    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      body = null
    }
    return isHealthyResponse(response.status, response.headers.get('content-type'), body)
  } catch {
    return false
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', forwardAbort)
  }
}
