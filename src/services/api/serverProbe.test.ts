import { describe, expect, it, vi } from 'vitest'
import { isHealthyResponse, probeServer } from './serverProbe'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/**
 * The dot beside the server address must be green only when the backend itself answered. Each
 * case below is a response that really reaches a tablet in this deployment, and the reason the
 * old always-green dot was wrong in it.
 */
describe('isHealthyResponse', () => {
  it('accepts the backend’s own answer', () => {
    expect(isHealthyResponse(200, 'application/json', { status: 'ok', version: '1', timestamp: 1 })).toBe(true)
    expect(isHealthyResponse(200, 'application/json;charset=UTF-8', { status: 'ok' })).toBe(true)
  })

  it('refuses nginx answering for a backend that is down', () => {
    expect(isHealthyResponse(502, 'text/html', null)).toBe(false)
    expect(isHealthyResponse(503, 'application/json', { status: 'ok' })).toBe(false)
  })

  it('refuses a wrong address whose web server answers every path with an HTML page', () => {
    expect(isHealthyResponse(200, 'text/html', null)).toBe(false)
    expect(isHealthyResponse(200, null, { status: 'ok' })).toBe(false)
  })

  it('refuses JSON that is not this backend saying it is up', () => {
    expect(isHealthyResponse(200, 'application/json', { status: 'down' })).toBe(false)
    expect(isHealthyResponse(200, 'application/json', [])).toBe(false)
    expect(isHealthyResponse(200, 'application/json', null)).toBe(false)
  })
})

describe('probeServer', () => {
  it('asks /api/health at the given base, uncached', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ status: 'ok' }))

    expect(await probeServer('https://srv.example', { fetchImpl })).toBe(true)

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://srv.example/api/health')
    expect(init).toMatchObject({ method: 'GET', cache: 'no-store' })
  })

  it('treats same-origin (an empty base) as a relative path', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ status: 'ok' }))

    await probeServer('', { fetchImpl })

    expect(fetchImpl.mock.calls[0][0]).toBe('/api/health')
  })

  it('is false for a network failure', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    expect(await probeServer('https://srv', { fetchImpl })).toBe(false)
  })

  it('is false for a body that is not JSON at all', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('<html>app shell</html>', { status: 200, headers: { 'Content-Type': 'text/html' } })
    )
    expect(await probeServer('https://srv', { fetchImpl })).toBe(false)
  })

  it('settles on false when the server never answers', async () => {
    // A half-open connection on a plant network: the request just hangs. The dot must go red,
    // not spin forever.
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    )

    expect(await probeServer('https://srv', { fetchImpl: fetchImpl as never, timeoutMs: 20 })).toBe(false)
  })

  it('stops when the caller aborts', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    )

    const pending = probeServer('https://srv', { fetchImpl: fetchImpl as never, signal: controller.signal })
    controller.abort()

    expect(await pending).toBe(false)
  })
})
