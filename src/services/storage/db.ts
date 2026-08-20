import Dexie, { type Table } from 'dexie'
import type { AssetClass, AssetEntry, AppSettings, Location, PlantSystem, MainFunction, SubFunction, LogSheetTemplate, LogSheet, LogSheetUserArchive, OperationalUnit, NfcFaultReport, LocalAttachment } from '@/types'
import type { FieldDefinition, OutboxEntry, SyncMeta } from '@/types/sync'

const DB_NAME = 'offline-pwa-db'

class AppDatabase extends Dexie {
  assetClasses!: Table<AssetClass>
  assetEntries!: Table<AssetEntry>
  settings!: Table<AppSettings & { key: string }>
  locations!: Table<Location>
  plantSystems!: Table<PlantSystem>
  mainFunctions!: Table<MainFunction>
  subFunctions!: Table<SubFunction>
  logSheetTemplates!: Table<LogSheetTemplate>
  logSheets!: Table<LogSheet>
  operationalUnits!: Table<OperationalUnit>
  fieldDefinitions!: Table<FieldDefinition>
  outbox!: Table<OutboxEntry>
  syncMeta!: Table<SyncMeta>
  logSheetUserArchives!: Table<LogSheetUserArchive>
  nfcFaultReports!: Table<NfcFaultReport>
  attachments!: Table<LocalAttachment>

  constructor() {
    super(DB_NAME)

    /**
     * The one and only schema version.
     *
     * The app has never shipped, so the eleven historical versions that only ever
     * built up to this shape were collapsed into a single `version(1)` — the same
     * reasoning as folding the backend's Flyway migrations into V1. There is no
     * upgrade path to preserve because there is no production data to upgrade.
     *
     * A device that still holds the pre-collapse database is on IndexedDB version
     * 110 and cannot be opened by a version(1) declaration — IndexedDB refuses to
     * "downgrade". `openDatabase()` below catches exactly that and recreates the
     * database from scratch, which is safe here: every table is either server-owned
     * reference data that the next sync refetches, or local work that a pre-production
     * dev device can afford to lose.
     *
     * When the schema next changes, add `this.version(2).stores({...})` below with the
     * full store list rather than editing this block.
     */
    this.version(1).stores({
      assetClasses: 'id, createdAt',
      assetEntries: 'id, nfcTagId, nfcSerial, classId, subFunctionId',
      locations: 'id, code, parentId',
      plantSystems: 'id, code, locationId',
      mainFunctions: 'id, code, systemId, locationId',
      subFunctions: 'id, code, tag, mainFunctionId, systemId, locationId',
      logSheetTemplates: 'id, scopeType, scopeId',
      logSheets: 'id, localId, serverId, templateId, status, createdAt',
      settings: 'key',
      fieldDefinitions: 'id, classId, order',
      outbox: 'id, entityType, synced, createdAt',
      syncMeta: 'key',
      operationalUnits: 'id, code, parentId',
      logSheetUserArchives: 'id, serverId, userId',
      nfcFaultReports: 'id, logSheetServerId, assetId, syncStatus, createdAt'
    })

    /**
     * v2 — attachments (photos / voice notes).
     *
     * Added as a new version rather than by editing v1, per the rule above: v1 has shipped to
     * dev devices, and rewriting it would make their on-disk version un-openable. This is a
     * pure additive store with no `.upgrade()` callback, which is safe precisely because no
     * existing data is reshaped — every v1 store is repeated verbatim, as Dexie requires.
     *
     * `syncStatus` is indexed because the upload queue selects on it every tick; `blob` is not
     * indexed (IndexedDB cannot index a Blob, and nothing queries by content).
     */
    this.version(2).stores({
      assetClasses: 'id, createdAt',
      assetEntries: 'id, nfcTagId, nfcSerial, classId, subFunctionId',
      locations: 'id, code, parentId',
      plantSystems: 'id, code, locationId',
      mainFunctions: 'id, code, systemId, locationId',
      subFunctions: 'id, code, tag, mainFunctionId, systemId, locationId',
      logSheetTemplates: 'id, scopeType, scopeId',
      logSheets: 'id, localId, serverId, templateId, status, createdAt',
      settings: 'key',
      fieldDefinitions: 'id, classId, order',
      outbox: 'id, entityType, synced, createdAt',
      syncMeta: 'key',
      operationalUnits: 'id, code, parentId',
      logSheetUserArchives: 'id, serverId, userId',
      nfcFaultReports: 'id, logSheetServerId, assetId, syncStatus, createdAt',
      attachments: 'id, logSheetLocalId, logSheetServerId, assetId, fieldKey, syncStatus, createdAt'
    })
  }
}

export const db = new AppDatabase()

/** Raised when the database on the device is newer than this build understands. */
export class DatabaseVersionMismatchError extends Error {
  constructor(readonly unsyncedCount: number) {
    super(
      'نسخه داده‌های ذخیره‌شده روی این دستگاه جدیدتر از نسخه فعلی برنامه است. ' +
        'برای جلوگیری از حذف اطلاعات ارسال‌نشده، برنامه باز نشد. ' +
        'لطفاً نسخه به‌روز برنامه را نصب کنید یا با پشتیبانی تماس بگیرید.'
    )
    this.name = 'DatabaseVersionMismatchError'
  }
}

/**
 * Stores that can hold work existing nowhere else, and how to tell an unsent row from a sent one.
 *
 * Two things this list got wrong the first time, both fixed here:
 *
 *  - **`logSheetUserArchives` was missing.** An archived submission can still be waiting for a
 *    server outcome — `getArchivedSubmissionsPendingServerOutcome` exists precisely to queue
 *    them — and the live row it came from is pruned after seven days by `cleanupLogSheets`. So
 *    the archive can be the only surviving copy of a completed round.
 *  - **The count ignored status**, so a tablet holding 200 perfectly synced sheets reported 200
 *    "unsynced" rows and would have refused to start. Not data loss, but a lockout of exactly
 *    the devices this guard exists to protect.
 *
 * Each predicate is written to answer "**not** provably synced", so an unexpected row shape
 * counts as work rather than as nothing. That is the safe direction: refusing to start is a
 * support call, and deleting a shift's readings is not recoverable.
 */
interface UnsyncedWorkProbe {
  readonly store: string
  readonly isUnsynced: (row: Record<string, unknown>) => boolean
}

const UNSYNCED_WORK_STORES: readonly UnsyncedWorkProbe[] = [
  { store: 'logSheets', isUnsynced: row => row?.syncStatus !== 'synced' },
  {
    store: 'logSheetUserArchives',
    // The sheet is nested inside the archive row.
    isUnsynced: row => (row?.sheet as { syncStatus?: string } | undefined)?.syncStatus !== 'synced'
  },
  // The outbox marks sent entries with synced = true and never deletes them.
  { store: 'outbox', isUnsynced: row => row?.synced !== true },
  { store: 'nfcFaultReports', isUnsynced: row => row?.syncStatus !== 'synced' },
  { store: 'attachments', isUnsynced: row => row?.syncStatus !== 'synced' }
]

/**
 * Counts rows that recreating the database would destroy for good.
 *
 * **Read through a separate, schema-less Dexie handle, not through `db`.** That is the whole
 * trick: we are here because `db.open()` failed, so every table on `db` would auto-open and
 * fail again — and a first attempt at this counted through `db`, hit the catch on all four
 * stores, and reported "4 unsynced rows" for a database that was in fact empty. It would have
 * refused to start every tablet it was supposed to protect. A unit test caught it; nothing in
 * normal use would have, because the refusal looks identical either way.
 *
 * `new Dexie(name)` with no declared version opens whatever is actually on disk and exposes its
 * real stores, which is exactly what is needed to inspect a database this build cannot address
 * at its own version.
 *
 * Tolerant in one direction only: if the contents cannot be established at all, the answer is
 * "assume there is work". Refusing to start is a support call; guessing "empty" wrongly is a
 * shift's readings gone.
 */
async function countUnsyncedWork(): Promise<number> {
  const probe = new Dexie(DB_NAME)
  try {
    await probe.open()
    const present = new Set(probe.tables.map(table => table.name))
    let total = 0
    for (const { store, isUnsynced } of UNSYNCED_WORK_STORES) {
      if (!present.has(store)) continue
      try {
        // `filter(...).count()` streams rows rather than materialising them, and this runs once,
        // on a startup path that has already failed. An index-per-store fast path was considered
        // and rejected: `logSheets` and `logSheetUserArchives` have no index on their status
        // (the latter's is nested inside `sheet`), so it would have to fall back for exactly the
        // two stores that matter most — complexity that buys nothing on a path taken once.
        total += await probe
          .table(store)
          .filter(row => isUnsynced(row as Record<string, unknown>))
          .count()
      } catch {
        // Unreadable store: assume it holds work rather than assume it is empty.
        total += 1
      }
    }
    return total
  } catch {
    // Cannot even look. Assume the worst rather than delete on a guess.
    return 1
  } finally {
    probe.close()
  }
}

/**
 * Opens the database. **Never deletes data that has not been synced.**
 *
 * IndexedDB cannot open a database at a lower version than the one that created it, so a build
 * older than the data on the device gets a `VersionError` and has only two ways forward: delete
 * and recreate, or refuse to start.
 *
 * This used to delete, unconditionally. The comment justifying it said the case was reachable
 * "only on a dev device" — and that stopped being true the moment the schema moved to
 * `version(2)`: from then on, **any rollback to an earlier build wipes every tablet that had
 * run the newer one**, including completed rounds and captured photos that had not reached the
 * server yet. That data exists in exactly one place. With `autoUpdate` + `skipWaiting` on the
 * service worker, a bad deploy reaches the whole fleet in minutes and a rollback would then
 * destroy the very work the rollback was meant to protect.
 *
 * So the rule is now: delete only what is provably disposable.
 *
 *  - **Nothing unsynced** — recreate, as before. Everything lost is reference data the next
 *    sync refetches.
 *  - **Unsynced work present** — refuse, and say so. A tablet that will not start is a support
 *    call; a tablet that started by discarding a shift's readings is a plant with no record of
 *    an inspection, discovered weeks later.
 *
 * Any other failure is rethrown untouched, exactly as before.
 */
export async function openDatabase(): Promise<void> {
  try {
    await db.open()
  } catch (err) {
    if ((err as Error)?.name !== 'VersionError') throw err

    const unsynced = await countUnsyncedWork()
    if (unsynced > 0) {
      db.close()
      throw new DatabaseVersionMismatchError(unsynced)
    }

    db.close()
    await Dexie.delete(DB_NAME)
    await db.open()
  }
}

export const DEFAULT_SETTINGS: AppSettings = {
  serverUrl: import.meta.env.VITE_SERVER_URL ?? 'http://localhost:8081',
  syncIntervalMs: 30_000,
  // Both of the next two are server-owned: bootstrap overwrites them on every reconnect and
  // nothing on the device may edit them. These values are what the app runs on until the first
  // bootstrap of a fresh install lands, so each one deliberately matches the server's own
  // default — a device must never start out on a *weaker* rule than the plant's.
  nfcStrictSerialMatch: true,
  imageAnnotationEnabled: true,
  // Deliberately the strict side, unlike the server's seeded value. A device that has never
  // reached the server has no authorisation to hand out: refusing manual entry until the policy
  // arrives costs a scan, while assuming it is allowed hands out a capability nobody granted.
  nfcManualEntryEnabled: false,
  // Follow the device unless someone deliberately pins it. Auto is the only default that is
  // right everywhere: a locked orientation on a device mounted the other way round is worse
  // than no preference at all.
  screenOrientation: 'auto',
  // Mirrors the server's own defaults. Used until the first bootstrap lands, and after that
  // only as the fallback for a server too old to send them.
  attachmentLimits: {
    maxImagesPerField: 3,
    maxAudiosPerField: 1,
    maxVideosPerField: 1,
    maxAudioSeconds: 120,
    maxVideoSeconds: 120
  }
}
