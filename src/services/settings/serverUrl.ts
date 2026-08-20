/**
 * Validating the server URL, and deciding when changing it must end the session.
 *
 * <h2>Why this is a security concern and not a form-validation nicety</h2>
 *
 * The API client attaches the current JWT to every request it sends to whatever URL settings
 * hold. So the moment that URL points somewhere else, the next request hands this plant's
 * bearer token to that host — a typo, a stale address from another site, a plain-HTTP address
 * on a shared network, or an address somebody else controls.
 *
 * The token is short-lived and the Settings screen is gated behind plant-wide scope, so this is
 * not reachable by an ordinary operator. It is still a credential leaving the building on a
 * single mistyped character, and the fix is cheap: **changing origin ends the session**. A
 * token issued by server A is never sent to server B, because by the time B is configured there
 * is no token.
 *
 * Kept out of the page component so it can be tested without rendering anything.
 */

/**
 * The outcome of checking a server address: either a reason to reject it, or the value to store.
 *
 * <p>Returning the normalised value is the part that matters. Validation used to `trim()` only
 * for its own checks while the raw form value was what got written, so `"https://host "` passed
 * and was stored **with the space** — and since `originOf` also trims, a whitespace-only edit did
 * not even count as an origin change, so it was saved with no warning and no logout. The device
 * then built `"https://host /api/..."` on every request and simply stopped talking to the
 * server, from the one screen an operator can no longer reach once they are logged out.
 */
export interface ServerUrlCheck {
  /** Persian reason to reject, or null when acceptable. */
  readonly error: string | null
  /** The value to persist — scheme, host and port only. Null when `error` is set. */
  readonly normalized: string | null
}

/** What is wrong with a URL, in Persian, or null when it is acceptable. */
export function validateServerUrl(raw: string): string | null {
  return checkServerUrl(raw).error
}

/** Validates and, when acceptable, returns the exact value that should be stored. */
export function checkServerUrl(raw: string): ServerUrlCheck {
  const value = (raw ?? '').trim()
  if (!value) return { error: 'آدرس سرور نمی‌تواند خالی باشد.', normalized: null }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return {
      error: 'آدرس سرور معتبر نیست. نمونه درست: https://server.example.com',
      normalized: null
    }
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { error: 'آدرس سرور باید با http:// یا https:// شروع شود.', normalized: null }
  }
  if (!url.hostname) {
    return { error: 'آدرس سرور باید شامل نام یا IP سرور باشد.', normalized: null }
  }
  // A path, query or fragment here is always a mistake: every request appends its own path, so
  // "https://host/api" would produce "https://host/api/api/...". Rejecting it is far kinder
  // than the 404s it otherwise causes.
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
    return {
      error: 'آدرس سرور باید فقط شامل دامنه و پورت باشد، بدون مسیر اضافه.',
      normalized: null
    }
  }
  // `origin` is exactly scheme + host + port, with no trailing slash and the host lower-cased —
  // the canonical form, so what is stored can never differ from what was compared.
  return { error: null, normalized: url.origin }
}

/**
 * The comparable identity of a server address: scheme, host and port.
 *
 * A trailing slash or a change of letter case is not a different server, and forcing a re-login
 * for one would train people to ignore the warning that matters.
 */
export function originOf(raw: string): string | null {
  try {
    return new URL((raw ?? '').trim()).origin.toLowerCase()
  } catch {
    return null
  }
}

/**
 * Whether moving from one address to another must end the session.
 *
 * True whenever the origin changes — including to or from an unparseable value, because a
 * token must not survive into a state nobody can reason about.
 */
export function requiresReauthentication(previous: string, next: string): boolean {
  const before = originOf(previous)
  const after = originOf(next)
  if (before === null || after === null) return before !== after
  return before !== after
}
