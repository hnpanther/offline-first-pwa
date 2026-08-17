import { describe, expect, it } from 'vitest'
import {
  CAP_SCOPE_PLANT_WIDE,
  PERM_NFC_FAULT_REPORT,
  canAssignWork,
  canEnterTagManually,
  canManageNfcSerial,
  hasPermission,
  hasPlantWideScope,
  isManualTagEntryAllowed,
  type AuthSession
} from './auth'

/**
 * These gates must follow what a user MAY DO, never what their role is CALLED.
 *
 * The checks here used to read `roles.includes('ADMIN')`. Duplicating a role copies its
 * permissions and gives the copy a new code, so a copy of ADMIN held every permission and
 * still got the restricted UI — no admin menu, no NFC inspector, the narrow dashboard — while
 * the server would have accepted all of it. The suite below pins both halves: the seeded roles
 * behave exactly as before, and a copy behaves like its original.
 */

/** The authorities the server actually ships for each seeded role, abridged to what the UI reads. */
const ADMIN_PERMISSIONS = [
  CAP_SCOPE_PLANT_WIDE,
  'POST:/api/asset-entries/{id}/nfc-serial',
  'POST:/api/log-sheets/{id}/assign',
  'GET:/log-sheets/{id}/fill',
  PERM_NFC_FAULT_REPORT
]
const HIGH_USER_PERMISSIONS = ADMIN_PERMISSIONS
const SUPERVISOR_PERMISSIONS = [
  'POST:/api/log-sheets/{id}/assign',
  'GET:/log-sheets/{id}/fill',
  PERM_NFC_FAULT_REPORT
]
const SENIOR_OPERATOR_PERMISSIONS = ['GET:/log-sheets/{id}/fill', PERM_NFC_FAULT_REPORT]
const OPERATOR_PERMISSIONS = [PERM_NFC_FAULT_REPORT]

function session(permissions: string[], roles: string[] = ['SOME_ROLE']): AuthSession {
  return {
    accessToken: 'token',
    tokenType: 'Bearer',
    expiresAt: Date.now() + 60_000,
    username: 'u',
    fullName: 'U',
    roles,
    permissions
  }
}

describe('plant-wide scope', () => {
  it('is held by admin and high user', () => {
    expect(hasPlantWideScope(session(ADMIN_PERMISSIONS, ['ADMIN']))).toBe(true)
    expect(hasPlantWideScope(session(HIGH_USER_PERMISSIONS, ['HIGH_USER']))).toBe(true)
  })

  it('is not held by supervisors or operators', () => {
    expect(hasPlantWideScope(session(SUPERVISOR_PERMISSIONS, ['SUPERVISOR']))).toBe(false)
    expect(hasPlantWideScope(session(OPERATOR_PERMISSIONS, ['OPERATOR']))).toBe(false)
  })

  it('follows the capability even when the role is called something else', () => {
    // The regression this whole change exists for.
    const copyOfAdmin = session(ADMIN_PERMISSIONS, ['ZZCOPY-ADMIN'])
    expect(hasPlantWideScope(copyOfAdmin)).toBe(true)
  })

  it('is denied to a role merely NAMED admin without the capability', () => {
    // The mirror image: the name proves nothing in either direction.
    expect(hasPlantWideScope(session([], ['ADMIN']))).toBe(false)
  })
})

describe('nfc serial management', () => {
  it('matches the roles that used to pass isAdminRole', () => {
    expect(canManageNfcSerial(session(ADMIN_PERMISSIONS, ['ADMIN']))).toBe(true)
    expect(canManageNfcSerial(session(HIGH_USER_PERMISSIONS, ['HIGH_USER']))).toBe(true)
    expect(canManageNfcSerial(session(SUPERVISOR_PERMISSIONS, ['SUPERVISOR']))).toBe(false)
    expect(canManageNfcSerial(session(OPERATOR_PERMISSIONS, ['OPERATOR']))).toBe(false)
  })
})

describe('assigning work', () => {
  it('matches the roles that used to pass isSupervisorRole', () => {
    expect(canAssignWork(session(ADMIN_PERMISSIONS, ['ADMIN']))).toBe(true)
    expect(canAssignWork(session(HIGH_USER_PERMISSIONS, ['HIGH_USER']))).toBe(true)
    expect(canAssignWork(session(SUPERVISOR_PERMISSIONS, ['SUPERVISOR']))).toBe(true)
    expect(canAssignWork(session(SENIOR_OPERATOR_PERMISSIONS, ['SENIOR_OPERATOR']))).toBe(false)
    expect(canAssignWork(session(OPERATOR_PERMISSIONS, ['OPERATOR']))).toBe(false)
  })

  it('is inherited by a duplicated supervisor role', () => {
    expect(canAssignWork(session(SUPERVISOR_PERMISSIONS, ['ZZCOPY-SUPERVISOR']))).toBe(true)
  })
})

describe('manual tag entry', () => {
  it('follows the web-fill permission and nothing else', () => {
    expect(canEnterTagManually(session(SUPERVISOR_PERMISSIONS, ['SUPERVISOR']))).toBe(true)
    expect(canEnterTagManually(session(SENIOR_OPERATOR_PERMISSIONS, ['SENIOR_OPERATOR']))).toBe(true)
    expect(canEnterTagManually(session(OPERATOR_PERMISSIONS, ['OPERATOR']))).toBe(false)
  })

  it('covers admin and high user, who reach it through the same permission', () => {
    // The dropped `SUPERVISOR || SENIOR_OPERATOR` branch was redundant, not load-bearing.
    expect(canEnterTagManually(session(ADMIN_PERMISSIONS, ['ADMIN']))).toBe(true)
    expect(canEnterTagManually(session(HIGH_USER_PERMISSIONS, ['HIGH_USER']))).toBe(true)
  })

  it('is false without a session rather than throwing', () => {
    expect(canEnterTagManually(null)).toBe(false)
  })

  it('cannot be granted by a device setting any more', () => {
    // Regression guard for the switch that used to sit on the tablet's Settings screen: it
    // returned true for *every* caller, so anyone who could open that screen could hand every
    // operator on that tablet the ability to type a tag instead of scanning one — which is the
    // entire point of the NFC step. The signature no longer accepts such an override, and this
    // pins that an extra argument cannot resurrect it.
    const asLegacyCaller = canEnterTagManually as unknown as (
      s: ReturnType<typeof session> | null,
      settingEnabled: boolean
    ) => boolean

    expect(asLegacyCaller(session(OPERATOR_PERMISSIONS, ['OPERATOR']), true)).toBe(false)
    expect(asLegacyCaller(null, true)).toBe(false)
  })

  it('is inherited by a duplicated role, because it keys off the permission', () => {
    expect(canEnterTagManually(session(SUPERVISOR_PERMISSIONS, ['ZZCOPY-SUPERVISOR']))).toBe(true)
  })
})

describe('hasPermission', () => {
  it('is false for a missing session rather than throwing', () => {
    // Called during startup before login resolves.
    expect(hasPermission(null, CAP_SCOPE_PLANT_WIDE)).toBe(false)
  })

  it('does not match on a prefix', () => {
    expect(hasPermission(session(['CAP:SCOPE_PLANT_WIDE_EXTRA']), CAP_SCOPE_PLANT_WIDE)).toBe(false)
  })
})

/**
 * Typing a tag id instead of scanning it, now gated twice.
 *
 * A supervisor or senior operator holds the permission. Above it sits a **site policy** the
 * server owns and bootstrap delivers, and the two are an **AND**: with the policy off nobody
 * types a tag, however privileged — the asset is scanned, or opened through an NFC fault report.
 *
 * The direction is the whole point. The device switch this replaces did the opposite: it
 * *granted* manual entry to every caller, so anyone who could reach the tablet's Settings screen
 * could let a whole shift type tags instead of walking to the equipment. These cases exist to
 * stop it drifting back into an OR.
 */
describe('isManualTagEntryAllowed', () => {
  const supervisor: AuthSession = {
    accessToken: 't',
    username: 'sup',
    roles: ['SUPERVISOR'],
    permissions: ['GET:/log-sheets/{id}/fill']
  } as AuthSession
  const operator: AuthSession = {
    accessToken: 't',
    username: 'op',
    roles: ['OPERATOR'],
    permissions: []
  } as AuthSession

  it('allows a permitted operator while the plant allows it', () => {
    expect(isManualTagEntryAllowed(supervisor, true)).toBe(true)
  })

  it('refuses the same operator once the plant turns it off', () => {
    // The requirement in one line: the permission is not enough on its own.
    expect(isManualTagEntryAllowed(supervisor, false)).toBe(false)
  })

  it('never grants it to somebody without the permission, policy on or off', () => {
    expect(isManualTagEntryAllowed(operator, true)).toBe(false)
    expect(isManualTagEntryAllowed(operator, false)).toBe(false)
  })

  it('refuses when there is no session at all', () => {
    expect(isManualTagEntryAllowed(null, true)).toBe(false)
  })

  it('leaves the permission check itself unchanged', () => {
    // `canEnterTagManually` still answers only "is this person trusted with it", which is what
    // the rest of the app and its own regression cases rely on.
    expect(canEnterTagManually(supervisor)).toBe(true)
    expect(canEnterTagManually(operator)).toBe(false)
  })
})
