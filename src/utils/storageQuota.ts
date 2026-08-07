/**
 * Device storage: asking the browser not to throw our data away, and noticing when it is full.
 *
 * This became necessary the moment attachments started living in IndexedDB. Text-only log
 * sheets are kilobytes and eviction was a theoretical worry; a shift's worth of photos is
 * tens of megabytes, which is exactly the kind of origin a browser reclaims first when the
 * device runs low. Eviction is silent and takes *everything* — including submitted sheets
 * that had not synced yet — so the cheap defence is worth having.
 */

/** Below this much free space, capture is refused rather than risking a half-written blob. */
export const LOW_STORAGE_THRESHOLD_BYTES = 20 * 1024 * 1024

export interface StorageStatus {
  /** Bytes this origin is currently using, when the browser reports it. */
  usage?: number
  /** Bytes this origin may use, when the browser reports it. */
  quota?: number
  /** Remaining bytes, or undefined when the browser reports nothing. */
  available?: number
  /** True when the remaining space is too small to accept another capture safely. */
  low: boolean
}

/**
 * Asks for persistent storage, which exempts this origin from routine eviction.
 *
 * Chrome grants it silently for an installed PWA, which is the deployment shape here, and
 * refuses it for a casual tab — so a `false` is normal and must not be treated as an error.
 * Safe to call repeatedly: once granted the browser answers from its existing grant.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false
  try {
    if (navigator.storage.persisted && (await navigator.storage.persisted())) return true
    return await navigator.storage.persist()
  } catch {
    // Some browsers throw in private mode. Not being persisted is a degraded state, not a
    // broken one — the app keeps working, it just has a weaker claim on the disk.
    return false
  }
}

/**
 * Current usage against quota.
 *
 * A browser that reports nothing yields `low: false`: refusing to let an operator take a
 * photo because we could not measure the disk would be a worse failure than the one we are
 * guarding against.
 */
export async function getStorageStatus(
  threshold = LOW_STORAGE_THRESHOLD_BYTES
): Promise<StorageStatus> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
    return { low: false }
  }
  try {
    const { usage, quota } = await navigator.storage.estimate()
    if (usage == null || quota == null) return { usage, quota, low: false }
    const available = Math.max(0, quota - usage)
    return { usage, quota, available, low: available < threshold }
  } catch {
    return { low: false }
  }
}
