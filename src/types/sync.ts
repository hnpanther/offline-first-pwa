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

/**
 * Every type a class field can have, exactly as the server sends it.
 *
 * <p>Kept in step with the server's `FieldDataTypes`, which is the single list the admin UI's
 * dropdowns are built from. This union used to stop at `textarea` while real bundles carried
 * `image`, `audio`, `video` and `location` — so the types said a media field was impossible
 * while the app was rendering one. Harmless only because every media branch tests the value
 * through a helper that takes a `string`; a `case 'image'` written against this union would have
 * been rejected as unreachable, and a "dead branch" cleanup would have deleted working code.
 *
 * <p>The server had the same split and it was not harmless there: the field editor's two
 * dropdowns carried separate hardcoded lists, the edit one missing these four, so reopening a
 * photo field silently retyped it to `number`.
 */
export type FieldDataType =
  | 'number'
  | 'text'
  | 'select'
  | 'multiselect'
  | 'checkbox'
  | 'textarea'
  | 'image'
  | 'audio'
  | 'video'
  | 'location'

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
  /**
   * Which of `options` are a warning / a danger when chosen.
   *
   * The polarity is the opposite of `warning`/`danger` above: a range is something a reading
   * must stay inside, these are the choices that ARE the alert. Plain strings compared against
   * the option values, trimmed and case-SENSITIVELY, exactly as the server's submit-time
   * allow-list does.
   *
   * Additive on purpose: a build of this app that ignores them stores the same data, because
   * the server recomputes `max_severity` from its own copy on every write. It simply paints
   * nothing — which is how the per-asset override itself shipped. They ARE threaded through
   * `FieldValidationSupport.build(...)` on the server, so unlike `allowNegative` below they
   * survive a field edit.
   */
  warningOptions?: string[]
  dangerOptions?: string[]
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

/**
 * One asset's frozen override, as `log_sheets.field_overrides_snapshot` carries it.
 *
 * `RANGES_ONLY` may only replace `warning` / `danger`; `FULL` may also add a field, drop one
 * with `removed`, or relabel it. The mode is stored rather than inferred because the two are
 * not distinguishable from the keys alone, and guessing would make a removed field reappear.
 */
export interface AssetFieldOverrideSnapshot {
  source?: 'RANGES_ONLY' | 'FULL'
  fields?: Record<string, AssetFieldOverride>
}

export interface AssetFieldOverride {
  warning?: FieldValidationRange | null
  danger?: FieldValidationRange | null
  /** FULL only: this field does not apply to this asset. */
  removed?: boolean
  label?: string
  unit?: string
  dataType?: string
  /*
   * The three below are FULL-only too, and the web panel's form does not yet post any of them —
   * but the server's override sanitiser allows all three and `AssetFieldResolver` reads all
   * three, so a value reaching the database by any other route (the integration API, a hand
   * edit) WOULD change the form the web renders. A client that ignored them would then show a
   * different form from the one the server validates against, on the same asset. Mirrored here
   * so the two cannot diverge rather than because something writes them today.
   */
  required?: boolean
  sortOrder?: number | string
  options?: Array<{ value: string; label: string }> | null
  /**
   * This asset's own alerting options, replacing the class's list wholesale.
   *
   * Carried under `RANGES_ONLY` as well as `FULL`: which choices mean trouble on a
   * particular machine is a threshold, not structure, so the class keeps owning the
   * vocabulary. An explicit empty array means "this machine has no such list", which is a
   * decision and not the same as inheriting the class's.
   */
  warningOptions?: string[] | null
  dangerOptions?: string[] | null
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

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
