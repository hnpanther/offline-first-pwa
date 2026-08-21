import { db } from '@/services/storage/db'
import { getLogSheetByServerId, saveLogSheet } from '@/services/storage'
import { removeArchivedLogSheet } from '@/services/storage/logSheetArchive'
import { attachmentIdsOf, buildAttachmentRef } from '@/services/storage/attachments'
import { getFieldsForClass } from '@/services/storage/fieldDefinitions'
import { hasEntryFormData, isValueFilled } from '@/utils/entryTimestamps'
import { resolveLocalWorkOwner } from '@/utils/logSheetLocalData'
import { sheetFieldDefinitions } from '@/utils/sheetFieldDefinitions'
import { toIdString } from '@/utils/ids'
import type { AttachmentRef, LocalAttachment, LogSheet, LogSheetEntryData } from '@/types'
import type { FieldDefinition } from '@/types/sync'

/**
 * Copying an archived round back into the live sheet, one asset at a time.
 *
 * <h2>Why this is explicit and not automatic</h2>
 *
 * When a sheet is reassigned away, the tablet clears the live row and archives what the operator
 * had entered — a shared tablet holds one row per sheet, so the next operator must not inherit
 * it. If the sheet comes **back**, the archived card stays visible (see
 * `loadLogSheetsForSessionUser`) but the live sheet is empty, and the readings had to be typed
 * in again.
 *
 * They are not copied back on their own, and that is the whole design constraint. Archived
 * entries carry `locallyEditedAt`, so writing them into the live row makes them **win the next
 * merge against the server** — and while the sheet belonged to somebody else, that somebody may
 * have recorded their own values, which would then be buried with no trace. That is gotcha #87
 * arriving by a new route. So the operator chooses, per asset, with both versions in front of
 * them, and {@link buildRestorePlan} is what puts them there.
 *
 * <h2>The attachment rule, which is the delicate half</h2>
 *
 * Media is not in `formData` — the bytes live in `db.attachments`, and the form value holds only
 * a list of ids. Clearing the live row dropped those ids while leaving every file on the device,
 * so the field renders empty while its counter still counts the files. Restoring has to put the
 * references back without inventing or losing any, and the invariant below is what this module
 * guarantees and {@link restoreArchivedEntries} is tested against:
 *
 * > For every (asset, field) it writes, the ids in `formData` are **exactly** the ids of the
 * > attachment rows this device holds for that (sheet, asset, field), excluding rows already
 * > queued for deletion — deduplicated, and never an id that resolves to nothing.
 *
 * Three consequences follow, and each is deliberate:
 *
 * - **Nothing missing.** A file on the device is referenced, even if the archive never knew about
 *   it (another operator captured it on this tablet while they held the sheet). Dropping a
 *   reference does not delete the file, it hides it — and hiding somebody's photograph is the
 *   failure this codebase has already paid for once.
 * - **Nothing extra.** An id whose row is gone — a blob reclaimed, a file deleted — is not
 *   written. A dangling reference renders as a broken slot and misleads the field counter.
 * - **Never an empty reference.** A field with no surviving rows is omitted from the restored
 *   `formData` entirely rather than written as `{type:'attachment', ids:[]}`, which is a key that
 *   means "nothing" and is exactly the contamination gotcha #87 is about.
 *
 * The per-field ceiling is not re-checked here. It is enforced by the server per (sheet, asset,
 * field, kind) at upload time, as a 409 that frees itself; referencing files that already exist
 * on the device cannot make that worse, and silently dropping one to fit would be "missing".
 */

/**
 * One field of one asset, as the confirmation dialog shows it.
 *
 * <p>Only fields a restore would actually change appear here. A field both versions agree on is
 * not a decision, and listing it would bury the ones that are.
 */
export interface RestorableField {
  key: string
  /** The class's own label, so the operator reads دمای خروجی and not `temp_out`. Falls back to the key. */
  label: string
  unit?: string
  /** True when the value is a reference to files on the device rather than something typed. */
  media: boolean
  /** Exactly what a restore would write here. `undefined` means the key is left out entirely. */
  mine: unknown
  /** What the live entry holds for this field right now. */
  current: unknown
}

/** One asset the operator may restore, with both versions side by side. */
export interface RestorableAsset {
  assetId: string
  assetName: string
  /** What the operator recorded, with attachment references resolved to what still exists. */
  mine: Record<string, unknown>
  /** What the live sheet holds for this asset right now. */
  current: Record<string, unknown>
  /** The live sheet already has readings here — restoring replaces them. */
  conflict: boolean
  /** Attachment ids that will be referenced after a restore. */
  attachmentIds: string[]
  /** Referenced by the archive, but no longer on the device. Shown so the loss is not silent. */
  missingAttachmentIds: string[]
  /** The per-field diff, in the class's display order — what the operator is being asked about. */
  fields: RestorableField[]
}

export interface RestorePlan {
  serverId: string
  userId: string
  /** The live row's local id — what the caller navigates to afterwards. */
  liveLocalId: string
  assets: RestorableAsset[]
}

export type RestoreRefusal =
  | 'no-archive'
  | 'no-live-sheet'
  | 'not-your-work'
  | 'sheet-not-editable'

export interface RestoreOutcome {
  restoredAssetIds: string[]
  /** True when every asset that had something to restore was restored, so the archive was dropped. */
  archiveCleared: boolean
  refusal?: RestoreRefusal
}

/**
 * Whether two form values are the same answer.
 *
 * <p>Key order is normalised because these objects come from JSON — from IndexedDB, from a
 * bundle, from a form — and two identical answers can differ in the order their keys were
 * written. Comparing them as-is would keep offering an asset that has already been restored.
 */
function sameFormData(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable)
    if (value != null && typeof value === 'object') {
      return Object.keys(value as Record<string, unknown>)
        .sort()
        .map(k => [k, stable((value as Record<string, unknown>)[k])])
    }
    return value
  }
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b))
}

/**
 * The fields a restore would change, labelled and ordered the way the fill page orders them.
 *
 * <p>`merged` is what would be written, so a media field's `mine` is the **restored** reference —
 * the files this device still holds — not the archive's stale list. That matters: the archive can
 * name a file that is gone and can be missing one another operator captured, and a dialog that
 * showed the stale count would promise the wrong thing.
 */
function diffFields(
  merged: Record<string, unknown>,
  current: Record<string, unknown>,
  defs: FieldDefinition[]
): RestorableField[] {
  const byKey = new Map(defs.map(d => [d.key, d]))
  const order = new Map(defs.map((d, i) => [d.key, i]))

  const keys = [...new Set([...Object.keys(merged), ...Object.keys(current)])].filter(
    key => !sameFormData({ v: merged[key] }, { v: current[key] })
  )
  // Unknown keys sort last rather than being dropped: a value the class no longer declares is
  // still the operator's reading, and hiding it would make the dialog disagree with the write.
  keys.sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER))

  return keys.map(key => ({
    key,
    label: byKey.get(key)?.label || key,
    unit: byKey.get(key)?.unit,
    media: isAttachmentValue(merged[key]) || isAttachmentValue(current[key]),
    mine: merged[key],
    current: current[key]
  }))
}

function isAttachmentValue(value: unknown): value is AttachmentRef {
  return (
    value != null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === 'attachment'
  )
}

/** Every attachment this device holds for a sheet, indexed by `assetId::fieldKey`. */
async function indexAttachments(logSheetLocalId: string): Promise<Map<string, LocalAttachment[]>> {
  const rows = await db.attachments.where('logSheetLocalId').equals(logSheetLocalId).toArray()
  const index = new Map<string, LocalAttachment[]>()
  for (const row of rows) {
    if (row.pendingDelete) continue
    const key = `${toIdString(row.assetId)}::${row.fieldKey}`
    const bucket = index.get(key)
    if (bucket) bucket.push(row)
    else index.set(key, [row])
  }
  // Capture order, so a restored field lists media the way the operator recorded it.
  for (const bucket of index.values()) bucket.sort((a, b) => a.createdAt - b.createdAt)
  return index
}

/**
 * The values a restore would write for one asset, and the attachment ids it would reference.
 *
 * <p>Starts from the live entry so that a field the archive says nothing about is left exactly as
 * it is, then applies the archived value field by field.
 */
function mergeEntry(
  mine: Record<string, unknown>,
  current: Record<string, unknown>,
  assetId: string,
  attachments: Map<string, LocalAttachment[]>
): { formData: Record<string, unknown>; attachmentIds: string[]; missing: string[] } {
  const formData: Record<string, unknown> = { ...current }
  const attachmentIds: string[] = []
  const missing: string[] = []

  for (const [fieldKey, value] of Object.entries(mine)) {
    if (isAttachmentValue(value) || isAttachmentValue(current[fieldKey])) {
      const onDevice = attachments.get(`${toIdString(assetId)}::${fieldKey}`) ?? []
      const liveIds = new Set(onDevice.map(row => row.id))

      for (const id of attachmentIdsOf(value)) {
        if (!liveIds.has(id)) missing.push(id)
      }

      if (onDevice.length === 0) {
        // No surviving media for this field: leave the key out rather than writing an empty
        // reference, which reads as an answer and contaminates the entry.
        delete formData[fieldKey]
        continue
      }
      const ids = onDevice.map(row => row.id)
      formData[fieldKey] = buildAttachmentRef(ids)
      attachmentIds.push(...ids)
      continue
    }

    if (!isValueFilled(value)) {
      // The operator's own blank is not a reading. Restoring it over a value somebody else
      // recorded would be a deletion dressed up as a restore.
      continue
    }
    formData[fieldKey] = value
  }

  return { formData, attachmentIds, missing }
}

/**
 * What the operator would get back, per asset — or `null` when there is nothing to offer.
 *
 * <p>Refuses on the same conditions {@link restoreArchivedEntries} does, so the UI never shows a
 * plan for something the apply step would then decline.
 */
export async function buildRestorePlan(
  serverId: string,
  userId: string
): Promise<RestorePlan | null> {
  const archiveRow = await db.logSheetUserArchives.get(`${toIdString(serverId)}:${userId}`)
  if (!archiveRow) return null

  const live = await getLogSheetByServerId(toIdString(serverId))
  if (!live || !isRestorable(live, userId)) return null

  const attachments = await indexAttachments(live.localId)
  const archivedByAsset = new Map(
    (archiveRow.sheet.entries ?? []).map(e => [toIdString(e.assetId), e])
  )
  // One read per class, not per asset: a 47-asset sheet is usually two or three classes.
  const defsByClass = new Map<string, FieldDefinition[]>()
  const defsFor = async (classId: string | undefined): Promise<FieldDefinition[]> => {
    const id = toIdString(classId)
    const cached = defsByClass.get(id)
    if (cached) return cached
    // Same precedence as the fill page, so the dialog can never label a field differently from
    // the form the operator is about to open.
    const resolved = sheetFieldDefinitions(live, id, await getFieldsForClass(id))
    defsByClass.set(id, resolved)
    return resolved
  }

  const assets: RestorableAsset[] = []
  for (const liveEntry of live.entries) {
    const assetId = toIdString(liveEntry.assetId)
    const archivedEntry = archivedByAsset.get(assetId)
    if (!archivedEntry || !hasEntryFormData(archivedEntry.formData)) continue

    const merged = mergeEntry(
      archivedEntry.formData ?? {},
      liveEntry.formData ?? {},
      assetId,
      attachments
    )
    // Nothing survived — neither a value nor a file. Offering it would be offering an empty row.
    if (!hasEntryFormData(merged.formData)) continue
    // Already restored, or the live sheet happens to hold exactly this. Offering it again would
    // invite the operator to "recover" what is already in front of them, and would stop the
    // archive from ever clearing after a restore done in two passes.
    if (sameFormData(merged.formData, liveEntry.formData ?? {})) continue

    assets.push({
      assetId,
      assetName: liveEntry.assetName || archivedEntry.assetName || assetId,
      mine: archivedEntry.formData ?? {},
      current: liveEntry.formData ?? {},
      conflict: hasEntryFormData(liveEntry.formData),
      attachmentIds: merged.attachmentIds,
      missingAttachmentIds: merged.missing,
      fields: diffFields(merged.formData, liveEntry.formData ?? {}, await defsFor(liveEntry.classId))
    })
  }

  if (assets.length === 0) return null
  return { serverId: toIdString(serverId), userId, liveLocalId: live.localId, assets }
}

/** The live sheet has to be this user's, and still open to edit. */
function isRestorable(live: LogSheet, userId: string): boolean {
  if (resolveLocalWorkOwner(live) !== userId) return false
  return live.status === 'draft'
}

/**
 * Writes the chosen assets back into the live sheet.
 *
 * <p>`locallyEditedAt` is stamped **now**, not carried from the archive. The opinion is being
 * formed at this moment, by an operator who has just looked at both versions and chosen — and
 * stamping it now is what makes the next merge an honest account of that. Carrying the archived
 * timestamp would claim the edit happened before values the server has since sent.
 *
 * <p>`createdAt`/`updatedAt` are deliberately **not** restored. Those two are the version of the
 * entry this device last saw, echoed back on submit and compared by the server's
 * `wouldBlankUnseenAnswer`; the live row's are current, the archive's are stale, and replacing
 * them would tell the server the device is working from a base it no longer holds.
 */
export async function restoreArchivedEntries(
  serverId: string,
  userId: string,
  assetIds: string[],
  now: number = Date.now()
): Promise<RestoreOutcome> {
  const archiveRow = await db.logSheetUserArchives.get(`${toIdString(serverId)}:${userId}`)
  if (!archiveRow) return { restoredAssetIds: [], archiveCleared: false, refusal: 'no-archive' }

  const live = await getLogSheetByServerId(toIdString(serverId))
  if (!live) return { restoredAssetIds: [], archiveCleared: false, refusal: 'no-live-sheet' }
  if (resolveLocalWorkOwner(live) !== userId) {
    return { restoredAssetIds: [], archiveCleared: false, refusal: 'not-your-work' }
  }
  if (live.status !== 'draft') {
    return { restoredAssetIds: [], archiveCleared: false, refusal: 'sheet-not-editable' }
  }

  const plan = await buildRestorePlan(serverId, userId)
  if (!plan) return { restoredAssetIds: [], archiveCleared: false, refusal: 'no-archive' }

  const offered = new Map(plan.assets.map(a => [a.assetId, a]))
  const wanted = new Set(assetIds.map(toIdString).filter(id => offered.has(id)))
  if (wanted.size === 0) return { restoredAssetIds: [], archiveCleared: false }

  const attachments = await indexAttachments(live.localId)
  const archivedByAsset = new Map(
    (archiveRow.sheet.entries ?? []).map(e => [toIdString(e.assetId), e])
  )

  const restoredAssetIds: string[] = []
  const entries: LogSheetEntryData[] = live.entries.map(entry => {
    const assetId = toIdString(entry.assetId)
    if (!wanted.has(assetId)) return entry

    const archivedEntry = archivedByAsset.get(assetId)!
    const merged = mergeEntry(
      archivedEntry.formData ?? {},
      entry.formData ?? {},
      assetId,
      attachments
    )
    restoredAssetIds.push(assetId)
    return {
      ...entry,
      formData: merged.formData,
      // How the reading was captured travels with it; the server never sends this back, so
      // losing it here would relabel a manually-entered row as NFC-scanned.
      filledVia: archivedEntry.filledVia ?? entry.filledVia,
      // Attribution is the server's to decide and it re-stamps on the next bundle. Clearing it
      // is what the ordinary save path does, for the same reason.
      filledByName: undefined,
      locallyEditedAt: now
    }
  })

  await saveLogSheet({ ...live, entries, updatedAt: now })

  // The archive is dropped only when nothing restorable is left behind, so a partial restore
  // keeps the rest reachable instead of stranding it the way the original bug did.
  const archiveCleared = wanted.size === plan.assets.length
  if (archiveCleared) await removeArchivedLogSheet(toIdString(serverId), userId)

  return { restoredAssetIds, archiveCleared }
}
