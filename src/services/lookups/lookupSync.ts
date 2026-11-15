import { ApiError } from '@/services/api/client'
import { fetchLookupPage, type LookupDevicePage, type RequiredLookup } from '@/services/api'
import { db } from '@/services/storage/db'
import { applyPage, dropList, expireLookups, listKey } from './lookupStore'

/**
 * Brings the device's reference lists in line with what its open rounds need (backend roadmap
 * §31 Phase 2). Runs after every inbox merge; never throws — a list problem must not stop the
 * inbox, and a lookup field always has code-only entry to fall back on.
 *
 * <h3>The four rules</h3>
 *
 * 1. **Which lists** — exactly those the assigned rounds just declared (`requiredLookups`), which
 *    is also the server's grant. Every other list is dropped: set difference, so a list stops
 *    being held the moment the last round that needed it closes or is reassigned.
 * 2. **When to fetch** — a list never fetched, a pass not finished, a revision behind what a round
 *    declared, or a lease past half its length (so it is renewed well before it ends, but not on
 *    every tick: each page is a row in the server's download log).
 * 3. **How** — page by page from the stored half-open cursor, so an interrupted pass resumes
 *    where it stopped and a list already held fetches only what changed.
 * 4. **Refused (403)** — the grant is gone; the copy is dropped.
 */

export const PAGE_SIZE = 500
/** A list of 50,000 items is 100 pages; anything beyond that is a server bug, not a list. */
const MAX_PAGES_PER_PASS = 120

export interface LookupSyncResult {
  fetched: string[]
  dropped: string[]
  failed: string[]
}

type FetchPage = typeof fetchLookupPage

export async function syncRequiredLookups(
  required: RequiredLookup[],
  now: number = Date.now(),
  fetchPage: FetchPage = fetchLookupPage
): Promise<LookupSyncResult> {
  const result: LookupSyncResult = { fetched: [], dropped: [], failed: [] }
  try {
    await expireLookups(now)

    const wanted = new Map<string, RequiredLookup>()
    for (const r of required) {
      const key = listKey(r.code)
      const prev = wanted.get(key)
      if (!prev || r.revision > prev.revision) wanted.set(key, r)
    }

    for (const meta of await db.lookupLists.toArray()) {
      if (!wanted.has(meta.id)) {
        await dropList(meta.code)
        result.dropped.push(meta.code)
      }
    }

    for (const [key, need] of wanted) {
      const meta = await db.lookupLists.get(key)
      const halfLease = meta ? meta.leaseUntil - meta.leaseLengthMs / 2 : 0
      const due = !meta
        || !meta.complete
        || meta.revision < need.revision
        || now >= halfLease
      if (!due) continue
      try {
        await fetchPass(need.code, meta?.cursorSince ?? 0, meta?.cursorAfterId ?? 0, now, fetchPage)
        result.fetched.push(need.code)
      } catch (err) {
        if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
          await dropList(need.code)
          result.dropped.push(need.code)
        } else {
          result.failed.push(need.code)
        }
      }
    }
  } catch (err) {
    console.warn('Reference list sync failed', err)
  }
  return result
}

async function fetchPass(code: string, since: number, afterId: number, now: number, fetchPage: FetchPage) {
  let cursorSince = since
  let cursorAfter = afterId
  let passRevision: number | null = null
  for (let i = 0; i < MAX_PAGES_PER_PASS; i++) {
    const page: LookupDevicePage = await fetchPage(code, cursorSince, cursorAfter, PAGE_SIZE)
    if (passRevision == null) passRevision = page.revision
    await applyPage(page, passRevision, now)
    if (!page.hasMore) return
    cursorSince = page.nextSince
    cursorAfter = page.nextAfterId
  }
  throw new Error(`Reference list ${code} did not end within ${MAX_PAGES_PER_PASS} pages`)
}

/** The lists the assigned rounds of an inbox pull declared. */
export function requiredFromBundles(
  bundles: Array<{ context?: { requiredLookups?: RequiredLookup[] } | null }>
): RequiredLookup[] {
  return bundles.flatMap(b => b.context?.requiredLookups ?? [])
}
