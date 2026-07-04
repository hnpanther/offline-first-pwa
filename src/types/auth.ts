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

export function isSessionValid(session: AuthSession | null): boolean {
  if (!session?.accessToken) return false
  return Date.now() < session.expiresAt - 60_000
}

export function isAdminRole(roles: string[]): boolean {
  return roles.some(r => r === 'ADMIN' || r === 'HIGH_USER')
}

export function hasPermission(session: AuthSession | null, perm: string): boolean {
  return session?.permissions.includes(perm) ?? false
}

/** Manual tag entry: global setting, or supervisor / senior operator roles. */
export function canEnterTagManually(roles: string[], settingsEnabled: boolean): boolean {
  if (settingsEnabled) return true
  return roles.some(r => r === 'SUPERVISOR' || r === 'SENIOR_OPERATOR')
}
