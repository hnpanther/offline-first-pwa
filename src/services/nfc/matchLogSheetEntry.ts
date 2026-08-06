import type { LogSheetEntryData } from '@/types'

/**
 * Matching a scanned NFC tag against the assets of one log sheet.
 *
 * Two modes, chosen by the `nfcStrictSerialMatch` app setting:
 *
 *  - **default (off)** — only Record 1 is checked. The NDEF payload resolves to a
 *    tag id and that id must belong to an asset in this log sheet. This is the
 *    behaviour the app has always had and it must stay bit-for-bit identical.
 *  - **strict (on)** — Record 1 *and* the physical chip serial must both agree
 *    (AND). A tag whose payload matches but whose hardware UID does not is
 *    rejected, and so is an asset that has no serial recorded on the server —
 *    strict mode cannot verify what was never stored, and silently falling back
 *    to Record 1 would defeat the point of turning it on.
 *
 * Strict mode applies to real NFC scans only. Manual tag-id entry and the
 * NFC-fault fallback never carry a hardware serial, so they keep using the
 * default path.
 */

export type NfcMatchOutcome =
  /** Record 1 (and, in strict mode, the serial) identified an asset in this sheet. */
  | { kind: 'matched'; entry: LogSheetEntryData }
  /** No asset in this log sheet carries that tag id. */
  | { kind: 'notInSheet' }
  /** Strict mode: the asset was found but has no chip serial recorded to verify against. */
  | { kind: 'serialMissing'; entry: LogSheetEntryData }
  /** Strict mode: the asset was found but this is a different physical chip. */
  | { kind: 'serialMismatch'; entry: LogSheetEntryData }

/**
 * Canonical form of a chip serial for comparison.
 *
 * Serials reach us from two places that format them differently: the Web NFC
 * reader (`04:33:26:92:d0:12:91`, lower case, colon separated) and an admin
 * typing into the asset form (any case, `:`/`-`/space separated, or none). Only
 * the hex digits are meaningful, so compare on those.
 */
function normalizeSerial(serial: string | null | undefined): string {
  return (serial ?? '').toLowerCase().replace(/[\s:-]/g, '')
}

export function matchLogSheetEntryByTag(
  entries: LogSheetEntryData[],
  tagId: string,
  options: { strictSerial?: boolean; scannedSerial?: string | null } = {}
): NfcMatchOutcome {
  const needle = tagId.trim()
  if (!needle) return { kind: 'notInSheet' }

  const entry = entries.find(e => e.nfcTagId?.trim() === needle)
  if (!entry) return { kind: 'notInSheet' }

  if (!options.strictSerial) return { kind: 'matched', entry }

  const stored = normalizeSerial(entry.nfcSerial)
  if (!stored) return { kind: 'serialMissing', entry }

  const scanned = normalizeSerial(options.scannedSerial)
  // No serial off the chip is a failed verification, not a reason to fall back.
  if (!scanned || scanned !== stored) return { kind: 'serialMismatch', entry }

  return { kind: 'matched', entry }
}
