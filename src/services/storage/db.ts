import Dexie, { type Table } from 'dexie'
import type { AssetClass, AssetEntry, AppSettings, Location, PlantSystem, MainFunction, SubFunction, LogSheetTemplate, LogSheet, LogSheetUserArchive, OperationalUnit, NfcFaultReport, LocalAttachment } from '@/types'
import type { FieldDefinition, SyncMeta } from '@/types/sync'
import type { LogSheetEntryData } from '@/types'
import { hasEntryFormData } from '@/utils/entryTimestamps'

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
  syncMeta!: Table<SyncMeta>
  logSheetUserArchives!: Table<LogSheetUserArchive>
  nfcFaultReports!: Table<NfcFaultReport>
  attachments!: Table<LocalAttachment>

  constructor() {
    super(DB_NAME)

    /**
     * Schema version 1 — **the operational baseline. Closed.**
     *
     * <h2>Do not edit this block</h2>
     *
     * This version is on tablets in the field. IndexedDB cannot open a database at a version
     * below the one that created it, and Dexie compares the declared stores against what is on
     * disk — so changing a line here does not migrate those devices, it makes the database
     * unopenable on them. `openDatabase()` then refuses to start rather than delete (correctly),
     * and every tablet holding unsynced readings is stranded until a build is shipped that can
     * open it again.
     *
     * <h2>How to change the schema from now on</h2>
     *
     * Add a new block below, repeating **every** store verbatim — Dexie requires the full list,
     * and a store omitted from a later version is dropped from the database:
     *
     * <pre>
     * this.version(2).stores({
     *   ...every store from version 1, unchanged...,
     *   newStore: 'id, someIndex'
     * })
     * </pre>
     *
     * A version that only **adds** stores or indexes needs no `.upgrade()` callback. One that
     * **reshapes** existing rows does, and it runs on a device holding real work — write it so
     * that failing halfway leaves the rows readable.
     *
     * Adding a plain, non-indexed property to a stored object needs no version at all: Dexie
     * stores whole objects and only the declared indexes are part of the schema.
     *
     * Then bump the expected version in `dbSchema.test.ts`, which exists so that a schema change
     * is something somebody decided rather than something that happened.
     *
     * <h2>Index choices</h2>
     *
     * `id` is the primary key everywhere except `settings` and `syncMeta`, which are keyed by
     * `key`. The rest are the columns something selects on every sync tick — `syncStatus` for the
     * two upload queues, `serverId`/`localId` for the lookups the merge does per bundle, the NFC
     * columns for a scan that has to resolve while a tag is held against the device. Nothing
     * indexes a Blob (IndexedDB cannot) and nothing indexes a field only ever read through its
     * own row.
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
      syncMeta: 'key',
      operationalUnits: 'id, code, parentId',
      logSheetUserArchives: 'id, serverId, userId',
      nfcFaultReports: 'id, logSheetServerId, assetId, syncStatus, createdAt',
      attachments: 'id, logSheetLocalId, logSheetServerId, assetId, fieldKey, syncStatus, createdAt'
    })

    /**
     * Schema version 2 — **no schema change. One bounded data migration.**
     *
     * <h2>What it does, and why it has to happen once rather than forever</h2>
     *
     * The sync merge decides whether the device or the server owns an entry. It used to answer
     * that by looking at the data — "does this entry hold a value?" — and that question cannot
     * distinguish a reading the operator typed from one the server sent, because after any sync
     * the device holds the server's own values. Every filled entry therefore counted as local
     * work forever after, and a supervisor correcting a reading on the web reached a device that
     * had already decided it knew better: the correction never arrived, and the device's next
     * submit sent the stale value back over it.
     *
     * `locallyEditedAt` answers it properly — it is written by `applyOperatorEntrySave` and by
     * nothing that receives from the server — and the merge now reads only that. Which leaves
     * entries written by builds that predate the marker: they hold real work and carry no proof
     * of it, so under the new rule the server would win them and an operator's unsent reading
     * would be replaced on the next sync.
     *
     * This stamps those entries once, at upgrade, so they keep the old behaviour for exactly as
     * long as they exist — until each sheet is submitted and the markers are cleared. After that
     * every marker on the device was written by a real save.
     *
     * <p><b>Why not leave `|| hasEntryFormData(...)` in the merge instead.</b> It is the smaller
     * diff and the worse answer: an OR arm that exists only for old rows still runs on every
     * merge, on every device, forever — and it carries the failure above with it, permanently,
     * to protect rows that stop existing after the first submit.
     *
     * <h2>Scope, deliberately narrow</h2>
     *
     * Only entries that <b>hold data</b>, in sheets that are <b>not already delivered</b>
     * (`submitted` + `synced`). A delivered sheet holds what the server sent back, so marking it
     * would assert local ownership that does not exist — and would hand the device every future
     * merge for those entries, which is the log sheet 85 failure by another route. Entries that
     * already carry a marker are left alone rather than re-stamped: the original timestamp is
     * the honest one.
     *
     * <p>Writes are per sheet and idempotent — a sheet with nothing to stamp is not rewritten —
     * so an upgrade interrupted halfway leaves every row readable and can simply run again.
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
      syncMeta: 'key',
      operationalUnits: 'id, code, parentId',
      logSheetUserArchives: 'id, serverId, userId',
      nfcFaultReports: 'id, logSheetServerId, assetId, syncStatus, createdAt',
      attachments: 'id, logSheetLocalId, logSheetServerId, assetId, fieldKey, syncStatus, createdAt'
    }).upgrade(tx => tx.table('logSheets').toCollection().modify(markPreMarkerEntriesAsLocal))
  }
}

/**
 * Stamps `locallyEditedAt` on entries that hold work but predate the marker.
 *
 * <p>Exported for the migration test, which runs it against rows rather than against a Dexie
 * upgrade — the behaviour worth pinning is which entries get a marker, not that Dexie calls it.
 *
 * <p>Mutates in place: Dexie's `modify` writes back the object it hands you.
 */
export function markPreMarkerEntriesAsLocal(
  sheet: { status?: string; syncStatus?: string; entries?: LogSheetEntryData[] },
  stampedAt: number = Date.now()
): void {
  if (sheet.status === 'submitted' && sheet.syncStatus === 'synced') return
  const entries = sheet.entries
  if (!Array.isArray(entries)) return

  for (const entry of entries) {
    if (entry.locallyEditedAt != null) continue
    if (!hasEntryFormData(entry.formData)) continue
    entry.locallyEditedAt = stampedAt
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
 * "only on a dev device" — which stops being true the moment a second schema version ships:
 * from then on, **any rollback to an earlier build would wipe every tablet that had run the
 * newer one**, including completed rounds and captured photos that had not reached the server
 * yet. The schema is back to a single version today, so that particular rollback is not live —
 * but the branch is reachable for other reasons (a concurrent version-change transaction, a
 * different Dexie major), and deleting unsynced work is the wrong answer whatever caused it. That data exists in exactly one place. With `autoUpdate` + `skipWaiting` on the
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
