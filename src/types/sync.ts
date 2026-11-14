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
  // Backend roadmap §32: a drawing that vouches for the other answers of its form. Stored as an
  // IMAGE attachment; the signer and the hash are stamped by the server (utils/signatureValue.ts).
  | 'signature'

export interface FieldValidationRange {
  min?: number
  max?: number
}

/** The operators a state gate may compare with. Mirrors the server's `FieldGateOperators`. */
export type FieldGateOperator =
  | 'in'
  | 'notIn'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'answered'
  | 'notAnswered'

/**
 * Which state of the asset a condition is about — read from ANOTHER answer on the same entry.
 *
 * `field` is matched case-insensitively (the server's key uniqueness is already case-folded);
 * the compared `values` are trimmed and case-SENSITIVE, like every other option comparison here.
 */
export interface FieldStateGate {
  field?: string
  op?: FieldGateOperator | string
  values?: string[]
  value?: number | string
}

/**
 * One state of the asset, and the thresholds that apply in it.
 *
 * A condition with no thresholds of its own gates the field's OWN bands — which is what the
 * panel's single-gate editor writes, and the common case by far. One that declares any of the
 * four states them completely: a key it omits is absent in this state, not inherited.
 */
export interface FieldStateCondition {
  when?: FieldStateGate
  warning?: FieldValidationRange
  danger?: FieldValidationRange
  warningOptions?: string[]
  dangerOptions?: string[]
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
  /**
   * WHEN the thresholds above apply — a state condition.
   *
   * «The current must be above the no-load threshold» is true of a running pump and meaningless
   * for a stopped one, and no band can say that: a danger minimum of zero does nothing at all
   * (the interval is closed, so `0 < 0` is false) and a real threshold fires on every standby
   * machine. The state lives in a DIFFERENT answer on the same entry, which is why this is a
   * cross-field rule and not another bound. ISA-18.2 calls the result «suppressed by design».
   *
   * Evaluation order — see `utils/fieldValidation.ts`, which must stay identical to the
   * server's `FieldValidationSupport`:
   *   1. absent or unreadable → judged exactly as before this key existed;
   *   2. the first condition whose `when` holds decides;
   *   3. none holds → `ok`, suppressed. The value is still stored, still synced, still
   *      reported — only the judgement is withheld, so the operator never has to leave a box
   *      empty to avoid a false alert.
   *
   * Additive, like `warningOptions`: a build of this app that ignores it stores the same data,
   * because the server recomputes `max_severity` from its own copy on every write. What it gets
   * wrong is only the live colouring — it would paint a stopped pump red while the server
   * records OK — which is why the device half ships with the panel half rather than after it.
   */
  conditions?: FieldStateCondition[]
  /**
   * How this `text` / `number` field may be filled from a label instead of typed.
   *
   * **Not the round's `scanMode`.** That one says how the operator reaches an *asset*; this says
   * how one *question* may be answered on an asset they already have open. A round whose
   * `scanMode` is `NONE` can still carry a field that wants a barcode, and a scan here must
   * never run through `matchLogSheetEntryByTag` (it answers "which asset is this?" and would
   * reject every correct nameplate read) nor change `filledVia`, which records how the entry
   * was reached.
   *
   * Absent means the field is typed, which is every field that existed before this did.
   * `manual` is **true unless explicitly false** — the safe direction, because a blob this
   * build cannot read must still leave the operator a way to fill the form.
   *
   * Threaded through `FieldValidationSupport.build(...)` on the server, so unlike
   * `allowNegative` below it survives an edit of the field.
   */
  scan?: {
    sources?: Array<'NFC' | 'QR' | 'BARCODE'>
    manual?: boolean
  }
  /**
   * A `select` / `multiselect` that accepts an answer which is NOT one of its `options`
   * (backend roadmap §31, phase 1). Stored only when true; only a literal `true` opens it, so a
   * blob this build cannot read stays the narrower list.
   *
   * The typed answer is stored exactly where a chosen option would be — a string, or an element
   * of the array — so nothing in sync, merge or revisions changes shape. «Was it typed?» is
   * answered at read time by «is it in the options». It is never a warning or a danger, and the
   * server is the boundary: it accepts one only for a field whose frozen definition says so.
   *
   * Searching a long list is NOT this flag: it is automatic above a threshold
   * (`components/forms/choiceControl.ts`) because it changes nothing the server accepts.
   *
   * Threaded through `FieldValidationSupport.build(...)` on the server, so it survives an edit of
   * the field.
   */
  allowCustom?: boolean
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
  /**
   * This machine's own state condition — allowed in BOTH modes, like the option severities and
   * for the same reason: it says *when* a threshold is judged, which is part of the threshold.
   *
   * `null` means «this machine has no condition», which drops the class's gate rather than
   * inheriting it. Replaced whole, never merged: a condition list is an ordered first-match
   * statement and merging two would produce an order nobody wrote.
   */
  conditions?: FieldStateCondition[] | null
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
