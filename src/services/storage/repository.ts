/**
 * Repository<T> — generic sync-aware CRUD layer over a Dexie table.
 *
 * Components call create / update / softDelete / findAll.
 * They never touch UUIDs, version counters, or the outbox directly.
 *
 * Every mutation:
 *  1. Sets the sync bookkeeping fields (version, updatedAt, synced=false).
 *  2. Writes an OutboxEntry so the future sync engine can push the change.
 *
 * // SYNC ENGINE HOOK — see enqueueOutbox() below.
 */

import { type Table } from 'dexie'
import { v4 as uuidv4 } from 'uuid'
import { db } from './db'
import type { SyncableRecord, OutboxEntry } from '@/types/sync'

// ---------------------------------------------------------------------------
// Internal: write to outbox
// ---------------------------------------------------------------------------

async function enqueueOutbox(
  entityType: string,
  entityId: string,
  operation: OutboxEntry['operation'],
  payload: Record<string, unknown>
): Promise<void> {
  const entry: OutboxEntry = {
    id: uuidv4(),
    entityType,
    entityId,
    operation,
    payload,
    createdAt: Date.now(),
    synced: false,
  }
  await db.outbox.add(entry)

  // SYNC ENGINE HOOK ↓
  // When the push engine is ready, trigger a push attempt here:
  //   import { schedulePush } from '@/services/sync/push'
  //   if (navigator.onLine) schedulePush()
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class Repository<T extends SyncableRecord> {
  constructor(
    private readonly table: Table<T>,
    private readonly entityType: string
  ) {}

  /**
   * Create a new record.
   * Caller provides domain fields only; all sync fields are injected here.
   */
  async create(
    data: Omit<T, 'id' | 'createdAt' | 'updatedAt' | 'version' | 'deleted' | 'synced'>
  ): Promise<T> {
    const now = Date.now()
    const record = {
      ...data,
      id: uuidv4(),
      createdAt: now,
      updatedAt: now,
      version: 1,
      deleted: false,
      synced: false,
    } as unknown as T

    await this.table.add(record)
    await enqueueOutbox(this.entityType, record.id, 'create', record as Record<string, unknown>)
    return record
  }

  /**
   * Update an existing record.
   * id and createdAt are immutable; version is auto-incremented.
   */
  async update(
    id: string,
    updates: Partial<Omit<T, 'id' | 'createdAt' | 'version' | 'synced'>>
  ): Promise<T> {
    const existing = await this.table.get(id)
    if (!existing) throw new Error(`[${this.entityType}] record not found: ${id}`)

    const updated = {
      ...existing,
      ...updates,
      id,                              // immutable
      createdAt: existing.createdAt,   // immutable
      updatedAt: Date.now(),
      version: existing.version + 1,
      synced: false,
    }

    await this.table.put(updated)
    await enqueueOutbox(this.entityType, id, 'update', updated as Record<string, unknown>)
    return updated
  }

  /**
   * Soft-delete: sets deleted=true and bumps version.
   * The record stays in IndexedDB so the outbox can sync the deletion.
   * findAll() and findById() will never return deleted records.
   *
   * // SYNC ENGINE HOOK: the server interprets incoming records with
   * //   deleted=true as DELETE instructions for that entity.
   */
  async softDelete(id: string): Promise<void> {
    await this.update(id, { deleted: true } as Partial<T>)
  }

  /** All non-deleted records, optionally filtered in-memory. */
  async findAll(predicate?: (item: T) => boolean): Promise<T[]> {
    const all = await this.table.toArray()
    const alive = all.filter(r => !r.deleted)
    return predicate ? alive.filter(predicate) : alive
  }

  /** Single record by UUID. Returns undefined if not found OR deleted. */
  async findById(id: string): Promise<T | undefined> {
    const record = await this.table.get(id)
    return record && !record.deleted ? record : undefined
  }

  /**
   * Index-backed equality query for one field.
   * The field must be in the Dexie store index.
   */
  async findWhere(field: keyof T & string, value: unknown): Promise<T[]> {
    const results = await this.table
      .where(field)
      .equals(value as string)
      .toArray()
    return results.filter(r => !r.deleted)
  }

  // -------------------------------------------------------------------------
  // SYNC ENGINE HOOK — future methods for the pull engine
  // -------------------------------------------------------------------------

  /**
   * Apply a record received from the server.
   * The pull engine calls this; it bypasses the outbox (already synced).
   *
   * // SYNC ENGINE HOOK — src/services/sync/pull.ts
   *   For each record in the server response, call applyServerRecord().
   *   Conflict strategy (last-write-wins by version, or custom) lives here.
   */
  // async applyServerRecord(serverRecord: T): Promise<void> {
  //   const local = await this.table.get(serverRecord.id)
  //   if (!local || serverRecord.version >= local.version) {
  //     await this.table.put({ ...serverRecord, synced: true })
  //   }
  //   // else: local wins — add to outbox so our version is pushed again
  // }

  /**
   * Mark all records for this entity type as synced=true after a successful push.
   * Called by the push engine after the server ACKs a batch.
   *
   * // SYNC ENGINE HOOK — src/services/sync/push.ts
   */
  // async markSynced(ids: string[]): Promise<void> {
  //   await Promise.all(ids.map(id => this.table.update(id, { synced: true } as Partial<T>)))
  // }
}
