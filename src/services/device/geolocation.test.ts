import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  captureCurrentLocation,
  formatCoordinate,
  parseCoordinate,
  isGeolocationSupported,
  LocationCaptureError
} from './geolocation'

function stubGeolocation(impl: unknown) {
  Object.defineProperty(globalThis, 'navigator', {
    value: impl === null ? {} : { geolocation: impl },
    configurable: true,
    writable: true
  })
}

afterEach(() => {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true })
})

describe('captureCurrentLocation', () => {
  it('produces the same shape the server stores', async () => {
    stubGeolocation({
      getCurrentPosition: (ok: PositionCallback) =>
        ok({
          coords: { latitude: 35.6892, longitude: 51.389, accuracy: 12.44 },
          timestamp: 1786105032313
        } as GeolocationPosition)
    })

    // Matches LocationValues on the backend, so a GPS capture and a coordinate typed into the
    // web panel are indistinguishable once saved.
    await expect(captureCurrentLocation()).resolves.toEqual({
      type: 'location',
      lat: 35.6892,
      lng: 51.389,
      accuracy: 12.4,
      capturedAt: 1786105032313
    })
  })

  it('omits accuracy rather than inventing a zero', async () => {
    stubGeolocation({
      getCurrentPosition: (ok: PositionCallback) =>
        ok({ coords: { latitude: 1, longitude: 2, accuracy: NaN }, timestamp: 5 } as GeolocationPosition)
    })

    // A fabricated 0 would read as a perfect fix, which is the opposite of the truth.
    await expect(captureCurrentLocation()).resolves.not.toHaveProperty('accuracy')
  })

  it('separates a denied permission from an unavailable fix', async () => {
    stubGeolocation({
      getCurrentPosition: (_ok: PositionCallback, fail: PositionErrorCallback) =>
        fail({ code: 1, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError)
    })

    // Only the denied case is something the operator can actually fix.
    await expect(captureCurrentLocation()).rejects.toMatchObject({ kind: 'denied' })
  })

  it('reports a timeout as a timeout', async () => {
    stubGeolocation({
      getCurrentPosition: (_ok: PositionCallback, fail: PositionErrorCallback) =>
        fail({ code: 3, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError)
    })

    await expect(captureCurrentLocation()).rejects.toMatchObject({ kind: 'timeout' })
  })

  it('fails cleanly when the browser has no geolocation', async () => {
    stubGeolocation(null)

    expect(isGeolocationSupported()).toBe(false)
    await expect(captureCurrentLocation()).rejects.toBeInstanceOf(LocationCaptureError)
  })
})

describe('parseCoordinate', () => {
  it('reads the stored object and the legacy string form', () => {
    expect(parseCoordinate({ type: 'location', lat: 1.5, lng: 2.5 })).toMatchObject({ lat: 1.5, lng: 2.5 })
    // Tolerated because the server's parse accepts it too.
    expect(parseCoordinate('35.6892, 51.3890')).toMatchObject({ lat: 35.6892, lng: 51.389 })
  })

  it('rejects out-of-range and malformed values', () => {
    expect(parseCoordinate({ lat: 91, lng: 0 })).toBeNull()
    expect(parseCoordinate({ lat: 0, lng: 181 })).toBeNull()
    expect(parseCoordinate('nonsense')).toBeNull()
    expect(parseCoordinate(null)).toBeNull()
    // An empty object is what a half-built value looks like; it is not a position.
    expect(parseCoordinate({})).toBeNull()
  })
})

describe('formatCoordinate', () => {
  it('shows six decimals and the accuracy when known', () => {
    expect(formatCoordinate({ lat: 35.6892, lng: 51.389, accuracy: 12.4 }))
      .toBe('35.689200, 51.389000 (±12 m)')
  })

  it('is empty for an unanswered field', () => {
    expect(formatCoordinate(null)).toBe('')
  })
})
