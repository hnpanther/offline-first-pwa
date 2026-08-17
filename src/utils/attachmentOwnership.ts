import { isRevokedAssignment, isSupersededSyncError } from '@/utils/logSheetStatus'
import { resolveLocalWorkOwner } from '@/utils/logSheetLocalData'
import type { LogSheet } from '@/types'

/**
 * Whether the signed-in operator may send an attachment belonging to this log sheet.
 *
 * **Tablets are shared, and captured media is not.** The log-sheet queue has always filtered by
 * owner (`isLogSheetOutboundOwnedByUser`); the attachment queue did not, and that asymmetry was
 * a live defect. The sequence: operator 1 works offline, photographs the equipment, signs out
 * still offline — a sign-out only removes the session key, so their rows stay on the device by
 * design. Operator 2, from a different unit, signs in and comes online. The attachment pass
 * picked up *every* pending row on the device, operator 1's included, and pushed them under
 * operator 2's token. The server refused each one with **403** ("دسترسی به این لاگ شیت مجاز
 * نیست") — correctly, since operator 2 has no access to that unit's sheets.
 *
 * The refusal was then read as a permanent one, so operator 1's photographs, voice notes and
 * video were **parked for good**: when they signed back in, the queue no longer returned them.
 * Evidence of work that cannot be repeated was lost to somebody else picking up the tablet.
 *
 * Three things make this predicate the right shape:
 *
 * - **Unprovable ownership is a refusal.** No sheet row, or a sheet nobody owns, returns false.
 *   Uploading on a guess is what caused the bug; declining costs a delay until the owner signs
 *   in, and the file stays on the device meanwhile.
 * - **A synced sheet is not exempt.** `isolateSheetsNotOwnedBy` blocks another user's *unsynced*
 *   sheets on login but deliberately leaves synced ones alone — and a synced sheet whose photos
 *   are still queued is exactly the case that leaked. Ownership has to be judged here, not
 *   inferred from the sheet's sync state.
 * - **A sheet the operator has lost is excluded.** Once a sheet is revoked or superseded the
 *   server will refuse its files however long the queue retries, so a row that would loop
 *   forever is left alone instead.
 */
export function isAttachmentUploadableByUser(
  sheet: LogSheet | undefined,
  userId: string | null
): boolean {
  if (!userId || !sheet) return false

  const owner = resolveLocalWorkOwner(sheet)
  if (!owner || owner !== userId) return false

  // Ownership says whose work it is; these two say whether the server will still take it.
  if (isRevokedAssignment(sheet)) return false
  if (isSupersededSyncError(sheet)) return false

  return true
}

/**
 * Whether a parked attachment should be given back to the queue when its owner signs in.
 *
 * Mirrors `reviveOwnedSubmittedQueueOnLogin` for log sheets: a device-side block is not a server
 * decision, and it must not outlive the situation that caused it.
 *
 * Which parked rows qualify is decided by the **status the server actually answered with**:
 *
 * - **403** — "the session that asked may not touch this sheet". That is a statement about who
 *   was holding the tablet, not about the file, and it stops being true the moment the owner
 *   returns. Exactly the reasoning that already excludes 409 ("this field is full") from being
 *   permanent.
 * - **no recorded status** — a row parked by a build that predates this field. Every tablet in
 *   the field has some, and they are precisely the rows this defect stranded, so they are given
 *   one more chance. A file the server genuinely rejects is re-parked on the next pass at a cost
 *   of one request.
 * - **anything else** (400, 404, 422 …) — the server examined the file and refused it. Retrying
 *   identical bytes earns an identical refusal, so the row stays parked with its reason on
 *   screen and the manual retry button as the way back.
 */
export function shouldReviveParkedAttachment(failedStatus: number | undefined): boolean {
  if (failedStatus === undefined) return true
  return failedStatus === 403
}
