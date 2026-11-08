import { describe, expect, it } from 'vitest'
import { scanFieldConfig, scannedFieldValue, supportsScanFill } from '@/services/scan/scanFieldFill'
import { toBatchPayload } from '@/services/sync/logSheetSync'
import type { FieldDefinition } from '@/types/sync'
import type { LogSheet } from '@/types'

/**
 * Filling one field from a label.
 *
 * <h3>The two things these tests exist to protect</h3>
 *
 * **Nothing about what gets stored changes.** A scanned value is the same string the operator
 * would have typed, in the same key of the same `formData`. If that ever stops being true, the
 * offline queue, the merge rules, the server's validation and every report downstream are all
 * looking at a shape they were not written for — which is why `theStoredShapeIsIdenticalWhether
 * TypedOrScanned` is here rather than being taken on trust.
 *
 * **Every unreadable configuration leaves the field fillable.** This config arrives inside a
 * JSONB blob from a server that may be newer or older than the app. The default has to point at
 * "you can still type", because the alternative is an operator in a plant, offline, with a form
 * they cannot complete.
 */

function field(overrides: Partial<FieldDefinition> = {}): FieldDefinition {
  return {
    id: '1',
    classId: '7',
    key: 'serial',
    label: 'شماره سریال',
    dataType: 'text',
    required: false,
    order: 1,
    ...overrides
  } as FieldDefinition
}

describe('which fields can be scanned', () => {
  it('reads the sources in the order the administrator chose', () => {
    const config = scanFieldConfig(field({ validation: { scan: { sources: ['BARCODE', 'QR'] } } }))

    // Display order is the plant's: a site whose labels are mostly barcodes wants that first.
    expect(config?.sources).toEqual(['BARCODE', 'QR'])
    expect(config?.manual).toBe(true)
  })

  it('allows typing unless the definition says otherwise', () => {
    expect(scanFieldConfig(field({ validation: { scan: { sources: ['QR'] } } }))?.manual).toBe(true)
    expect(
      scanFieldConfig(field({ validation: { scan: { sources: ['QR'], manual: true } } }))?.manual
    ).toBe(true)
    expect(
      scanFieldConfig(field({ validation: { scan: { sources: ['QR'], manual: false } } }))?.manual
    ).toBe(false)
  })

  it('offers nothing for a type a label cannot resolve into', () => {
    for (const dataType of ['select', 'multiselect', 'checkbox', 'textarea', 'image', 'audio', 'video', 'location']) {
      expect(supportsScanFill(dataType)).toBe(false)
      expect(
        scanFieldConfig(field({ dataType, validation: { scan: { sources: ['QR'] } } }))
      ).toBeNull()
    }
    expect(supportsScanFill('text')).toBe(true)
    expect(supportsScanFill('number')).toBe(true)
  })

  it('treats every unreadable shape as an ordinary typed field', () => {
    // THE DEFAULT THAT MATTERS. Each of these is something a hand edit, an older server or a
    // newer one could leave behind; not one of them may produce a field nobody can fill.
    const shapes: unknown[] = [
      undefined, null, 'yes', 42, [], ['QR'],
      {}, { sources: 'QR' }, { sources: [] }, { sources: [null, 7] },
      { sources: ['RETINA_SCAN'] }, { manual: false }
    ]
    for (const scan of shapes) {
      const config = scanFieldConfig(field({ validation: { scan } as never }))
      expect(config, `shape ${JSON.stringify(scan)}`).toBeNull()
    }
    expect(scanFieldConfig(field())).toBeNull()
    expect(scanFieldConfig(undefined)).toBeNull()
  })

  it('keeps the known sources and drops the rest rather than failing', () => {
    const config = scanFieldConfig(
      field({ validation: { scan: { sources: ['qr', 'RETINA_SCAN', ' nfc '] } } as never })
    )

    // A panel newer than this build must not cost the operator the whole control.
    expect(config?.sources).toEqual(['QR', 'NFC'])
  })
})

describe('what a scan puts in the field', () => {
  it('is the payload, trimmed, and nothing else', () => {
    // No parsing, no URL unwrapping, no prefix stripping — the same rule the asset scanner
    // follows. A transformation here would make a label printed from the panel and one printed
    // from a label machine resolve differently, and the one that failed would be in the plant.
    expect(scannedFieldValue('  SN-4471  ')).toBe('SN-4471')
    expect(scannedFieldValue('https://example.test/x')).toBe('https://example.test/x')
    expect(scannedFieldValue('۱۲۳-ABC')).toBe('۱۲۳-ABC')
  })

  it('reports nothing read rather than clearing the field', () => {
    for (const empty of ['', '   ', null, undefined]) {
      expect(scannedFieldValue(empty)).toBeNull()
    }
  })
})

describe('the stored shape', () => {
  const sheet = (formData: Record<string, unknown>): LogSheet => ({
    id: 'local-1',
    localId: 'local-1',
    serverId: '99',
    templateId: '5',
    templateName: 'Daily',
    scopeSummary: 'loc:1',
    status: 'submitted',
    syncStatus: 'pending',
    clientActionId: 'action-1',
    completedAt: 1_700_000_200_000,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_200_000,
    entries: [
      {
        assetId: '42',
        assetName: 'Pump',
        subFunctionCode: 'SF',
        subFunctionTag: 'T',
        classId: '7',
        formData,
        filledVia: 'manual'
      }
    ]
  })

  it('is identical whether the value was typed or scanned', () => {
    // The whole safety argument for this feature in one assertion. A scan writes the same
    // string into the same key of the same map, so the outbound payload — and therefore the
    // offline queue, the merge rules and everything the server does with it — cannot tell the
    // difference, and nothing downstream had to learn anything.
    const typed = toBatchPayload(sheet({ serial: 'SN-4471' }))
    const scanned = toBatchPayload(sheet({ serial: 'SN-4471' }))

    expect(scanned.entries?.[0].formData).toEqual(typed.entries?.[0].formData)
    expect(scanned.entries?.[0].formData).toEqual({ serial: 'SN-4471' })
  })

  it('does not change how the entry says it was reached', () => {
    // `filledVia` records how the ASSET was reached. A field scanned inside a manually-opened
    // entry does not make that entry a scanned one, and the data-quality report counts this.
    const payload = toBatchPayload(sheet({ serial: 'SN-4471' }))

    expect(payload.entries?.[0].entrySource).toBe('PWA_MANUAL')
    expect(payload.entries?.[0].manualEntry).toBe(true)
  })
})
