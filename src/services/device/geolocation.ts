/**
 * Reading the device position for a `location` class field.
 *
 * ## Why the value is an object, not "35.6892,51.3890"
 * The server stores `{ type, lat, lng, accuracy, capturedAt }` (see `LocationValues` on the
 * backend). A string forces every consumer to re-parse and re-guess which number came first,
 * and quietly loses precision the first time anyone formats it. This module produces exactly
 * the stored shape so a GPS capture and a coordinate typed into the web panel are
 * indistinguishable once saved.
 *
 * ## Why accuracy is carried
 * In a plant a phone fix can be tens of metres out — the difference between "at the pump" and
 * "at the next pump". A coordinate with no accuracy figure cannot be judged, so it travels with
 * the reading rather than being dropped for tidiness.
 *
 * ## Offline
 * GPS needs no network. `getCurrentPosition` works with the radio off, which is the whole point
 * of capturing here rather than asking someone to type it in later.
 */

export interface CapturedLocation {
  type: 'location'
  lat: number
  lng: number
  accuracy?: number
  capturedAt: number
}

export type LocationErrorKind = 'unsupported' | 'denied' | 'unavailable' | 'timeout'

export class LocationCaptureError extends Error {
  constructor(readonly kind: LocationErrorKind, message: string) {
    super(message)
    this.name = 'LocationCaptureError'
  }
}

const MESSAGES: Record<LocationErrorKind, string> = {
  unsupported: 'این دستگاه یا مرورگر امکان دریافت موقعیت مکانی را ندارد.',
  // Distinct from the others on purpose: this is the only one the operator can fix themselves,
  // and telling them to "try again" would be useless advice.
  denied: 'دسترسی به موقعیت مکانی داده نشده است. از تنظیمات مرورگر یا دستگاه، اجازه دسترسی به موقعیت را فعال کنید.',
  unavailable: 'موقعیت مکانی در دسترس نیست. در فضای باز و با GPS روشن دوباره تلاش کنید.',
  timeout: 'دریافت موقعیت بیش از حد طول کشید. در فضای باز دوباره تلاش کنید.'
}

export function isGeolocationSupported(): boolean {
  return typeof navigator !== 'undefined' && 'geolocation' in navigator
}

/**
 * One position fix.
 *
 * `enableHighAccuracy` is on because a coarse network fix is worthless for telling one pump
 * from the next; the cost is a slower, more power-hungry read, which is the right trade for a
 * reading taken once per round. `maximumAge: 0` refuses a cached fix — the point is where the
 * operator is standing *now*, not where the phone was when it last looked.
 */
export function captureCurrentLocation(timeoutMs = 20_000): Promise<CapturedLocation> {
  if (!isGeolocationSupported()) {
    return Promise.reject(new LocationCaptureError('unsupported', MESSAGES.unsupported))
  }

  return new Promise<CapturedLocation>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      position => {
        const { latitude, longitude, accuracy } = position.coords
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          reject(new LocationCaptureError('unavailable', MESSAGES.unavailable))
          return
        }
        resolve({
          type: 'location',
          lat: latitude,
          lng: longitude,
          // Only when the device actually reports it; a fabricated 0 would read as perfect.
          ...(Number.isFinite(accuracy) ? { accuracy: Math.round(accuracy * 10) / 10 } : {}),
          capturedAt: position.timestamp || Date.now()
        })
      },
      error => {
        const kind: LocationErrorKind =
          error.code === error.PERMISSION_DENIED
            ? 'denied'
            : error.code === error.TIMEOUT
              ? 'timeout'
              : 'unavailable'
        reject(new LocationCaptureError(kind, MESSAGES[kind]))
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 }
    )
  })
}

/** Six decimals ≈ 11 cm — past that the digits are noise pretending to be precision. */
export function formatCoordinate(value: unknown): string {
  const parsed = parseCoordinate(value)
  if (!parsed) return ''
  const base = `${parsed.lat.toFixed(6)}, ${parsed.lng.toFixed(6)}`
  return parsed.accuracy != null ? `${base} (±${Math.round(parsed.accuracy)} m)` : base
}

/** Mirrors the server's `LocationValues.parse`, including its "lat,lng" string tolerance. */
export function parseCoordinate(value: unknown): CapturedLocation | null {
  if (value == null) return null

  if (typeof value === 'string') {
    const parts = value.split(',')
    if (parts.length !== 2) return null
    return build(Number(parts[0].trim()), Number(parts[1].trim()))
  }

  if (typeof value === 'object') {
    const v = value as Record<string, unknown>
    const coord = build(Number(v.lat), Number(v.lng))
    if (!coord) return null
    const accuracy = Number(v.accuracy)
    const capturedAt = Number(v.capturedAt)
    return {
      ...coord,
      ...(Number.isFinite(accuracy) ? { accuracy } : {}),
      capturedAt: Number.isFinite(capturedAt) ? capturedAt : coord.capturedAt
    }
  }

  return null
}

function build(lat: number, lng: number): CapturedLocation | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  // WGS-84 bounds. Anything outside is corruption, not a place.
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
  return { type: 'location', lat, lng, capturedAt: Date.now() }
}
