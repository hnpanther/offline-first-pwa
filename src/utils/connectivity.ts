/** Wi‑Fi, mobile data, etc. */
export function hasDeviceNetwork(): boolean {
  return navigator.onLine
}

/** Device has network and the app/API host responded recently. */
export function canReachServer(
  hasNetwork: boolean,
  serverReachable: boolean | null
): boolean {
  return hasNetwork && serverReachable !== false
}

/** No network, or network up but server unreachable — work from local cache. */
export function isEffectivelyOffline(
  hasNetwork: boolean,
  serverReachable: boolean | null
): boolean {
  return !canReachServer(hasNetwork, serverReachable)
}
