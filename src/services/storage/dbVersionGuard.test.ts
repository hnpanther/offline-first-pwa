import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'

import { db, openDatabase, DatabaseVersionMismatchError } from './db'

const DB_NAME = 'offline-pwa-db'

/**
 * `openDatabase` must never destroy work that has not reached the server.
 *
 * <h2>What the recreate path is, and what it is not</h2>
 *
 * IndexedDB cannot open a database at a lower version than the one that created it, so the
 * theory is: ship version 2, roll back to version 1, get a `VersionError`, and the old code
 * would delete and recreate — taking completed rounds, captured photos and fault reports with
 * it, none of which exist anywhere else until they sync.
 *
 * **Measured, that rollback does not actually reach the branch under Dexie 4.** Opening a
 * database created at a higher version succeeds: Dexie reports its own declared `verno` and the
 * existing rows are readable. So the plain rollback scenario is not the live hazard it looks
 * like, and this is written down because the opposite assumption is the natural one and would
 * send the next reader chasing it.
 *
 * The branch is still reachable — a genuine `VersionError` can come from a concurrent
 * version-change transaction, a different Dexie major, or a browser that behaves unlike
 * fake-indexeddb — and if it is reached, deleting unsynced work is the wrong answer whatever
 * caused it. So the guard stays, and these tests drive the error path directly rather than
 * pretending a rollback produces it.
 */
describe('openDatabase version guard', () => {
  beforeEach(async () => {
    if (db.isOpen()) db.close()
    await Dexie.delete(DB_NAME)
    vi.restoreAllMocks()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    if (db.isOpen()) db.close()
    await Dexie.delete(DB_NAME)
  })

  /** Makes the next `db.open()` fail the way IndexedDB signals "the stored data is newer". */
  function failNextOpenWithVersionError() {
    const versionError = new Error('the requested version is less than the existing version')
    versionError.name = 'VersionError'
    return vi.spyOn(db, 'open').mockRejectedValueOnce(versionError as never)
  }

  it('opens normally when nothing is wrong', async () => {
    await expect(openDatabase()).resolves.toBeUndefined()
    expect(db.isOpen()).toBe(true)
  })

  it('refuses — and deletes nothing — when an unsynced log sheet is present', async () => {
    await db.open()
    // The primary key of `logSheets` is `id`, not `localId` — a fixture missing it fails with
    // an opaque DataError from IndexedDB rather than anything that names the cause.
    await db.logSheets.add({
      id: 'ls-1',
      localId: 'local-1',
      status: 'IN_PROGRESS',
      syncStatus: 'PENDING'
    } as never)
    db.close()

    failNextOpenWithVersionError()
    await expect(openDatabase()).rejects.toBeInstanceOf(DatabaseVersionMismatchError)

    // The decisive assertion. "It threw" alone would also be satisfied by code that threw
    // *after* wiping, which is the exact failure this guard exists to prevent.
    await db.open()
    await expect(db.logSheets.count()).resolves.toBe(1)
  })

  it('refuses when an unsynced attachment is the only thing at stake', async () => {
    await db.open()
    await db.attachments.add({
      id: 'att-1',
      logSheetLocalId: 'local-1',
      assetId: 1,
      fieldKey: 'photo',
      syncStatus: 'PENDING',
      createdAt: 1
    } as never)
    db.close()

    failNextOpenWithVersionError()

    await expect(openDatabase()).rejects.toBeInstanceOf(DatabaseVersionMismatchError)
    await db.open()
    await expect(db.attachments.count()).resolves.toBe(1)
  })

  it('refuses when an unsynced fault report is the only thing at stake', async () => {
    await db.open()
    await db.nfcFaultReports.add({
      id: 'fr-1',
      logSheetServerId: 1,
      assetId: 1,
      syncStatus: 'PENDING',
      createdAt: 1
    } as never)
    db.close()

    failNextOpenWithVersionError()

    await expect(openDatabase()).rejects.toBeInstanceOf(DatabaseVersionMismatchError)
  })

  it('reports how much is at stake, for the failure screen', async () => {
    await db.open()
    await db.logSheets.add({ id: 'ls-1', localId: 'l-1', status: 'IN_PROGRESS', syncStatus: 'PENDING' } as never)
    await db.outbox.add({ id: 'o-1', entityType: 'logSheet', synced: 0, createdAt: 1 } as never)
    db.close()

    failNextOpenWithVersionError()

    const error = await openDatabase().catch(e => e as DatabaseVersionMismatchError)
    expect(error).toBeInstanceOf(DatabaseVersionMismatchError)
    // The operator sees this number and must not read "0" as "nothing to lose".
    expect(error.unsyncedCount).toBeGreaterThanOrEqual(2)
  })

  it('recreates the database when only disposable reference data would be lost', async () => {
    // Asset classes and locations come back on the next sync, so recreating is right here and
    // the app must still start — refusing on this would strand a tablet for no reason.
    await db.open()
    await db.assetClasses.add({ id: 1, name: 'Pump' } as never)
    db.close()

    failNextOpenWithVersionError()

    await expect(openDatabase()).resolves.toBeUndefined()
    expect(db.isOpen()).toBe(true)
    await expect(db.assetClasses.count()).resolves.toBe(0)
  })

  it('rethrows an unrelated open failure untouched', async () => {
    // Only VersionError may lead anywhere near a delete. Anything else must surface as itself,
    // so a transient fault is never mistaken for a reason to recreate the database.
    const other = new Error('quota exceeded')
    other.name = 'QuotaExceededError'
    vi.spyOn(db, 'open').mockRejectedValueOnce(other as never)

    await expect(openDatabase()).rejects.toThrow('quota exceeded')
  })

  it('carries a Persian message telling the operator not to reinstall', async () => {
    await db.open()
    await db.logSheets.add({ id: 'ls-1', localId: 'l-1', status: 'IN_PROGRESS', syncStatus: 'PENDING' } as never)
    db.close()

    failNextOpenWithVersionError()

    const error = await openDatabase().catch(e => e as DatabaseVersionMismatchError)
    expect(error.name).toBe('DatabaseVersionMismatchError')
    expect(error.message).toContain('جدیدتر')
  })
})
