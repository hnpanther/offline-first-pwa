import { useAppStore } from '@/store'

export interface AuthSession {
  accessToken: string
  tokenType: string
  expiresAt: number
  username: string
  fullName: string
  /**
   * Role codes, as the server reports them. Kept because the login response carries them and
   * they are useful to display — but **nothing here decides access from them**. See below.
   */
  roles: string[]
  /**
   * Every authority the user holds: endpoint permissions (`METHOD:/path`) and capabilities
   * (`CAP:…`). The server builds this from the full authority set, so capabilities arrive
   * without any change to the API.
   */
  permissions: string[]
}

export interface LoginRequest {
  username: string
  password: string
}

export interface LoginResponse {
  username: string
  fullName: string
  roles: string[]
  permissions: string[]
  accessToken: string
  tokenType: string
  expiresAt: number
}

export function isSessionValid(
  session: AuthSession | null,
  now = Date.now(),
  serverReachable: boolean | null = useAppStore.getState().serverReachable
): boolean {
  if (!session?.accessToken) return false
  if (!navigator.onLine) return true
  // Until server is confirmed reachable, keep local session (offline / host down).
  if (serverReachable !== true) return true
  return now < session.expiresAt - 60_000
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Why there are no role checks in this file any more
 *
 * These used to be `isAdminRole(roles) = roles.includes('ADMIN') || roles.includes('HIGH_USER')`
 * and friends. That made roles un-copyable in exactly the way the server had the same problem:
 * duplicating a role copies its permissions and gives the copy a NEW CODE, so a copy of ADMIN
 * held every permission and still saw no admin menu, could not open the NFC inspector, and got
 * the restricted dashboard. The server would have accepted every one of those calls.
 *
 * Each check below uses a permission whose grant set is **identical** to the role test it
 * replaced, so nothing changes for the five system roles — and a duplicated role now behaves
 * like its original.
 *
 *   isAdminRole      ADMIN, HIGH_USER              → CAP:SCOPE_PLANT_WIDE / nfc-serial write
 *   isSupervisorRole ADMIN, HIGH_USER, SUPERVISOR  → POST:/api/log-sheets/{id}/assign
 *
 * This is UI gating only; the server remains authoritative. Hiding a control the server would
 * allow is a bug of the same family as showing one it would refuse — both mislead the operator.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Sees plant-wide data rather than only their own units. Granted to ADMIN and HIGH_USER. */
export const CAP_SCOPE_PLANT_WIDE = 'CAP:SCOPE_PLANT_WIDE'

/** Binding a physical chip to an asset — the NFC inspector. ADMIN and HIGH_USER. */
const PERM_NFC_SERIAL_WRITE = 'POST:/api/asset-entries/{id}/nfc-serial'

/** Handing work to somebody else. ADMIN, HIGH_USER, SUPERVISOR. */
const PERM_ASSIGN_WORK = 'POST:/api/log-sheets/{id}/assign'

/** Filling a sheet in the browser. ADMIN, HIGH_USER, SUPERVISOR, SENIOR_OPERATOR. */
const PERM_WEB_FILL = 'GET:/log-sheets/{id}/fill'

/** Reporting a tag that would not scan. Every field role. */
export const PERM_NFC_FAULT_REPORT = 'POST:/api/nfc-fault-reports/batch'

export function hasPermission(session: AuthSession | null, perm: string): boolean {
  return session?.permissions.includes(perm) ?? false
}

/**
 * Whether this user's view spans the whole plant rather than their own units.
 *
 * Drives the device-wide dashboard totals and the site-wide policy switch in Settings — the
 * places that used to ask `isAdminRole`.
 */
export function hasPlantWideScope(session: AuthSession | null): boolean {
  return hasPermission(session, CAP_SCOPE_PLANT_WIDE)
}

/** May open the NFC inspector and write a chip binding. */
export function canManageNfcSerial(session: AuthSession | null): boolean {
  return hasPermission(session, PERM_NFC_SERIAL_WRITE)
}

/** May assign or reassign a sheet to another operator, and see the team's open work. */
export function canAssignWork(session: AuthSession | null): boolean {
  return hasPermission(session, PERM_ASSIGN_WORK)
}

/**
 * Manual tag entry: the right to fill a sheet without standing at the equipment.
 *
 * **Permission, and nothing else.** Two earlier gates were removed on purpose. A hardcoded
 * `SUPERVISOR || SENIOR_OPERATOR` branch went first: every role holding either also holds
 * `GET:/log-sheets/{id}/fill`, and keying the rule to a role *name* meant a duplicated role
 * did not inherit it. Then the device-level `allowManualEntry` switch went too — it let anyone
 * who could reach a tablet's Settings screen hand every operator on that tablet the ability to
 * type a tag instead of scanning one, which is the entire point of the NFC step. Who may skip
 * a scan is an access-control decision, so access control is what answers it.
 *
 * Unrelated to the NFC-fault fallback, which unlocks one asset after a report is filed and is
 * gated by its own permission.
 */
export function canEnterTagManually(session: AuthSession | null): boolean {
  return hasPermission(session, PERM_WEB_FILL)
}
