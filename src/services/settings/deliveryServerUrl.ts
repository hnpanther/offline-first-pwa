import { hasCapacitorGlobal, isNativeApp } from '@/services/device/nativeApp'

/**
 * Which server address this device actually talks to — and why the two deliveries answer
 * differently.
 *
 * <h2>The browser delivery: always the page's own origin</h2>
 *
 * In a browser the app is served by the same nginx that proxies `/api/` to Spring. The server is
 * therefore, by construction, the origin the page was loaded from — whatever name or IP the
 * operator typed to get there. So a production bundle in a browser ignores both the build's
 * `VITE_SERVER_URL` and any stored address, and uses `window.location.origin`.
 *
 * That is what lets one `dist/` survive a change of domain, or be reached as `https://abc.com` and
 * `https://192.168.60.1` side by side, with no rebuild: each origin talks to itself.
 *
 * <p>A stored address is *ignored* here, not merely used as a default, and that is deliberate.
 * Any other address cannot work from this delivery: nginx sends `connect-src 'self'`, so the
 * browser refuses the request before it leaves (and an `http://` one is mixed content on an
 * `https://` page anyway). A stored foreign value therefore only ever means a broken device: a row
 * written by an older build, which seeded `VITE_SERVER_URL` into every origin, or an address
 * someone typed into Settings. Honouring it would keep that device unable to log in; following the
 * page heals it without anybody touching the tablet.
 *
 * <h2>The packaged app: the stored address, seeded from the build</h2>
 *
 * Inside the APK the page's origin is `https://localhost` — Capacitor's own local server, which
 * has no `/api` and never will. Following the page there would send every request into the app's
 * own asset server: a fresh install could not log in, and an updated one would lose the address an
 * administrator set. So the APK keeps exactly the rule it always had: the stored address, else the
 * build's `VITE_SERVER_URL`, else the development fallback. An administrator changes it on the
 * device in Settings (see `applyServerUrlChange`).
 *
 * <p>Telling the two apart is therefore the one place where guessing "browser" inside the app is
 * unrecoverable, so any Capacitor global counts as the app — see `hasCapacitorGlobal`.
 *
 * <h2>Development servers keep the old rule too</h2>
 *
 * `npm run dev` has no `/api` proxy: it talks to Spring on `:8081` directly, through CORS. Only a
 * production bundle is known to sit behind a proxy on its own origin — nginx, or `vite preview`,
 * which is configured with the same proxy for exactly this reason (`vite.config.ts`).
 */

/** Where a device with nothing configured points in development. Never right on a tablet. */
export const FALLBACK_SERVER_URL = 'http://localhost:8081'

/** What the device knows about where it is running. Passed in, so every rule is testable. */
export interface DeliveryContext {
  /** Inside the packaged app — any Capacitor runtime at all. */
  readonly native: boolean
  /** A production bundle (`import.meta.env.PROD`): served by nginx or `vite preview`. */
  readonly production: boolean
  /** `window.location.origin`, or null where there is no page (tests, a build's module scope). */
  readonly pageOrigin: string | null
}

/**
 * The page's origin when it can be a server address, else null.
 *
 * `window.location.origin` is the string `'null'` for `file:` and sandboxed pages, and a
 * non-http scheme (`capacitor://localhost` on iOS) has no server behind it.
 */
function usablePageOrigin(pageOrigin: string | null): string | null {
  if (!pageOrigin || pageOrigin === 'null') return null
  try {
    const url = new URL(pageOrigin)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return url.origin
  } catch {
    return null
  }
}

/**
 * Whether this device's server is fixed by the page it was loaded from.
 *
 * True only for a production bundle in a browser. Settings uses it to show the address as
 * read-only — editing it there could not change anything.
 */
export function serverFollowsPage(ctx: DeliveryContext): boolean {
  return !ctx.native && ctx.production && usablePageOrigin(ctx.pageOrigin) !== null
}

/**
 * The address this device must use.
 *
 * @param stored    the address in the settings row, if there is one
 * @param ctx       where the device is running
 * @param buildSeed the build's `VITE_SERVER_URL`, if it had one
 */
export function effectiveServerUrl(
  stored: string | undefined,
  ctx: DeliveryContext,
  buildSeed: string | undefined
): string {
  const pageOrigin = usablePageOrigin(ctx.pageOrigin)
  if (!ctx.native && ctx.production && pageOrigin !== null) return pageOrigin
  // An empty string is not an address: treat it as absent, as `??` alone would not.
  return stored || buildSeed || FALLBACK_SERVER_URL
}

/** The build's environment, read at call time so a test's `vi.stubEnv` is seen. */
function buildEnv(): { readonly PROD?: boolean; readonly VITE_SERVER_URL?: string } {
  return import.meta.env
}

/** The context of the page this code is running in, read now — never cached at module scope. */
export function currentDeliveryContext(): DeliveryContext {
  let pageOrigin: string | null = null
  if (typeof window !== 'undefined') {
    try {
      pageOrigin = window.location?.origin ?? null
    } catch {
      pageOrigin = null
    }
  }
  return {
    native: isNativeApp() || hasCapacitorGlobal(),
    production: buildEnv().PROD === true,
    pageOrigin
  }
}

/** The address this device uses, given what is stored. What `getSettings()` returns. */
export function deviceServerUrl(stored?: string): string {
  return effectiveServerUrl(stored, currentDeliveryContext(), buildEnv().VITE_SERVER_URL)
}

/** `serverFollowsPage` for the page this code is running in. */
export function deviceServerFollowsPage(): boolean {
  return serverFollowsPage(currentDeliveryContext())
}
