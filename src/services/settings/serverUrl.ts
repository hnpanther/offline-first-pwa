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

/** What is wrong with a URL, in Persian, or null when it is acceptable. */
export function validateServerUrl(raw: string): string | null {
  const value = (raw ?? '').trim()
  if (!value) return 'آدرس سرور نمی‌تواند خالی باشد.'

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return 'آدرس سرور معتبر نیست. نمونه درست: https://server.example.com'
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'آدرس سرور باید با http:// یا https:// شروع شود.'
  }
  if (!url.hostname) {
    return 'آدرس سرور باید شامل نام یا IP سرور باشد.'
  }
  // A path, query or fragment here is always a mistake: every request appends its own path, so
  // "https://host/api" would produce "https://host/api/api/...". Rejecting it is far kinder
  // than the 404s it otherwise causes.
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
    return 'آدرس سرور باید فقط شامل دامنه و پورت باشد، بدون مسیر اضافه.'
  }
  return null
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
