import 'fake-indexeddb/auto'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { db } from '@/services/storage/db'
import { ApiError } from '@/services/api/client'
import type { LookupDevicePage, RequiredLookup } from '@/services/api'
import {
  applyPage,
  availability,
  clearAllLookups,
  CLOCK_SKEW_MS,
  expireLookups,
  findItem,
  getListMeta,
  searchList
} from './lookupStore'
import { refreshLookup, requiredFromBundles, syncRequiredLookups } from './lookupSync'
import { buildValidationRules } from '@/components/forms/DynamicClassForm'
import { isFieldValueBlank } from '@/utils/formDataValidation'
import {
  lookupChoiceText,
  lookupChoices,
  lookupDisplayValue,
  normalizeLookupCode,
  toLookupValue,
  unlistedCodeFor
} from '@/utils/lookupValue'
import type { FieldDefinition } from '@/types/sync'

/**
 * A field that draws from a reference list, on the device (backend roadmap §31 Phase 2).
 *
 * What must hold, section by section:
 *  - the value: read leniently (an answer this build cannot fully read survives a save), written
 *    as `{ code, label }`, shown as recorded with the server's verdict;
 *  - the store: searched only while usable — complete, leased, and with a clock not set back — and
 *    deleted the moment it is not; never «empty» without saying why;
 *  - the sync: exactly the lists the assigned rounds need, page by page from the cursor, renewed
 *    at half the lease, dropped on 403 and when no round needs them, kept on a network failure.
 */

const HOUR = 3_600_000
const T0 = 1_800_000_000_000

function page(over: Partial<LookupDevicePage> = {}): LookupDevicePage {
  return {
    code: 'STAFF',
    name: 'پرسنل',
    revision: 5,
    serverTime: T0,
    leaseUntil: T0 + 24 * HOUR,
    columns: [{ key: 'unit', label: 'واحد', searchable: true, display: true }],
    items: [
      { id: 1, code: '1001', label: 'علی رضایی', active: true, attributes: { unit: 'تعمیرات' }, updatedAt: 10 },
      { id: 2, code: '1002', label: 'مریم احمدی', active: false, attributes: {}, updatedAt: 11 },
      { id: 3, code: '1003', label: 'رضا کریمی', active: true, attributes: { unit: 'بهره‌برداری' }, updatedAt: 12 }
    ],
    hasMore: false,
    nextSince: 12,
    nextAfterId: 3,
    ...over
  }
}

beforeAll(async () => {
  if (!db.isOpen()) await db.open()
})

afterEach(async () => {
  await clearAllLookups()
})

// ── the value ──────────────────────────────────────────────────────────────────────────────

describe('lookup value', () => {
  it('reads a bare code, a number, an object and a list; collapses duplicates', () => {
    expect(lookupChoices('1001')).toEqual([{ code: '1001' }])
    expect(lookupChoices(1001)).toEqual([{ code: '1001' }])
    expect(lookupChoices({ code: '۱۰۰۱', label: 'علی', state: 'INACTIVE' }))
      .toEqual([{ code: '1001', label: 'علی', state: 'INACTIVE' }])
    expect(lookupChoices([{ code: 'ab' }, 'AB', { code: 'cd' }]).map(c => c.code)).toEqual(['ab', 'cd'])
    expect(lookupChoices(null)).toEqual([])
    expect(lookupChoices([])).toEqual([])
    expect(lookupChoices({ label: 'no code' })).toEqual([])
  })

  it('refuses a code that could never be an item’s', () => {
    expect(normalizeLookupCode('two words')).toBeNull()
    expect(normalizeLookupCode('x'.repeat(101))).toBeNull()
    expect(normalizeLookupCode('  ')).toBeNull()
    expect(normalizeLookupCode(' ۱۲ ')).toBe('12')
  })

  it('writes one object or an array, as the type says', () => {
    expect(toLookupValue([{ code: '1' }], false)).toEqual({ code: '1' })
    expect(toLookupValue([], false)).toBeNull()
    expect(toLookupValue([{ code: '1' }, { code: '2' }], true)).toHaveLength(2)
    expect(toLookupValue([], true)).toEqual([])
  })

  it('shows the recorded label with the server’s verdict', () => {
    expect(lookupChoiceText({ code: '1', label: 'علی', state: 'ACTIVE' })).toBe('علی (1)')
    expect(lookupChoiceText({ code: '1', label: 'علی', state: 'INACTIVE' })).toBe('علی (1) · غیرفعال')
    expect(lookupChoiceText({ code: '9', state: 'UNKNOWN' })).toBe('9 · خارج از فهرست')
    expect(lookupDisplayValue([{ code: '1', label: 'الف' }, { code: '2', label: 'ب' }])).toBe('الف (1)، ب (2)')
  })

  it('a required lookup needs a code — an empty array or an object without one is blank', () => {
    const def = { id: '1', classId: '2', key: 'person', label: 'فرد', dataType: 'lookup', required: true, order: 1,
      validation: { lookupList: 'staff' } } as FieldDefinition
    const validate = buildValidationRules(def).validate as (v: unknown) => true | string
    expect(validate([])).toBe('این فیلد الزامی است')
    expect(validate({ code: '1001' })).toBe(true)
    expect(isFieldValueBlank([], 'lookupmulti')).toBe(true)
    expect(isFieldValueBlank({ code: '1' }, 'lookup')).toBe(false)
  })
})

// ── the store ──────────────────────────────────────────────────────────────────────────────

describe('lookup store', () => {
  it('searches its own copy, Persian-folded, active items only, with the display columns', async () => {
    await applyPage(page(), 5, T0)
    const found = await searchList('staff', 'علي', 30, T0 + HOUR)
    expect(found).toEqual([{ code: '1001', label: 'علی رضایی', detail: 'تعمیرات' }])
    // An empty query offers the active items by label — «رضا» before «علی» — and never the retired one.
    expect((await searchList('STAFF', '', 30, T0 + HOUR))!.map(o => o.code)).toEqual(['1003', '1001'])
    expect((await searchList('staff', 'بهره', 30, T0 + HOUR))!.map(o => o.code)).toEqual(['1003'])
    expect(await findItem('staff', '1002')).toMatchObject({ active: false, label: 'مریم احمدی' })
  })

  it('says why it has nothing: absent, still syncing, expired — never an empty list', async () => {
    expect(await availability('staff', T0)).toBe('absent')
    expect(await searchList('staff', '', 30, T0)).toBeNull()

    await applyPage(page({ hasMore: true }), 5, T0)
    expect(await availability('staff', T0)).toBe('syncing')
    expect(await searchList('staff', '', 30, T0)).toBeNull()

    await applyPage(page({ items: [], hasMore: false }), 5, T0)
    expect(await availability('staff', T0 + HOUR)).toBe('ready')
  })

  it('deletes the copy when its lease ends — counted on the device clock from the last sync', async () => {
    await applyPage(page(), 5, T0)
    expect(await availability('staff', T0 + 23 * HOUR)).toBe('ready')
    expect(await availability('staff', T0 + 24 * HOUR)).toBe('expired')
    expect(await getListMeta('staff')).toBeUndefined()
    expect(await db.lookupItems.where('listId').equals('staff').count()).toBe(0)
  })

  it('treats a clock set back past the last server time as expired', async () => {
    await applyPage(page({ serverTime: T0 + 2 * HOUR, leaseUntil: T0 + 26 * HOUR }), 5, T0 + 2 * HOUR)
    expect(await availability('staff', T0 + 2 * HOUR - CLOCK_SKEW_MS + 1)).toBe('ready')
    expect(await availability('staff', T0)).toBe('expired')
  })

  it('expires every lapsed copy, offline, without touching a live one', async () => {
    await applyPage(page(), 5, T0)
    await applyPage(page({ code: 'OTHER', items: [{ id: 9, code: 'x', label: 'x', active: true, attributes: {}, updatedAt: 1 }],
      leaseUntil: T0 + 48 * HOUR }), 1, T0)
    expect(await expireLookups(T0 + 30 * HOUR)).toBe(1)
    expect(await getListMeta('staff')).toBeUndefined()
    expect(await getListMeta('other')).toBeDefined()
  })

  it('sign-out clears every list', async () => {
    await applyPage(page(), 5, T0)
    await clearAllLookups()
    expect(await db.lookupLists.count()).toBe(0)
    expect(await db.lookupItems.count()).toBe(0)
  })
})

// ── the sync ───────────────────────────────────────────────────────────────────────────────

describe('lookup sync', () => {
  const need = (revision = 5): RequiredLookup[] => [{ code: 'STAFF', name: 'پرسنل', revision }]

  it('fetches a list page by page from the cursor, and records the revision of the FIRST page', async () => {
    const calls: Array<[number, number]> = []
    const pages = [
      page({ items: page().items.slice(0, 2), hasMore: true, nextSince: 11, nextAfterId: 2, revision: 5 }),
      page({ items: page().items.slice(2), hasMore: false, nextSince: 12, nextAfterId: 3, revision: 6 })
    ]
    const result = await syncRequiredLookups(need(), T0, async (_code, since, afterId) => {
      calls.push([since, afterId])
      return pages.shift()!
    })
    expect(result.fetched).toEqual(['STAFF'])
    expect(calls).toEqual([[0, 0], [11, 2]])
    const meta = await getListMeta('staff')
    expect(meta).toMatchObject({ complete: true, revision: 5, cursorSince: 12, cursorAfterId: 3 })
    expect(await db.lookupItems.where('listId').equals('staff').count()).toBe(3)
  })

  it('does not fetch a current list until half its lease has passed; then fetches only what changed', async () => {
    await applyPage(page(), 5, T0)
    let calls = 0
    const fetcher = async (_c: string, since: number, after: number) => {
      calls++
      expect([since, after]).toEqual([12, 3])
      return page({ items: [], revision: 5 })
    }
    await syncRequiredLookups(need(5), T0 + HOUR, fetcher)
    expect(calls).toBe(0)
    await syncRequiredLookups(need(5), T0 + 13 * HOUR, fetcher)
    expect(calls).toBe(1)
    await syncRequiredLookups(need(6), T0 + 13 * HOUR + 1, fetcher)
    expect(calls).toBe(2)
  })

  it('drops a list no assigned round needs, and one the server refuses', async () => {
    await applyPage(page(), 5, T0)
    await applyPage(page({ code: 'OTHER' }), 1, T0)

    const r1 = await syncRequiredLookups(need(), T0 + HOUR, async () => page())
    expect(r1.dropped).toEqual(['OTHER'])
    expect(await getListMeta('other')).toBeUndefined()

    const r2 = await syncRequiredLookups(need(9), T0 + HOUR, async () => {
      throw new ApiError(403, 'forbidden')
    })
    expect(r2.dropped).toEqual(['STAFF'])
    expect(await getListMeta('staff')).toBeUndefined()
  })

  it('keeps what it has when the network fails mid-pass', async () => {
    await applyPage(page(), 5, T0)
    const r = await syncRequiredLookups(need(9), T0 + HOUR, async () => {
      throw new TypeError('Failed to fetch')
    })
    expect(r.failed).toEqual(['STAFF'])
    expect(await availability('staff', T0 + HOUR)).toBe('ready')
  })

  it('reads the required lists from the assigned bundles', () => {
    expect(requiredFromBundles([
      { context: { requiredLookups: need() } },
      { context: null },
      { context: { requiredLookups: [{ code: 'X', name: 'x', revision: 1 }] } }
    ]).map(r => r.code)).toEqual(['STAFF', 'X'])
  })
})

// ── «use this code», and refreshing one list (backend roadmap §31) ─────────────────────────

describe('a code the device copy does not have yet', () => {
  it('is offered only when the field allows it and the search found nothing', () => {
    expect(unlistedCodeFor('1077', 0, true)).toBe('1077')
    expect(unlistedCodeFor('1077', 0, false)).toBeNull()
    expect(unlistedCodeFor('1077', 3, true)).toBeNull()
  })

  it('is normalised as the server keys it, and never offered for what could not be a code', () => {
    expect(unlistedCodeFor(' ۱۰۷۷ ', 0, true)).toBe('1077')
    expect(unlistedCodeFor('two words', 0, true)).toBeNull()
    expect(unlistedCodeFor('', 0, true)).toBeNull()
    expect(unlistedCodeFor('x'.repeat(101), 0, true)).toBeNull()
  })

  it('a bare code reads as not yet checked, never as a resolved choice', () => {
    expect(lookupChoiceText({ code: '1077' })).toBe('1077 · بررسی هنگام ارسال')
    expect(lookupChoiceText({ code: '1077', label: 'حسین', state: 'ACTIVE' })).toBe('حسین (1077)')
  })
})

describe('refreshing one list from the field', () => {
  it('fetches only what changed since the stored cursor, and renews the lease', async () => {
    await applyPage(page(), 5, T0)
    const added = { id: 4, code: '1077', label: 'حسین مرادی', active: true, attributes: {}, updatedAt: 20 }
    const calls: Array<[number, number]> = []
    const outcome = await refreshLookup('staff', T0 + HOUR, async (_c, since, after) => {
      calls.push([since, after])
      return page({ items: [added], revision: 6, nextSince: 20, nextAfterId: 4 })
    })
    expect(outcome).toBe('fetched')
    expect(calls).toEqual([[12, 3]])
    expect((await searchList('staff', 'حسین', 30, T0 + HOUR))!.map(o => o.code)).toEqual(['1077'])
    expect((await getListMeta('staff'))!.leaseUntil).toBe(T0 + HOUR + 24 * HOUR)
  })

  it('drops the copy when the server refuses it, and keeps it when the network fails', async () => {
    await applyPage(page(), 5, T0)
    expect(await refreshLookup('staff', T0 + HOUR, async () => { throw new TypeError('Failed to fetch') }))
      .toBe('failed')
    expect(await availability('staff', T0 + HOUR)).toBe('ready')
    expect(await refreshLookup('staff', T0 + HOUR, async () => { throw new ApiError(403, 'no') }))
      .toBe('dropped')
    expect(await getListMeta('staff')).toBeUndefined()
  })

  it('leaves every other list alone — it does not know what the inbox needs', async () => {
    await applyPage(page(), 5, T0)
    await applyPage(page({ code: 'OTHER' }), 1, T0)
    await refreshLookup('staff', T0 + HOUR, async () => page({ items: [] }))
    expect(await getListMeta('other')).toBeDefined()
  })
})
