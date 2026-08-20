import { describe, expect, it } from 'vitest'

import { originOf, requiresReauthentication, validateServerUrl } from './serverUrl'

/**
 * The server address decides where this device sends its bearer token.
 *
 * `apiClient` attaches the current JWT to every request aimed at whatever URL settings hold, so
 * the moment that address points elsewhere the next request hands the plant's credential to
 * that host — through a typo, a stale address from another site, or a plain-HTTP host on a
 * shared network. The Settings screen is gated behind plant-wide scope and the token is
 * short-lived, so this is not reachable by an operator; it is still a credential leaving on one
 * mistyped character.
 *
 * The rule that closes it is simple and tested here: **a change of origin ends the session**,
 * so a token issued by server A can never be sent to server B.
 */
describe('validateServerUrl', () => {
  it('accepts an ordinary https address', () => {
    expect(validateServerUrl('https://logsheet.example.com')).toBeNull()
  })

  it('accepts a plant-network http address with a port', () => {
    // The real deployment shape: an IP and a port on an internal network.
    expect(validateServerUrl('http://192.168.1.100:8081')).toBeNull()
  })

  it('accepts a trailing slash', () => {
    expect(validateServerUrl('https://logsheet.example.com/')).toBeNull()
  })

  it('trims surrounding whitespace', () => {
    expect(validateServerUrl('  https://logsheet.example.com  ')).toBeNull()
  })

  it('rejects an empty address', () => {
    expect(validateServerUrl('')).toContain('خالی')
    expect(validateServerUrl('   ')).toContain('خالی')
  })

  it('rejects an address with no scheme', () => {
    expect(validateServerUrl('192.168.1.100:8081')).not.toBeNull()
    expect(validateServerUrl('logsheet.example.com')).not.toBeNull()
  })

  it('rejects a scheme that is not http or https', () => {
    // javascript: and data: are the ones worth naming; ftp: stands in for the rest.
    expect(validateServerUrl('javascript:alert(1)')).not.toBeNull()
    expect(validateServerUrl('ftp://host')).not.toBeNull()
    expect(validateServerUrl('file:///etc/passwd')).not.toBeNull()
  })

  it('rejects an address carrying a path, query or fragment', () => {
    // Every request appends its own path, so "https://host/api" produces "/api/api/…". A clear
    // rejection beats the 404s that otherwise follow.
    expect(validateServerUrl('https://host/api')).toContain('مسیر')
    expect(validateServerUrl('https://host/?x=1')).not.toBeNull()
    expect(validateServerUrl('https://host/#frag')).not.toBeNull()
  })

  it('gives a Persian message in every rejection', () => {
    for (const bad of ['', 'nonsense', 'ftp://h', 'https://h/api']) {
      const message = validateServerUrl(bad)
      expect(message).not.toBeNull()
      expect(message!).toMatch(/[؀-ۿ]/)
    }
  })
})

describe('requiresReauthentication', () => {
  it('is false for the same address', () => {
    expect(requiresReauthentication('https://a.example.com', 'https://a.example.com')).toBe(false)
  })

  it('ignores a trailing slash and letter case', () => {
    // Forcing a re-login for a cosmetic edit would train people to click through the warning
    // that matters.
    expect(requiresReauthentication('https://A.example.com', 'https://a.example.com/')).toBe(false)
  })

  it('is true for a different host', () => {
    expect(requiresReauthentication('https://a.example.com', 'https://b.example.com')).toBe(true)
  })

  it('is true for a different port', () => {
    // A different port is a different server process, and quite possibly a different plant.
    expect(requiresReauthentication('http://10.0.0.5:8081', 'http://10.0.0.5:9090')).toBe(true)
  })

  it('is true when the scheme changes', () => {
    // https → http is exactly the downgrade that would put the token on the wire in clear.
    expect(requiresReauthentication('https://a.example.com', 'http://a.example.com')).toBe(true)
  })

  it('is true when either side is unparseable', () => {
    // A token must not survive into a state nobody can reason about.
    expect(requiresReauthentication('https://a.example.com', 'nonsense')).toBe(true)
    expect(requiresReauthentication('nonsense', 'https://a.example.com')).toBe(true)
  })

  it('is false when both sides are equally unparseable', () => {
    expect(requiresReauthentication('nonsense', 'nonsense')).toBe(false)
  })
})

describe('originOf', () => {
  it('reduces an address to scheme, host and port', () => {
    expect(originOf('https://a.example.com/')).toBe('https://a.example.com')
    expect(originOf('http://10.0.0.5:8081')).toBe('http://10.0.0.5:8081')
  })

  it('is null for something that is not a URL', () => {
    expect(originOf('nonsense')).toBeNull()
  })
})
