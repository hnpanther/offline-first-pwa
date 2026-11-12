import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  currentDeliveryContext,
  deviceServerFollowsPage,
  deviceServerUrl,
  effectiveServerUrl,
  FALLBACK_SERVER_URL,
  serverFollowsPage,
  type DeliveryContext
} from './deliveryServerUrl'

/**
 * Which server a device talks to.
 *
 * <h2>The two promises these cases pin</h2>
 *
 * 1. **A browser's production bundle talks to the origin it was loaded from** — not the build's
 *    `VITE_SERVER_URL`, not a stored address. That is what lets one `dist/` work under a new
 *    domain, or under a domain and an IP at once, with no rebuild.
 * 2. **The packaged app never does.** Its page origin is Capacitor's local asset server; following
 *    it would send the login to a server with no API. The APK keeps the stored address, seeded
 *    from the build — which is what an administrator changes in Settings.
 *
 * The second is the dangerous one to get wrong, so it is pinned from several directions.
 */

const SEED = 'https://seed.example'
const STORED = 'https://stored.example'

const browserProd = (pageOrigin: string | null): DeliveryContext => ({
  native: false,
  production: true,
  pageOrigin
})

describe('effectiveServerUrl — a browser production bundle', () => {
  it('uses the page origin, ignoring the build seed', () => {
    expect(effectiveServerUrl(undefined, browserProd('https://abc.com'), SEED)).toBe('https://abc.com')
  })

  it('uses the page origin, ignoring a stored address too', () => {
    // A stored foreign address can only be a broken device: nginx's connect-src 'self' refuses it.
    expect(effectiveServerUrl(STORED, browserProd('https://abc.com'), SEED)).toBe('https://abc.com')
  })

  it('gives each origin its own server — the same bundle under two names', () => {
    // The deployment this exists for: one nginx, reached by a domain and by an IP.
    expect(effectiveServerUrl('https://abc.com', browserProd('https://192.168.60.1'), SEED))
      .toBe('https://192.168.60.1')
    expect(effectiveServerUrl('https://192.168.60.1', browserProd('https://abc.com'), SEED))
      .toBe('https://abc.com')
  })

  it('keeps a non-default port, because the origin does', () => {
    expect(effectiveServerUrl(undefined, browserProd('https://192.168.1.2:4173'), SEED))
      .toBe('https://192.168.1.2:4173')
  })

  it('works over plain http on localhost, where `vite preview` serves it', () => {
    expect(effectiveServerUrl(undefined, browserProd('http://localhost:4173'), undefined))
      .toBe('http://localhost:4173')
  })

  it('falls back to the stored address when the page origin is not a server', () => {
    // `file:` and sandboxed pages report the string 'null'; iOS Capacitor uses capacitor://.
    for (const origin of ['null', 'capacitor://localhost', 'not a url', '']) {
      expect(effectiveServerUrl(STORED, browserProd(origin), SEED)).toBe(STORED)
    }
    expect(effectiveServerUrl(STORED, browserProd(null), SEED)).toBe(STORED)
  })
})

describe('effectiveServerUrl — the packaged app', () => {
  const app = (pageOrigin: string | null = 'https://localhost'): DeliveryContext => ({
    native: true,
    production: true,
    pageOrigin
  })

  it("never uses the page origin — Capacitor's https://localhost has no API", () => {
    expect(effectiveServerUrl(undefined, app(), SEED)).toBe(SEED)
    expect(effectiveServerUrl(STORED, app(), SEED)).toBe(STORED)
  })

  it('uses the stored address over the seed — what an administrator set in Settings wins', () => {
    expect(effectiveServerUrl(STORED, app(), SEED)).toBe(STORED)
  })

  it('a fresh install uses the build seed', () => {
    expect(effectiveServerUrl(undefined, app(), SEED)).toBe(SEED)
  })

  it('ignores the page origin whatever it is', () => {
    for (const origin of ['https://localhost', 'http://localhost', 'https://abc.com', null]) {
      expect(effectiveServerUrl(STORED, app(origin), SEED)).toBe(STORED)
    }
  })

  it('falls back only when there is neither a stored address nor a seed', () => {
    expect(effectiveServerUrl(undefined, app(), undefined)).toBe(FALLBACK_SERVER_URL)
  })

  it('treats an empty stored address or seed as absent', () => {
    expect(effectiveServerUrl('', app(), SEED)).toBe(SEED)
    expect(effectiveServerUrl('', app(), '')).toBe(FALLBACK_SERVER_URL)
  })
})

describe('effectiveServerUrl — development servers keep the old rule', () => {
  const dev: DeliveryContext = { native: false, production: false, pageOrigin: 'http://localhost:5173' }

  it('uses the stored address — `npm run dev` has no /api proxy', () => {
    expect(effectiveServerUrl('http://localhost:8081', dev, SEED)).toBe('http://localhost:8081')
  })

  it('then the seed, then the fallback', () => {
    expect(effectiveServerUrl(undefined, dev, SEED)).toBe(SEED)
    expect(effectiveServerUrl(undefined, dev, undefined)).toBe(FALLBACK_SERVER_URL)
  })
})

describe('serverFollowsPage', () => {
  it('is true only for a browser production bundle with a real origin', () => {
    expect(serverFollowsPage(browserProd('https://abc.com'))).toBe(true)
    expect(serverFollowsPage({ native: true, production: true, pageOrigin: 'https://localhost' })).toBe(false)
    expect(serverFollowsPage({ native: false, production: false, pageOrigin: 'http://localhost:5173' })).toBe(false)
    expect(serverFollowsPage(browserProd('null'))).toBe(false)
    expect(serverFollowsPage(browserProd(null))).toBe(false)
  })

  it('agrees with effectiveServerUrl on every context', () => {
    // Settings shows the field read-only exactly when the address cannot be changed there.
    const contexts: DeliveryContext[] = [
      browserProd('https://abc.com'),
      browserProd('null'),
      browserProd(null),
      { native: true, production: true, pageOrigin: 'https://localhost' },
      { native: false, production: false, pageOrigin: 'http://localhost:5173' }
    ]
    for (const ctx of contexts) {
      const followed = effectiveServerUrl(STORED, ctx, SEED) !== STORED
      expect(serverFollowsPage(ctx)).toBe(followed)
    }
  })
})

/**
 * The live context, read from the page. The suite runs on `environment: 'node'`, so `window` is
 * assembled here — which is also the only way to exercise "no window at all".
 */
describe('currentDeliveryContext', () => {
  const originalWindow = (globalThis as { window?: unknown }).window

  afterEach(() => {
    ;(globalThis as { window?: unknown }).window = originalWindow
    vi.unstubAllEnvs()
  })

  function withWindow(win: object): void {
    ;(globalThis as { window?: unknown }).window = win
  }

  it('reads the page origin', () => {
    withWindow({ location: { origin: 'https://abc.com' } })
    expect(currentDeliveryContext().pageOrigin).toBe('https://abc.com')
    expect(currentDeliveryContext().native).toBe(false)
  })

  it('has no origin and is not native where there is no window', () => {
    delete (globalThis as { window?: unknown }).window
    expect(currentDeliveryContext()).toMatchObject({ native: false, pageOrigin: null })
  })

  it('is native when Capacitor says so', () => {
    withWindow({
      location: { origin: 'https://localhost' },
      Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' }
    })
    expect(currentDeliveryContext().native).toBe(true)
  })

  it('is native on the mere presence of a Capacitor global — the safe direction', () => {
    // A runtime that has injected itself but cannot (yet) describe itself is still the app.
    // Mistaking it for a browser would point the login at Capacitor's own asset server.
    withWindow({ location: { origin: 'https://localhost' }, Capacitor: {} })
    expect(currentDeliveryContext().native).toBe(true)
  })

  it('follows import.meta.env.PROD', () => {
    vi.stubEnv('PROD', true)
    expect(currentDeliveryContext().production).toBe(true)
    vi.stubEnv('PROD', false)
    expect(currentDeliveryContext().production).toBe(false)
  })

  it('survives a location that throws on read', () => {
    withWindow({
      get location(): never {
        throw new Error('blocked')
      }
    })
    expect(currentDeliveryContext().pageOrigin).toBeNull()
  })
})

describe('deviceServerUrl / deviceServerFollowsPage — wired to the live page', () => {
  const originalWindow = (globalThis as { window?: unknown }).window

  afterEach(() => {
    ;(globalThis as { window?: unknown }).window = originalWindow
    vi.unstubAllEnvs()
  })

  it('in a browser production bundle: the page origin, whatever the build seed', () => {
    vi.stubEnv('PROD', true)
    vi.stubEnv('VITE_SERVER_URL', SEED)
    ;(globalThis as { window?: unknown }).window = { location: { origin: 'https://cbd.com' } }

    expect(deviceServerUrl()).toBe('https://cbd.com')
    expect(deviceServerUrl(STORED)).toBe('https://cbd.com')
    expect(deviceServerFollowsPage()).toBe(true)
  })

  it('in the packaged app: the stored address, else the build seed', () => {
    vi.stubEnv('PROD', true)
    vi.stubEnv('VITE_SERVER_URL', SEED)
    ;(globalThis as { window?: unknown }).window = {
      location: { origin: 'https://localhost' },
      Capacitor: { isNativePlatform: () => true }
    }

    expect(deviceServerUrl()).toBe(SEED)
    expect(deviceServerUrl(STORED)).toBe(STORED)
    expect(deviceServerFollowsPage()).toBe(false)
  })
})
