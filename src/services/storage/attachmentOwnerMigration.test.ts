import { describe, expect, it } from 'vitest'
import { stampAttachmentOwner } from './db'

/**
 * The `version(3)` migration: captured media that predates `createdByUserId`.
 *
 * <h2>Why it exists at all</h2>
 *
 * Reading an unstamped row falls back to "it belongs to whoever is signed in" — the same rule
 * `isNfcFaultReportOutboundOwnedByUser` uses, and the right default, because refusing would
 * strand photographs and voice notes of work that cannot be repeated.
 *
 * <p>But that fallback is **exactly wrong** for the case the owner field was added to fix: a
 * colleague's media already sitting on the tablet when the app updates. Without a backfill, the
 * first reassignment after the upgrade hands it over just as before, and the fix looks like it
 * does nothing. So the rows are stamped once, at upgrade, from the only source of truth
 * available at that moment.
 *
 * <h2>Why the sheet's owner is the right source</h2>
 *
 * Reassignment is precisely what breaks the sheet→media inference, and it has not happened yet
 * for anything still on the device: `reset-draft` runs when the *new* owner's inbox arrives, and
 * until then the sheet still names the operator who captured the files. Taking the answer now is
 * taking it while it is still true.
 */
describe('stamping captured media with its owner', () => {
  const owners = new Map([
    ['local-1', '4'],
    ['local-2', '9']
  ])

  it('takes the owner from the sheet the file was captured on', () => {
    const row = { logSheetLocalId: 'local-1' } as { logSheetLocalId?: string; createdByUserId?: string }

    stampAttachmentOwner(row, owners)

    expect(row.createdByUserId).toBe('4')
  })

  it('keeps each sheet\'s own owner rather than one for the whole device', () => {
    const a = { logSheetLocalId: 'local-1' } as { logSheetLocalId?: string; createdByUserId?: string }
    const b = { logSheetLocalId: 'local-2' } as { logSheetLocalId?: string; createdByUserId?: string }

    stampAttachmentOwner(a, owners)
    stampAttachmentOwner(b, owners)

    expect([a.createdByUserId, b.createdByUserId]).toEqual(['4', '9'])
  })

  /**
   * Never re-stamp. A row that already names its owner holds the honest answer, and the sheet's
   * owner may since have moved to somebody else — which is the entire reason the field exists.
   * Re-stamping would re-introduce the bug on every subsequent upgrade.
   */
  it('never overwrites an owner the row already carries', () => {
    const row = { logSheetLocalId: 'local-1', createdByUserId: '9' }

    stampAttachmentOwner(row, owners)

    expect(row.createdByUserId).toBe('9')
  })

  /**
   * A sheet already purged by the cleanup pass leaves media with nothing to attribute it to.
   * Guessing would be worse than the read-time fallback, which at least errs towards giving the
   * operator in front of the tablet their own evidence back.
   */
  it('leaves a row whose sheet is gone unstamped', () => {
    const row = { logSheetLocalId: 'local-gone' } as { logSheetLocalId?: string; createdByUserId?: string }

    stampAttachmentOwner(row, owners)

    expect(row.createdByUserId).toBeUndefined()
  })

  it('leaves a row with no sheet reference alone', () => {
    const row = {} as { logSheetLocalId?: string; createdByUserId?: string }

    stampAttachmentOwner(row, owners)

    expect(row.createdByUserId).toBeUndefined()
  })

  /** Idempotent, so an upgrade interrupted halfway can simply run again. */
  it('is idempotent', () => {
    const row = { logSheetLocalId: 'local-1' } as { logSheetLocalId?: string; createdByUserId?: string }

    stampAttachmentOwner(row, owners)
    stampAttachmentOwner(row, owners)

    expect(row.createdByUserId).toBe('4')
  })
})
