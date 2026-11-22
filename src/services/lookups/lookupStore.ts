import { db } from '@/services/storage/db'
import type { LookupDevicePage } from '@/services/api'
import { normalizeForSearch } from '@/utils/persianSearch'
import type { LookupItemRow, LookupListMeta, LookupOption } from './lookupTypes'

/**
 * The device's copy of the reference lists its open rounds need (backend roadmap §31 Phase 2).
 *
 * <h3>When a copy may be used, and when it must go</h3>
 *
 * A copy is **usable** only when all three hold: a full pass has reached the end of the list, its
 * lease has not ended, and the device clock is not behind the latest server time seen for it. The
 * last one is the clock guard: setting the clock back would otherwise keep personal data past its
 * lease. It stops carelessness, not an owner set on defeating it — said plainly in the backend's
 * security.md rather than overclaimed.
 *
 * A copy that is not usable is never searched. One whose lease ended, or whose clock check fails,
 * is **deleted** as soon as anything looks at it. Nothing an operator recorded goes with it:
 * every answer stores its own `{code, label}`, so a reading stays readable with no list at all.
 */

/** A clock this far behind the server's last word still counts as right — clocks drift. */
export const CLOCK_SKEW_MS = 5 * 60 * 1000

export function listKey(code: string): string {
  return String(code ?? '').trim().toLowerCase()
}

/** Whether the copy may be searched right now. */
export function isUsable(meta: LookupListMeta | undefined, now: number = Date.now()): boolean {
  if (!meta || !meta.complete) return false
  if (now >= meta.leaseUntil) return false
  if (now < meta.serverTimeSeen - CLOCK_SKEW_MS) return false
  return true
}

/** Whether the copy must be deleted now — its lease ended, or the clock was set back. */
export function isExpired(meta: LookupListMeta, now: number = Date.now()): boolean {
  return now >= meta.leaseUntil || now < meta.serverTimeSeen - CLOCK_SKEW_MS
}

export async function getListMeta(code: string): Promise<LookupListMeta | undefined> {
  return db.lookupLists.get(listKey(code))
}

/**
 * The list's state for a field: `ready`, `absent` (never fetched, or dropped), `syncing` (a pass
 * began and has not reached the end), or `expired` (deleted just now). Never silently «empty»:
 * a field that has nothing to offer must say why (backend AGENTS.md #177).
 */
export type LookupAvailability = 'ready' | 'absent' | 'syncing' | 'expired'

export async function availability(code: string, now: number = Date.now()): Promise<LookupAvailability> {
  const meta = await getListMeta(code)
  if (!meta) return 'absent'
  if (isExpired(meta, now)) {
    await dropList(code)
    return 'expired'
  }
  return meta.complete ? 'ready' : 'syncing'
}

/**
 * Active items matching what was typed, at most `limit`, active first by label. An empty query
 * offers the first items — a short list is faster read than searched. Returns `null` when the copy
 * is not usable, so the caller shows code-only entry instead of an empty list.
 */
export async function searchList(
  code: string,
  query: string,
  limit = 30,
  now: number = Date.now()
): Promise<LookupOption[] | null> {
  if ((await availability(code, now)) !== 'ready') return null
  const meta = (await getListMeta(code))!
  if (!isUsable(meta, now)) return null
  const q = normalizeForSearch(query)
  const display = meta.columns.filter(c => c.display).map(c => c.key)
  const rows = await db.lookupItems.where('listId').equals(listKey(code)).toArray()
  return rows
    .filter(r => r.active && (q === '' || r.search.includes(q)))
    .sort((a, b) => a.label.localeCompare(b.label, 'fa'))
    .slice(0, limit)
    .map(r => ({
      code: r.code,
      label: r.label,
      detail: display.map(k => r.attributes[k]).filter(Boolean).join(' · ') || undefined
    }))
}

/** One item by code, active or not — what a recorded answer is shown against, if anything. */
export async function findItem(listCode: string, itemCode: string): Promise<LookupItemRow | undefined> {
  const wanted = String(itemCode ?? '').trim().toLowerCase()
  if (!wanted) return undefined
  const rows = await db.lookupItems.where('listId').equals(listKey(listCode)).toArray()
  return rows.find(r => r.code.toLowerCase() === wanted)
}

/**
 * Writes one page and moves the cursor — in one transaction, so a page is never half-applied and
 * a resumed pass never skips rows. `passRevision` is the revision the FIRST page of this pass
 * reported; it is recorded only when the pass reaches the end.
 */
export async function applyPage(page: LookupDevicePage, passRevision: number, now: number = Date.now()): Promise<void> {
  const id = listKey(page.code)
  const searchable = page.columns.filter(c => c.searchable).map(c => c.key)
  const rows: LookupItemRow[] = page.items.map(item => ({
    id: item.id,
    listId: id,
    code: item.code,
    label: item.label,
    active: item.active,
    attributes: item.attributes ?? {},
    search: normalizeForSearch([item.code, item.label, ...searchable.map(k => item.attributes?.[k] ?? '')].join(' ')),
    updatedAt: item.updatedAt
  }))
  await db.transaction('rw', db.lookupLists, db.lookupItems, async () => {
    const before = await db.lookupLists.get(id)
    if (rows.length > 0) await db.lookupItems.bulkPut(rows)
    const complete = (before?.complete ?? false) || !page.hasMore
    const meta: LookupListMeta = {
      id,
      code: page.code,
      name: page.name,
      revision: !page.hasMore ? passRevision : (before?.revision ?? -1),
      complete,
      cursorSince: page.nextSince,
      cursorAfterId: page.nextAfterId,
      // The lease is counted on the DEVICE clock from now, for the length the server granted —
      // the device clock is the one that will judge it.
      leaseLengthMs: Math.max(0, page.leaseUntil - page.serverTime),
      leaseUntil: now + Math.max(0, page.leaseUntil - page.serverTime),
      serverTimeSeen: Math.max(before?.serverTimeSeen ?? 0, page.serverTime),
      columns: page.columns
    }
    await db.lookupLists.put(meta)
  })
}

/** Deletes one list's copy — items and state. */
export async function dropList(code: string): Promise<void> {
  const id = listKey(code)
  await db.transaction('rw', db.lookupLists, db.lookupItems, async () => {
    await db.lookupItems.where('listId').equals(id).delete()
    await db.lookupLists.delete(id)
  })
}

/** Deletes every list. At sign-out: personal data does not stay for the next user of a shared tablet. */
export async function clearAllLookups(): Promise<void> {
  await db.transaction('rw', db.lookupLists, db.lookupItems, async () => {
    await db.lookupItems.clear()
    await db.lookupLists.clear()
  })
}

/** Deletes every copy whose lease ended or whose clock check fails. Safe to call offline. */
export async function expireLookups(now: number = Date.now()): Promise<number> {
  const metas = await db.lookupLists.toArray()
  let dropped = 0
  for (const meta of metas) {
    if (isExpired(meta, now)) {
      await dropList(meta.code)
      dropped++
    }
  }
  return dropped
}
