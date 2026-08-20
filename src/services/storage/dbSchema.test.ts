import 'fake-indexeddb/auto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from './db'

/**
 * The schema is declared in one place, so this is the second opinion.
 *
 * <p>A store added to `AppDatabase` as a typed `Table` but left out of `stores()` compiles, and
 * then throws "Table X does not exist" the first time the app touches it — on a device, inside
 * whichever feature happened to reach it first. Nothing else catches that: there is no second
 * declaration to disagree with.
 *
 * <p>The version assertion has a different job. Version 1 is **operational** — it is on tablets
 * in the field — so adding a `version(2)` block is a one-way upgrade for every one of them.
 * Making this test fail on that change is the point: it forces the decision to be written down
 * here, next to the store list it affects, instead of shipping as a side effect.
 */

const EXPECTED_STORES = [
  'assetClasses',
  'assetEntries',
  'attachments',
  'fieldDefinitions',
  'locations',
  'logSheetTemplates',
  'logSheetUserArchives',
  'logSheets',
  'mainFunctions',
  'nfcFaultReports',
  'operationalUnits',
  'plantSystems',
  'settings',
  'subFunctions',
  'syncMeta'
] as const

/** Indexes something selects on in a loop. Losing one is a silent full-table scan on a tablet. */
const REQUIRED_INDEXES: ReadonlyArray<readonly [string, readonly string[]]> = [
  // The upload queues run on every sync tick and filter by status.
  ['attachments', ['syncStatus', 'logSheetLocalId', 'logSheetServerId']],
  ['nfcFaultReports', ['syncStatus', 'logSheetServerId']],
  // The merge looks a sheet up by both of its identities, once per bundle.
  ['logSheets', ['localId', 'serverId', 'status']],
  // Archived work is found by the pair that identifies whose it is.
  ['logSheetUserArchives', ['serverId', 'userId']],
  // NFC lookup is the one thing that must be instant with a tag held to the device.
  ['assetEntries', ['nfcTagId', 'nfcSerial']],
  ['subFunctions', ['tag']]
]

beforeAll(async () => {
  if (!db.isOpen()) await db.open()
})

afterAll(() => {
  if (db.isOpen()) db.close()
})

describe('IndexedDB schema', () => {
  it('is at the version this build expects', () => {
    // Version 1 is the operational baseline and is closed: it is on tablets in the field, and a
    // device cannot open a database at a version below the one that created it.
    //
    // This assertion is deliberately a hard-coded number rather than a range. Adding a
    // `version(2)` block is a decision with consequences on every tablet — a forced upgrade that
    // cannot be rolled back — so it should take a deliberate edit here, in a file whose whole
    // subject is the schema, rather than passing silently because the check said "1 or more".
    expect(db.verno).toBe(1)
  })

  it('declares exactly the stores the app uses', () => {
    expect(db.tables.map(t => t.name).sort()).toEqual([...EXPECTED_STORES].sort())
  })

  it('has a table property for every declared store', () => {
    // Catches the half-added store: declared in `stores()` but with no typed accessor, or the
    // reverse. Either half alone compiles and then fails on a device.
    for (const name of EXPECTED_STORES) {
      expect((db as unknown as Record<string, unknown>)[name]).toBeDefined()
    }
  })

  it('keeps the indexes the sync loops depend on', () => {
    for (const [store, indexes] of REQUIRED_INDEXES) {
      const table = db.tables.find(t => t.name === store)
      expect(table, `store ${store} is missing`).toBeDefined()
      const declared = table!.schema.indexes.map(i => i.name)
      for (const index of indexes) {
        expect(declared, `${store} lost its ${index} index`).toContain(index)
      }
    }
  })

  it('keys every store by id, except the two keyed by name', () => {
    // `settings` and `syncMeta` are single-row-per-name stores; everything else is a collection
    // of entities. A store that silently changes primary key loses every existing row.
    for (const table of db.tables) {
      const expected = table.name === 'settings' || table.name === 'syncMeta' ? 'key' : 'id'
      expect(table.schema.primKey.name, `${table.name} primary key`).toBe(expected)
    }
  })

  it('does not index a blob', () => {
    // IndexedDB cannot, and asking it to makes the store unopenable rather than slow.
    const attachments = db.tables.find(t => t.name === 'attachments')!
    expect(attachments.schema.indexes.map(i => i.name)).not.toContain('blob')
  })
})
