import { db } from '@/services/storage/db'
import type { AuthSession, LoginResponse } from '@/types/auth'
import { isSessionValid } from '@/types/auth'

const AUTH_KEY = 'authSession'

export async function getAuthSession(): Promise<AuthSession | null> {
  const row = await db.syncMeta.get(AUTH_KEY)
  const value = row?.value as AuthSession | undefined
  if (!value || !isSessionValid(value)) return null
  return value
}

export async function saveAuthSession(response: LoginResponse): Promise<AuthSession> {
  const session: AuthSession = {
    accessToken: response.accessToken,
    tokenType: response.tokenType,
    expiresAt: response.expiresAt,
    username: response.username,
    fullName: response.fullName,
    roles: response.roles,
    permissions: response.permissions
  }
  await db.syncMeta.put({ key: AUTH_KEY, value: session })
  return session
}

export async function clearAuthSession(): Promise<void> {
  await db.syncMeta.delete(AUTH_KEY)
}

export async function getAccessToken(): Promise<string | null> {
  const session = await getAuthSession()
  return session?.accessToken ?? null
}
