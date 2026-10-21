import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/services/storage/db'
import { getLogSheetByServerId } from '@/services/storage'
import { applyLogSheetBundle } from '@/services/sync/logSheetSync'
import { sheetFieldDefinitions } from '@/utils/sheetFieldDefinitions'
import type { LogSheetBundleDto } from '@/services/api'
import type { FieldDefinition } from '@/types/sync'

/**
 * The per-asset band delta, from the bundle to the form the operator sees.
 *
 * The server has always sent `fieldOverridesSnapshot` — it is a column on the sheet entity and
 * the bundle serialises that entity whole — but `applyLogSheetBundle` copies the stored record
 * together field by field, and this one was never in the list. It therefore never reached
 * IndexedDB, `sheetFieldDefinitions` read `undefined` on every sheet, and the tablet drew every
 * asset against its class's bands while the server judged it against its own. A re-banded pump
 * looked fine to the operator and came back DANGER.
 *
 * Resolving per asset is not enough on its own, which is why the last case here asserts the
 * band and not merely the presence of the key: the two halves fail independently and the
 * symptom is identical.
 */

const SERVER_ID = '91'
const CLASS_ID = 7
const ASSET_ID = 11

function ampere(): FieldDefinition {
  return {
    id: 'fd-1',
    classId: String(CLASS_ID),
    key: 'ampere',
    label: 'آمپر',
    dataType: 'number',
    required: false,
    order: 0,
    validation: { warning: { min: 0, max: 100 }, danger: { min: 0, max: 120 } }
  } as FieldDefinition
}

function bundle(overrides?: Record<string, unknown> | null): LogSheetBundleDto {
  return {
    sheet: {
      id: Number(SERVER_ID),
      templateId: 3,
      templateName: 'راند روزانه',
      scopeSummary: 'سالن ۱',
      status: 'IN_PROGRESS',
      assigneeUserId: 7,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_900_000,
      ...(overrides === undefined ? {} : { fieldOverridesSnapshot: overrides })
    },
    entries: [
      {
        assetId: ASSET_ID,
        assetName: 'پمپ ۱',
        subFunctionCode: 'SF-1',
        subFunctionTag: 'TAG-1',
        classId: CLASS_ID,
        formData: {}
      }
    ],
    context: { fieldDefinitions: [ampere()] }
  } as unknown as LogSheetBundleDto
}

// This pump is a small one: the class tolerates 100, it does not.
const SMALL_PUMP = {
  [String(ASSET_ID)]: {
    source: 'RANGES_ONLY',
    fields: { ampere: { warning: { min: 0, max: 25 }, danger: { min: 0, max: 30 } } }
  }
}

describe('the per-asset delta on a synced sheet', () => {
  beforeEach(async () => {
    if (!db.isOpen()) await db.open()
    await db.logSheets.clear()
    await db.syncMeta.clear()
    await db.syncMeta.put({ key: 'sessionUserId', value: 7 })
  })

  it('is stored on a sheet this device has never seen', async () => {
    await applyLogSheetBundle(bundle(SMALL_PUMP))

    const stored = await getLogSheetByServerId(SERVER_ID)
    expect(stored?.fieldOverridesSnapshot).toEqual(SMALL_PUMP)
  })

  it('is stored on a refresh of a sheet the device already holds', async () => {
    await applyLogSheetBundle(bundle(null))
    await applyLogSheetBundle(bundle(SMALL_PUMP))

    const stored = await getLogSheetByServerId(SERVER_ID)
    expect(stored?.fieldOverridesSnapshot).toEqual(SMALL_PUMP)
  })

  it('survives a later bundle that says nothing about overrides', async () => {
    await applyLogSheetBundle(bundle(SMALL_PUMP))
    // An older server build, or a thin refresh. Blanking a working delta because one payload
    // was quiet is the expensive direction to be wrong in; a sheet's snapshot is written once
    // at generation and never cleared.
    await applyLogSheetBundle(bundle(undefined))

    const stored = await getLogSheetByServerId(SERVER_ID)
    expect(stored?.fieldOverridesSnapshot).toEqual(SMALL_PUMP)
  })

  it('reaches the form as THIS asset\'s band, which is the point of storing it', async () => {
    await applyLogSheetBundle(bundle(SMALL_PUMP))
    const stored = await getLogSheetByServerId(SERVER_ID)

    const fields = sheetFieldDefinitions(stored, String(CLASS_ID), [], String(ASSET_ID))

    expect(fields[0].validation?.danger).toEqual({ min: 0, max: 30 })
    // ...and an asset with no delta of its own still gets the class's.
    expect(sheetFieldDefinitions(stored, String(CLASS_ID), [], '99')[0].validation?.danger)
      .toEqual({ min: 0, max: 120 })
  })
})
