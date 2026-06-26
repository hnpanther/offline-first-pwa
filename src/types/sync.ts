/**
 * Sync-ready base for every entity in the system.
 *
 * Rules:
 *  - id       : client-generated UUID. Immutable after creation.
 *  - version  : incremented on every local mutation. Sent to server so it can
 *               detect conflicts ("you're modifying v2, but we already have v4").
 *  - deleted  : soft-delete tombstone. Records are NEVER physically removed.
 *               The sync engine propagates deleted=true to the server so other
 *               clients learn about the deletion.
 *  - synced   : false means "at least one outbox entry for this record is still
 *               pending". The sync engine sets it back to true after ACK.
 *
 * // SYNC ENGINE HOOK — src/services/sync/push.ts
 *   Reads outbox entries where synced=false, sends them, marks synced=true.
 * // SYNC ENGINE HOOK — src/services/sync/pull.ts
 *   Receives server changes and calls Repository.applyServerRecord().
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

export interface FieldValidation {
  min?: number
  max?: number
  minLength?: number
  maxLength?: number
  /** Regex string — converted to RegExp at runtime for react-hook-form */
  pattern?: string
  options?: Array<{ value: string; label: string }>
}

/**
 * A single parameter slot in an AssetClass.
 * Replaces the embedded FormField[] that used to live inside AssetClass.
 *
 * Each FieldDefinition is independently sync-ready: adding, removing, or
 * reordering a single field produces exactly one outbox entry, not a full
 * class re-upload.
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

/**
 * Every local mutation (create / update / soft-delete) is recorded here.
 * The sync engine reads this table in order and pushes entries to the server.
 * No entry is ever deleted from the outbox — only marked synced=true.
 *
 * // SYNC ENGINE HOOK — src/services/sync/push.ts will:
 *   1. Query outbox where synced=false, ordered by createdAt.
 *   2. POST each entry to /api/sync/push.
 *   3. On ACK, set synced=true and update the entity's synced=true flag.
 */
export interface OutboxEntry {
  id: string
  entityType: string      // e.g. 'asset_class' | 'field_definition' | 'log_sheet'
  entityId: string
  operation: 'create' | 'update' | 'delete'
  payload: Record<string, unknown>
  createdAt: number
  synced: boolean
}

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
