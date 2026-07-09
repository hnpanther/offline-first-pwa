import { useAppStore } from '@/store'

export interface AuthSession {
  accessToken: string
  tokenType: string
  expiresAt: number
  username: string
  fullName: string
  roles: string[]
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

export function isAdminRole(roles: string[]): boolean {
  return roles.some(r => r === 'ADMIN' || r === 'HIGH_USER')
}

export function isSupervisorRole(roles: string[]): boolean {
  return roles.some(r => r === 'SUPERVISOR' || r === 'ADMIN' || r === 'HIGH_USER')
}

export function hasPermission(session: AuthSession | null, perm: string): boolean {
  return session?.permissions.includes(perm) ?? false
}

function normalizeRoleCode(role: string): string {
  return role.trim().replace(/^ROLE_/i, '').toUpperCase()
}

export function hasRoleCode(roles: string[], code: string): boolean {
  const target = normalizeRoleCode(code)
  return roles.some(r => normalizeRoleCode(r) === target)
}

export function isSeniorOperatorRole(roles: string[]): boolean {
  return hasRoleCode(roles, 'SENIOR_OPERATOR')
}

/** Web log-sheet fill — granted to senior operators, not plain operators. */
const SENIOR_OPERATOR_FILL_PERMISSION = 'GET:/log-sheets/{id}/fill'

/** Manual tag entry: global setting, supervisor / senior operator roles, or senior fill permission. */
export function canEnterTagManually(
  roles: string[],
  settingsEnabled: boolean,
  permissions: string[] = []
): boolean {
  if (settingsEnabled) return true
  if (hasRoleCode(roles, 'SUPERVISOR') || isSeniorOperatorRole(roles)) return true
  return permissions.includes(SENIOR_OPERATOR_FILL_PERMISSION)
}
