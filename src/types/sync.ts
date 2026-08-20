/**
 * The shape every synced-down reference record carries.
 *
 * <p><b>These fields are the server's, not the device's.</b> They arrive filled in and are read,
 * never written locally — the only record type still using this base is `FieldDefinition`, which
 * reaches the device inside a log-sheet bundle and is never edited here.
 *
 * <p>They are kept because the server sends them and the device reads two of them:
 *
 *  - `id`       — the row's identity, and the tie-breaker in `dedupeByKey` (a numeric server id
 *                 beats a UUID left over from an older build).
 *  - `deleted`  — a soft-delete tombstone. `getFieldsForClass` filters on it, so a field the
 *                 server retired stops appearing on forms without the row having to vanish.
 *  - `version`, `synced`, `createdAt`, `updatedAt` — carried through, not acted on.
 *
 * <p>They used to mean more: a generic `Repository` stamped them on local mutations and queued
 * an outbox row for a push engine (`POST /api/sync/push`) that was never built and whose endpoint
 * does not exist server-side. That machinery has been removed; sync is the log-sheet batch and
 * the bundles, and nothing else.
 */
export interface SyncableRecord {
  id: string
  createdAt: number
  updatedAt: number
  version: number
  deleted: boolean
  synced: boolean
}

// ---------------------------------------------------------------------------
// Field definitions
// ---------------------------------------------------------------------------

export type FieldDataType =
  | 'number'
  | 'text'
  | 'select'
  | 'multiselect'
  | 'checkbox'
  | 'textarea'

export interface FieldValidationRange {
  min?: number
  max?: number
}

export interface FieldValidation {
  /** @deprecated legacy — treated as warning range by backend */
  min?: number
  /** @deprecated legacy — treated as warning range by backend */
  max?: number
  warning?: FieldValidationRange
  danger?: FieldValidationRange
  minLength?: number
  maxLength?: number
  /** Regex string — converted to RegExp at runtime for react-hook-form */
  pattern?: string
  options?: Array<{ value: string; label: string }>
  /*
   * `allowNegative` used to live here. It is gone, and not just unused: the backend never had the
   * concept, the web panel could not set it, and `FieldValidationSupport.build(...)` rebuilds this
   * object from scratch on every field save with only `options`, `warning` and `danger` — so a key
   * added by hand to the database vanished at the next edit. Every number field is signed now; the
   * ranges below decide severity, never what may be typed. See utils/fieldValidation.ts.
   */
}

/**
 * A single parameter slot on an asset class — one column of the form an operator fills.
 *
 * <p>Server-owned. Each sheet carries its own frozen snapshot of the fields it was generated
 * with, so two sheets of the same class can legitimately disagree; the shared table here is the
 * fallback for sheets saved before that snapshot existed.
 */
export interface FieldDefinition extends SyncableRecord {
  classId: string
  key: string           // machine key  — e.g. "temperature"
  label: string         // display label — e.g. "دمای خروجی"
  dataType: FieldDataType
  unit?: string
  required: boolean
  validation?: FieldValidation
  order: number         // display order within the class (0-based)
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

/**
 * Dynamic field values for one asset instance in a log sheet entry.
 * Keys correspond to FieldDefinition.key values for the asset's class.
 * e.g. { temperature: 85.5, pressure: 1.2, status: "normal" }
 */
export type AttributeMap = Record<string, unknown>

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Sync metadata
// ---------------------------------------------------------------------------

/**
 * Key-value store for sync engine state.
 * Primary entry: key='lastSeq', value=<last sequence received from server>.
 *
 * // SYNC ENGINE HOOK — src/services/sync/pull.ts will:
 *   1. Read lastSeq from this table.
 *   2. GET /api/sync/changes?since=<lastSeq>.
 *   3. Apply changes locally, then update lastSeq.
 */
export interface SyncMeta {
  key: string
  value: unknown
}
