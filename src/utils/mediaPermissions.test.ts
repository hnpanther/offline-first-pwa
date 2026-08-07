import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  canUseMediaDevices,
  describeMediaError,
  getMicrophonePermission
} from '@/utils/mediaPermissions'

/**
 * These exist because of a bug an operator actually hit: photos worked, audio failed with a
 * raw English "Permission denied", and there was no prompt left to grant. Every case below is
 * about making sure the person holding the tablet is told something they can act on.
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('canUseMediaDevices', () => {
  it('is false on an insecure context, where mediaDevices does not even exist', () => {
    // Over plain HTTP, calling straight into navigator.mediaDevices throws a TypeError about
    // reading a property of undefined. Detecting it first is what turns that into a sentence.
    vi.stubGlobal('window', { isSecureContext: false })
    vi.stubGlobal('navigator', {})
    expect(canUseMediaDevices()).toBe(false)
  })

  it('is false when the context is secure but the API is missing', () => {
    vi.stubGlobal('window', { isSecureContext: true })
    vi.stubGlobal('navigator', { mediaDevices: {} })
    expect(canUseMediaDevices()).toBe(false)
  })

  it('is true on HTTPS with the API present', () => {
    vi.stubGlobal('window', { isSecureContext: true })
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => {} } })
    expect(canUseMediaDevices()).toBe(true)
  })
})

describe('getMicrophonePermission', () => {
  it('reports a blocked origin, which is what stops the prompt from ever appearing', async () => {
    vi.stubGlobal('navigator', {
      permissions: { query: async () => ({ state: 'denied' }) }
    })
    expect(await getMicrophonePermission()).toBe('denied')
  })

  it('reports that the browser will still ask', async () => {
    vi.stubGlobal('navigator', {
      permissions: { query: async () => ({ state: 'prompt' }) }
    })
    expect(await getMicrophonePermission()).toBe('prompt')
  })

  it('falls back to unknown where the Permissions API has no microphone descriptor', async () => {
    // Firefox throws on this descriptor. 'unknown' means "just try it and see" — never a
    // reason to block the operator from attempting a recording.
    vi.stubGlobal('navigator', {
      permissions: {
        query: async () => {
          throw new TypeError('unsupported')
        }
      }
    })
    expect(await getMicrophonePermission()).toBe('unknown')
  })

  it('falls back to unknown when the API is absent entirely', async () => {
    vi.stubGlobal('navigator', {})
    expect(await getMicrophonePermission()).toBe('unknown')
  })
})

describe('describeMediaError', () => {
  const err = (name: string) => new DOMException('raw browser text', name)

  it('flags a denial as needing a manual grant — there is no in-app way back', () => {
    const result = describeMediaError(err('NotAllowedError'))
    expect(result.needsManualGrant).toBe(true)
    expect(result.message).not.toContain('raw browser text')
  })

  it('says plainly that the site is blocked when the Permissions API confirms it', () => {
    const result = describeMediaError(err('NotAllowedError'), true)
    expect(result.message).toContain('مسدود')
    expect(result.needsManualGrant).toBe(true)
  })

  it('distinguishes a missing microphone from a refused one', () => {
    const result = describeMediaError(err('NotFoundError'))
    expect(result.needsManualGrant).toBe(false)
    expect(result.message).toContain('میکروفون')
  })

  it('tells the operator another app is holding the microphone', () => {
    // NotReadableError is the common one when a call or a voice recorder is open. Sending the
    // operator to permission settings here would be wrong — nothing there is broken.
    const result = describeMediaError(err('NotReadableError'))
    expect(result.needsManualGrant).toBe(false)
    expect(result.message).toContain('برنامه دیگری')
  })

  it('explains the HTTPS requirement rather than showing a SecurityError', () => {
    const result = describeMediaError(err('SecurityError'))
    expect(result.message).toContain('HTTPS')
    expect(result.needsManualGrant).toBe(false)
  })

  it('falls back to the error text for anything unrecognised', () => {
    expect(describeMediaError(new Error('چیز عجیبی رخ داد')).message).toBe('چیز عجیبی رخ داد')
  })

  it('produces a usable message even for a non-Error throw', () => {
    const result = describeMediaError('nonsense')
    expect(result.message).toBeTruthy()
    expect(result.needsManualGrant).toBe(false)
  })
})
