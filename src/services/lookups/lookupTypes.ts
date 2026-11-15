/**
 * The device's copy of a reference list (backend roadmap §31 Phase 2). Two Dexie stores, added in
 * version 4 — see `services/storage/db.ts`.
 */

/** One list the device keeps: where its sync stands and how long it may be kept. */
export interface LookupListMeta {
  /** The list's code lower-cased — the store key. Codes are matched ignoring case everywhere. */
  id: string
  /** The code as the server spells it. */
  code: string
  name: string
  /**
   * The revision of the last COMPLETE pass — read by the server before the first page of that
   * pass, so a change made during it leaves this lower than the data and causes one more fetch,
   * never one fewer.
   */
  revision: number
  /** A full pass has reached the end of the list at least once. Until then it is not usable. */
  complete: boolean
  /** The half-open `(updatedAt, id)` cursor the next page continues from. */
  cursorSince: number
  cursorAfterId: number
  /** Device-clock instant after which the copy must be deleted — renewed by every sync. */
  leaseUntil: number
  /** How long the server granted, so a renewal can be timed at half of it. */
  leaseLengthMs: number
  /** The latest server time seen for this list; a device clock behind it counts as expired. */
  serverTimeSeen: number
  /** The columns the server let leave it (`offline` ones only). */
  columns: Array<{ key: string; label: string; searchable: boolean; display: boolean }>
}

/** One item, as the device stores it. */
export interface LookupItemRow {
  /** The server's item id — unique across every list. */
  id: number
  /** The list's code lower-cased (`LookupListMeta.id`). */
  listId: string
  code: string
  label: string
  active: boolean
  attributes: Record<string, string>
  /** Code, label and searchable attributes, normalised (utils/persianSearch) — for matching only. */
  search: string
  updatedAt: number
}

/** A choice as the field offers it. */
export interface LookupOption {
  code: string
  label: string
  /** The display columns, joined — shown under the label. */
  detail?: string
}
