/**
 * Merges per-log-sheet server bundles into IndexedDB.
 * Server is authoritative for reference data — bulkPut overwrites by id so
 * updated NFC tags / asset metadata apply on every inbox bundle.
 */

import { db } from '@/services/storage/db'
import type {
  LogSheetBundleDto,
  LogSheetContextDto,
  ServerLogSheetEntry
} from '@/services/api'
import type {
  AssetClass,
  AssetEntry,
  Location,
  MainFunction,
  PlantSystem,
  SubFunction
} from '@/types'
import type { FieldDefinition } from '@/types/sync'
import { toIdString } from '@/utils/ids'
import { normalizeFieldOptions } from '@/utils/fieldOptions'
import type { LogSheetEntryData } from '@/types'

async function bulkPutIfAny<T extends { id: string }>(
  table: { bulkPut: (items: T[]) => Promise<unknown> },
  items: T[]
): Promise<void> {
  if (items.length === 0) return
  await table.bulkPut(items)
}

function normalizeLocations(items: Location[] = []): Location[] {
  return items.map(l => ({
    ...l,
    id: toIdString(l.id),
    parentId: l.parentId != null ? toIdString(l.parentId) : undefined
  }))
}

function normalizePlantSystems(items: PlantSystem[] = []): PlantSystem[] {
  return items.map(s => ({
    ...s,
    id: toIdString(s.id),
    locationId: toIdString(s.locationId)
  }))
}

function normalizeMainFunctions(items: MainFunction[] = []): MainFunction[] {
  return items.map(mf => ({
    ...mf,
    id: toIdString(mf.id),
    systemId: mf.systemId != null ? toIdString(mf.systemId) : undefined,
    locationId: mf.locationId != null ? toIdString(mf.locationId) : undefined
  }))
}

function normalizeSubFunctions(items: SubFunction[] = []): SubFunction[] {
  return items.map(sf => ({
    ...sf,
    id: toIdString(sf.id),
    mainFunctionId: sf.mainFunctionId != null ? toIdString(sf.mainFunctionId) : undefined,
    systemId: sf.systemId != null ? toIdString(sf.systemId) : undefined,
    locationId: sf.locationId != null ? toIdString(sf.locationId) : undefined
  }))
}

function normalizeAssetClasses(items: AssetClass[] = []): AssetClass[] {
  return items.map(c => ({ ...c, id: toIdString(c.id) }))
}

function normalizeAssetEntries(items: AssetEntry[] = []): AssetEntry[] {
  return items.map(a => ({
    ...a,
    id: toIdString(a.id),
    classId: toIdString(a.classId),
    subFunctionId: toIdString(a.subFunctionId)
  }))
}

export function normalizeFieldDefinitions(items: FieldDefinition[] = []): FieldDefinition[] {
  return items
    .filter(fd => !fd.deleted)
    .map(fd => ({
      ...fd,
      id: toIdString(fd.id),
      classId: toIdString(fd.classId),
      dataType: (fd.dataType?.toLowerCase() ?? 'text') as FieldDefinition['dataType'],
      deleted: fd.deleted ?? false,
      synced: fd.synced ?? true,
      version: fd.version ?? 1,
      order: fd.order ?? 0,
      validation: fd.validation
        ? {
            ...fd.validation,
            options: normalizeFieldOptions(fd.validation.options)
          }
        : fd.validation
    }))
}

/**
 * Upserts a bundle's field definitions into the shared per-class table.
 *
 * **Upsert, never replace.** This used to delete every row for the bundle's class ids first,
 * which meant merging sheet B could thin the schema sheet A was being filled with: two sheets
 * of the same class can legitimately differ, because the server sends each sheet's own frozen
 * `field_definitions_snapshot` rather than the live class schema. Deleting made the
 * last-merged bundle win globally.
 *
 * Since each sheet now also stores its own copy (`LogSheet.fieldDefinitions`), this table is
 * a fallback for sheets saved before that existed. A stale row lingering here is harmless —
 * the sheet's own copy wins — whereas a deleted row another sheet still needs is not.
 */
async function upsertFieldDefinitionsForBundle(
  fieldDefinitions: FieldDefinition[]
): Promise<void> {
  const normalized = normalizeFieldDefinitions(fieldDefinitions)
  if (normalized.length === 0) return
  await db.fieldDefinitions.bulkPut(normalized)
}

/** Server-wins merge of scoped reference data into IndexedDB. */
export async function mergeBundleContextToDb(
  context: LogSheetContextDto | null | undefined
): Promise<void> {
  if (!context) return

  const fieldDefs = context.fieldDefinitions ?? []

  await Promise.all([
    bulkPutIfAny(db.locations, normalizeLocations(context.locations ?? [])),
    bulkPutIfAny(db.plantSystems, normalizePlantSystems(context.plantSystems ?? [])),
    bulkPutIfAny(db.mainFunctions, normalizeMainFunctions(context.mainFunctions ?? [])),
    bulkPutIfAny(db.subFunctions, normalizeSubFunctions(context.subFunctions ?? [])),
    bulkPutIfAny(db.assetClasses, normalizeAssetClasses(context.assetClasses ?? [])),
    bulkPutIfAny(db.assetEntries, normalizeAssetEntries(context.assetEntries ?? []))
  ])

  await upsertFieldDefinitionsForBundle(fieldDefs)
}

export function mapServerEntryToLocal(
  entry: ServerLogSheetEntry,
  existing?: LogSheetEntryData,
  preserveLocal = true,
  localEditsPending = true
): LogSheetEntryData {
  const localForm = existing?.formData ?? {}
  const serverForm = entry.formData ?? {}
  // Named, because three fields below need to know which side won and an `===` on the resulting
  // object cannot tell them: after the first sync the local copy holds the server's own values,
  // so it compares unequal by identity while being the same data.
  //
  // THE QUESTION IS "DID SOMEBODY EDIT THIS **ON THIS DEVICE**?", AND ONLY ONE THING ANSWERS IT.
  //
  // Three predicates have been tried here. The first two inferred the answer from the data, and
  // each of them lost real readings in a different direction:
  //
  //   `Object.keys(localForm).length > 0` — key presence. The web fill form writes every field
  //   of every entry on every save, so an asset nobody had touched arrived here as
  //   `{"Bar": "", "Status": ""}` and counted as work. Key presence was then permanently true
  //   for every asset in that sheet, `localWins` collapsed into `preserveLocal`, and the server
  //   side of this merge stopped existing: an operator handed a reopened sheet could not see the
  //   readings a supervisor had just entered, and their next submit sent the blanks back and
  //   destroyed them. Log sheet 85.
  //
  //   `hasEntryFormData(localForm)` — value presence. Two failures, and the second is why it is
  //   gone from this expression entirely. It reads a *deliberate clear* as no opinion, so the
  //   next periodic sync restored the value the operator had just removed. And — the one that
  //   matters most — **it cannot tell a value this device entered from a value this device was
  //   sent.** After any sync the local copy holds the server's own readings, so value presence
  //   is true for every filled entry on the device forever after. A supervisor correcting a
  //   reading on the web then reached a device that had already decided it knew better: the new
  //   value never arrived, and the next submit sent the stale one back over it.
  //
  // No predicate over the data can answer this, because the data looks identical whichever way
  // it got there. So the opinion is recorded when it is formed, by the save itself:
  // `locallyEditedAt`, stamped by `applyOperatorEntrySave` on every operator save including one
  // that empties the entry. It is never set by anything that receives from the server — that is
  // the whole property, and it is what makes this expression a single condition.
  //
  // Entries written by builds older than the marker are handled once, at upgrade, by the
  // `version(2)` migration in `db.ts` — deliberately a bounded migration and not a permanent
  // `|| hasEntryFormData(...)`, because an OR arm that only matters for old rows still runs on
  // every merge forever and takes the failure above with it.
  //
  // `localEditsPending` is the second gate, and it is what stops the marker becoming immortal.
  // Once this device's work is delivered and reconciled, the device has no opinion of its own
  // any more — everything it holds came from the server — and a marker still standing there
  // would hand it every future merge for that entry, which is log sheet 85 again by another
  // route. The caller decides; see `applyLogSheetBundle`.
  const localWins = preserveLocal && localEditsPending && existing?.locallyEditedAt != null
  const formData = localWins ? localForm : serverForm

  return {
    assetId: toIdString(entry.assetId),
    assetName: entry.assetName ?? '',
    subFunctionCode: entry.subFunctionCode ?? '',
    subFunctionTag: entry.subFunctionTag ?? '',
    nfcTagId: entry.nfcTagId ?? undefined,
    // Server-authoritative like nfcTagId: always take the server's value, never preserve a
    // local one. The operator cannot edit it, so there is nothing local worth keeping.
    nfcSerial: entry.nfcSerial ?? undefined,
    classId: toIdString(entry.classId),
    formData,
    // Who recorded the values that are actually on screen.
    //
    // Whichever side won `formData` above owns the attribution too, which is why this reads
    // `localWins` rather than comparing objects. An earlier version wrote
    // `formData === serverForm ? … : undefined` and was wrong in both directions: on the second
    // sync the local row already holds the server's values, so identity failed and the label
    // vanished without anyone editing anything; and when the operator genuinely did edit, the
    // save path carried the old name straight through.
    //
    // When the local draft wins, the name kept is the one already stored locally — not
    // `undefined`. An unsent draft on an entry that is still the previous operator's work must
    // keep naming them; it is the *save* that clears it, at the moment the values become this
    // operator's.
    filledByName: localWins
      ? (existing?.filledByName ?? undefined)
      : (entry.filledByName ?? undefined),
    // The winner of `formData` owns its timestamps too — `localWins`, not `preserveLocal`.
    //
    // These two are not decoration: the device echoes them back on submit, and the server's
    // `wouldBlankUnseenAnswer` reads them as "the version this device last saw". Keeping local
    // timestamps while displaying the server's values told the server the device was working
    // from a base it had actually never held, which then refused a legitimate clear. When the
    // server wins the values, the server's timestamps are the honest base.
    //
    // The `??` fallbacks stay: a local row that never held data has neither, and inheriting the
    // server's is exactly right.
    createdAt: localWins
      ? (existing?.createdAt ?? entry.createdAt ?? undefined)
      : (entry.createdAt ?? undefined),
    updatedAt: localWins
      ? (existing?.updatedAt ?? entry.updatedAt ?? undefined)
      : (entry.updatedAt ?? undefined),
    // The server never reports how an entry was captured (no such column round-trips
    // in ServerLogSheetEntry) — this is local-only state. Losing it here would silently
    // relabel a manually-completed entry as NFC-scanned on the next bundle refresh
    // (e.g. simply reopening a draft sheet while online, which runs this merge again
    // before the operator ever hits final submit).
    filledVia: preserveLocal ? existing?.filledVia : undefined,
    // Local-only, like `filledVia`, and this function rebuilds from an explicit field list —
    // omit it and every bundle refresh silently erases the operator's clear.
    //
    // Dropped when the server wins, because the opinion it records is the one that just lost.
    locallyEditedAt: localWins ? existing?.locallyEditedAt : undefined
  }
}

/** Merge server entries with locally saved form values and timestamps (same assetId). */
export function mergeEntriesPreservingFormData(
  serverEntries: ServerLogSheetEntry[],
  existingEntries?: LogSheetEntryData[],
  options?: { preserveLocal?: boolean; localEditsPending?: boolean }
): LogSheetEntryData[] {
  const preserveLocal = options?.preserveLocal !== false
  const localEditsPending = options?.localEditsPending !== false
  const existingByAsset = new Map(
    (existingEntries ?? []).map(e => [toIdString(e.assetId), e])
  )
  return serverEntries.map(entry =>
    mapServerEntryToLocal(
      entry,
      existingByAsset.get(toIdString(entry.assetId)),
      preserveLocal,
      localEditsPending
    )
  )
}

export function bundleScopeDisplayLabel(bundle: LogSheetBundleDto): string | undefined {
  const label = bundle.context?.scopeDisplayLabel?.trim()
  return label || undefined
}
