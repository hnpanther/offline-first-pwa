import type { NFCTagData } from '@/types'

/**
 * Who gets the next NFC tag: the round's asset list, or one field waiting to be filled.
 *
 * <h3>Why a claim is needed at all</h3>
 *
 * There is exactly one NFC reader and one `lastScannedTag` in the store, and now two things
 * want a tag for different reasons. The fill page uses one to answer **"which asset is this?"**
 * — `matchLogSheetEntryByTag`, which rejects anything not on the round. A field being filled
 * from a nameplate tag wants the **payload itself**, and that payload is deliberately not an
 * asset on this round.
 *
 * Without a claim, scanning a tag to fill a serial field would also reach the page's handler,
 * which would say «Asset مربوط به تگ ... در این Log Sheet وجود ندارد» and refuse — a correct
 * scan reported as an error. So a field announces that the next tag is its own, and the page
 * stands down for exactly that one read.
 *
 * <h3>One claim at a time, and it is always released</h3>
 *
 * A second claim replaces the first rather than queueing: two fields cannot both be waiting,
 * because there is one reader and one operator. Every claim returns its own release function,
 * which is idempotent and safe to call after the claim has already been taken or replaced —
 * a component unmounting mid-scan must never leave the page permanently deaf to tags.
 */

type TagHandler = (tag: NFCTagData) => void

let activeHandler: TagHandler | null = null

/**
 * Claim the next tag for a field.
 *
 * @returns a release function. Call it on unmount and after handling, always.
 */
export function claimNextTagForField(handler: TagHandler): () => void {
  activeHandler = handler
  return () => {
    // Only release our own claim: a later claim has already replaced this one, and clearing it
    // would leave that field waiting for a tag nothing will deliver.
    if (activeHandler === handler) {
      activeHandler = null
    }
  }
}

/**
 * Offer a scanned tag to the waiting field.
 *
 * @returns `true` when a field took it, meaning the caller must not also treat it as an asset.
 */
export function offerTagToField(tag: NFCTagData): boolean {
  const handler = activeHandler
  if (!handler) return false
  // Cleared before the handler runs, so a handler that synchronously starts another scan is
  // not handed its own tag a second time.
  activeHandler = null
  handler(tag)
  return true
}

/** Drops any outstanding claim. For a page leaving the screen while a field was waiting. */
export function releaseFieldTagClaim(): void {
  activeHandler = null
}
