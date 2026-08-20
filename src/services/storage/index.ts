import { db, DEFAULT_SETTINGS } from './db'
import type {
  AssetClass,
  AssetEntry,
  AppSettings,
  Location,
  PlantSystem,
  MainFunction,
  LogSheetTemplate,
  LogSheet
} from '@/types'
import { clearLocalEditMarkers } from '@/utils/logSheetLocalData'

// ---------------------------------------------------------------------------
// Asset Classes (was Asset Types)
// ---------------------------------------------------------------------------

export async function getAssetClass(id: string): Promise<AssetClass | undefined> {
  return db.assetClasses.get(id)
}

// ---------------------------------------------------------------------------
// Asset Entries (NFC tag → asset class mapping)
// ---------------------------------------------------------------------------

export async function getAllAssetEntries(): Promise<AssetEntry[]> {
  const entries = await db.assetEntries.toArray()
  return entries.sort((a, b) => a.createdAt - b.createdAt)
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getSettings(): Promise<AppSettings> {
  const row = await db.settings.get('app')
  if (!row) return { ...DEFAULT_SETTINGS }
  const { key: _key, ...settings } = row
  return { ...DEFAULT_SETTINGS, ...settings } as AppSettings
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await db.settings.put({ key: 'app', ...settings })
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export async function getLocation(id: string): Promise<Location | undefined> {
  return db.locations.get(id)
}

// ---------------------------------------------------------------------------
// Plant Systems
// ---------------------------------------------------------------------------

export async function getPlantSystem(id: string): Promise<PlantSystem | undefined> {
  return db.plantSystems.get(id)
}

// ---------------------------------------------------------------------------
// Main Functions
// ---------------------------------------------------------------------------

export async function getMainFunction(id: string): Promise<MainFunction | undefined> {
  return db.mainFunctions.get(id)
}

// ---------------------------------------------------------------------------
// Sub Functions
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Assets in Scope (for LogSheet)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Log Sheet Templates
// ---------------------------------------------------------------------------

export async function getLogSheetTemplate(id: string): Promise<LogSheetTemplate | undefined> {
  return db.logSheetTemplates.get(id)
}

// ---------------------------------------------------------------------------
// Log Sheets
// ---------------------------------------------------------------------------

export async function saveLogSheet(
  data: Omit<LogSheet, 'id' | 'syncStatus' | 'createdAt' | 'updatedAt'> &
    Partial<Pick<LogSheet, 'createdAt' | 'updatedAt' | 'syncStatus'>>
): Promise<LogSheet> {
  const now = Date.now()
  const logSheet: LogSheet = {
    ...data,
    id: data.localId,
    entries: data.entries ?? [],
    syncStatus: data.syncStatus ?? 'pending',
    createdAt: data.createdAt ?? now,
    updatedAt: data.updatedAt ?? now
  }
  await db.logSheets.put(logSheet)
  return logSheet
}

export async function updateLogSheet(
  localId: string,
  updates: Partial<LogSheet>
): Promise<void> {
  const existing = await db.logSheets.where('localId').equals(localId).first()
  if (!existing?.id) throw new Error(`LogSheet not found: ${localId}`)

  if ('syncError' in updates && updates.syncError === undefined) {
    const next: LogSheet = { ...existing, ...updates, updatedAt: Date.now() }
    delete next.syncError
    await db.logSheets.put(next)
    return
  }

  await db.logSheets.update(existing.id, { ...updates, updatedAt: Date.now() })
}

/** Move a locally submitted sheet back to draft (clears outbound queue metadata). */
export async function revertLogSheetToDraft(localId: string): Promise<void> {
  await resetLogSheetToOpenDraft(localId)
}

/** Reset stale local completion when server still shows the sheet as open. */
export async function resetLogSheetToOpenDraft(
  localId: string,
  options?: { clearEntryFormData?: boolean }
): Promise<void> {
  const existing = await db.logSheets.where('localId').equals(localId).first()
  if (!existing?.id) throw new Error(`LogSheet not found: ${localId}`)

  const next: LogSheet = {
    ...existing,
    status: 'draft',
    syncStatus: 'pending',
    updatedAt: Date.now(),
    // Markers go in BOTH branches, including the one that keeps the operator's readings.
    //
    // The reopen-and-continue path resets without `clearEntryFormData` — deliberately, because
    // that is the same operator carrying on with their own work. But it turns a delivered row
    // back into a draft, which re-arms `localEditsPending`; any marker left standing would then
    // win every entry against the server for the rest of the sheet's life, hiding whatever a
    // supervisor changed while it was reopened. Nothing is lost by clearing them here: the work
    // they described has already reached the server, and the operator's next save re-stamps.
    entries: options?.clearEntryFormData
      ? existing.entries.map(e => ({
          ...e,
          formData: {},
          createdAt: undefined,
          updatedAt: undefined,
          filledVia: undefined,
          locallyEditedAt: undefined
        }))
      : clearLocalEditMarkers(existing.entries)
  }
  delete next.submittedAt
  delete next.completedAt
  // Dropping the idempotency key is what makes a corrected resubmission a NEW action rather
  // than a replay. The earlier attempt's id may already be recorded server-side as used, and
  // resending it would let the server's replay guard answer "already processed" — reporting
  // success while never storing the corrected values. The submit path mints a fresh one.
  delete next.clientActionId
  // The rejection is history the moment the sheet is editable again; leaving either of these
  // would keep a failure banner up while the operator fixes the very thing it names.
  delete next.syncError
  delete next.lastSubmitOutcome
  delete next.syncedAt

  await db.logSheets.put(next)
}

export async function getAllLogSheets(): Promise<LogSheet[]> {
  const items = await db.logSheets.toArray()
  return items.sort((a, b) => b.createdAt - a.createdAt)
}

export async function getLogSheet(localId: string): Promise<LogSheet | undefined> {
  return db.logSheets.where('localId').equals(localId).first()
}

export async function getLogSheetByServerId(serverId: string): Promise<LogSheet | undefined> {
  return db.logSheets.where('serverId').equals(serverId).first()
}

export async function deleteLogSheet(localId: string): Promise<void> {
  await db.logSheets.where('localId').equals(localId).delete()
}
