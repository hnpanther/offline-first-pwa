import type { LookupAvailability } from '@/services/lookups/lookupStore'

/**
 * A lookup field before its lease has been read.
 *
 * Painting the «list is absent» line in that gap, then removing it when the list is actually
 * ready, shortens the field. On the form page — which scrolls the window — that collapse at the
 * bottom is a scroll jump. The hint waits until the read has answered.
 */
export type LookupFieldMode = LookupAvailability | 'pending'

/** Whether the long «type a code, the list is not on this device» line should show. */
export function showLookupAvailabilityHint(mode: LookupFieldMode): boolean {
  return mode === 'absent' || mode === 'syncing' || mode === 'expired'
}

/**
 * Popper positioning for a combobox on a page that scrolls the window.
 *
 * The default `absolute` strategy is in the document. Opened on the last field, the list hangs
 * past the end of the page, the document grows, and when the list flips above the field the
 * document shrinks again — the window jumps. `fixed` is positioned against the viewport and does
 * not change scroll height. The same anchor is used inside the log-sheet dialog.
 */
export const COMBOBOX_POPPER_STRATEGY = 'fixed' as const
