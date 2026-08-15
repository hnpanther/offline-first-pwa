import { describe, expect, it } from 'vitest'
import {
  CAP_SCOPE_PLANT_WIDE,
  PERM_NFC_FAULT_REPORT,
  canAssignWork,
  canEnterTagManually,
  canManageNfcSerial,
  hasPermission,
  hasPlantWideScope,
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
  it('is open to everyone when the site-wide setting allows it', () => {
    // Deliberately independent of who you are: the switch is a site policy.
    expect(canEnterTagManually(session(OPERATOR_PERMISSIONS, ['OPERATOR']), true)).toBe(true)
    expect(canEnterTagManually(null, true)).toBe(true)
  })

  it('otherwise follows the web-fill permission', () => {
    expect(canEnterTagManually(session(SUPERVISOR_PERMISSIONS, ['SUPERVISOR']), false)).toBe(true)
    expect(canEnterTagManually(session(SENIOR_OPERATOR_PERMISSIONS, ['SENIOR_OPERATOR']), false)).toBe(true)
    expect(canEnterTagManually(session(OPERATOR_PERMISSIONS, ['OPERATOR']), false)).toBe(false)
  })

  it('still covers admin and high user, who reached it through the permission before too', () => {
    // The dropped `SUPERVISOR || SENIOR_OPERATOR` branch was redundant, not load-bearing.
    expect(canEnterTagManually(session(ADMIN_PERMISSIONS, ['ADMIN']), false)).toBe(true)
    expect(canEnterTagManually(session(HIGH_USER_PERMISSIONS, ['HIGH_USER']), false)).toBe(true)
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
