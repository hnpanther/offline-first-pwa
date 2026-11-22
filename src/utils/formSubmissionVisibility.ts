import type { LocalFormSubmission } from '@/types'
import { toIdString } from '@/utils/ids'

function ownedBySessionUser(
  row: Pick<LocalFormSubmission, 'createdByUserId'>,
  userId: string | null
): boolean {
  if (!userId) return false
  if (!row.createdByUserId) return true
  return row.createdByUserId === userId
}

/**
 * Whether a form submission may appear in this session's list / deep-link.
 *
 * Mirrors panel VIEW + shared-tablet rules:
 * 1. **Author** — only the signed-in operator's rows (shared tablet; outbound twin).
 * 2. **Unit** — `reporterUnitId` or `subjectUnitId` must intersect accessible units.
 *    Cross-unit filing (reporter A → subject B) stays visible when either unit is
 *    accessible; a third unit on the same tablet must not see the row.
 * 3. **Plant-wide** — CAP:SCOPE_PLANT_WIDE skips the unit filter (still author-scoped
 *    on the personal list, matching mobile `GET /api/form-submissions`).
 *
 * Empty accessible set (pre-bootstrap / offline) keeps own rows visible so a draft
 * already on the device is not stranded by a missing unit cache.
 */
export function isFormSubmissionVisibleToSession(
  row: Pick<LocalFormSubmission, 'createdByUserId' | 'reporterUnitId' | 'subjectUnitId'>,
  opts: {
    userId: string | null
    accessibleUnitIds: ReadonlySet<string> | Iterable<string>
    plantWide?: boolean
  }
): boolean {
  if (!ownedBySessionUser(row, opts.userId)) return false
  if (opts.plantWide) return true

  const units =
    opts.accessibleUnitIds instanceof Set
      ? opts.accessibleUnitIds
      : new Set([...opts.accessibleUnitIds].map(id => toIdString(id)).filter(Boolean))

  if (units.size === 0) return true

  const reporter = toIdString(row.reporterUnitId)
  const subject = toIdString(row.subjectUnitId)
  return (!!reporter && units.has(reporter)) || (!!subject && units.has(subject))
}

/** Pure unit intersection — no author check. */
export function isFormSubmissionInAccessibleUnits(
  row: Pick<LocalFormSubmission, 'reporterUnitId' | 'subjectUnitId'>,
  accessibleUnitIds: ReadonlySet<string> | Iterable<string>,
  plantWide = false
): boolean {
  if (plantWide) return true
  const units =
    accessibleUnitIds instanceof Set
      ? accessibleUnitIds
      : new Set([...accessibleUnitIds].map(id => toIdString(id)).filter(Boolean))
  if (units.size === 0) return true
  const reporter = toIdString(row.reporterUnitId)
  const subject = toIdString(row.subjectUnitId)
  return (!!reporter && units.has(reporter)) || (!!subject && units.has(subject))
}
