import { useCallback, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  peekAuthSession,
  saveAuthSession,
  clearAuthSession
} from '@/services/auth'
import {
  activateUserSession,
  clearUserSessionContext,
  getLastSessionUsername,
  getSessionUserId,
  reviveOwnedSubmittedQueueOnLogin
} from '@/services/auth/sessionContext'
import { login as apiLogin, fetchBootstrap } from '@/services/api'
import { setUnauthorizedHandler } from '@/services/api/client'
import { useAppStore } from '@/store'
import type { AuthSession } from '@/types/auth'
import { isSessionValid } from '@/types/auth'
import { postLoginPath } from '@/utils/loginRedirect'
import { toIdString } from '@/utils/ids'

async function bindSessionUserContext(username: string): Promise<void> {
  const setSessionUserId = useAppStore.getState().setSessionUserId
  let userId: string | null = null
  try {
    const bootstrap = await fetchBootstrap()
    userId = toIdString(bootstrap.userId)
  } catch {
    const lastUsername = await getLastSessionUsername()
    if (lastUsername === username) {
      userId = await getSessionUserId()
    }
  }
  await activateUserSession(username, userId)
  if (userId) setSessionUserId(userId)
}

export function useAuthInit(): void {
  const setAuthSession = useAppStore(s => s.setAuthSession)
  const setAuthLoaded = useAppStore(s => s.setAuthLoaded)
  const setSessionUserId = useAppStore(s => s.setSessionUserId)
  const clearInbox = useAppStore(s => s.clearInbox)
  const navigate = useNavigate()
  const location = useLocation()

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const session = await peekAuthSession()
      if (cancelled) return
      setAuthSession(session)
      if (session) {
        const lastUsername = await getLastSessionUsername()
        if (lastUsername === session.username) {
          const userId = await getSessionUserId()
          if (userId) {
            await reviveOwnedSubmittedQueueOnLogin(userId)
          }
          setSessionUserId(userId)
        }
      } else {
        setSessionUserId(null)
      }
      setAuthLoaded(true)
      if (session && location.pathname === '/login') {
        navigate(postLoginPath(), { replace: true })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [setAuthSession, setAuthLoaded, setSessionUserId, navigate, location.pathname])

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setAuthSession(null)
      setSessionUserId(null)
      clearInbox()
      void clearUserSessionContext()
      navigate('/login', { replace: true })
    })
    return () => setUnauthorizedHandler(null)
  }, [navigate, setAuthSession, setSessionUserId, clearInbox])
}

export function useAuth() {
  const authSession = useAppStore(s => s.authSession)
  const authLoaded = useAppStore(s => s.authLoaded)
  const setAuthSession = useAppStore(s => s.setAuthSession)
  const setSessionUserId = useAppStore(s => s.setSessionUserId)
  const clearInbox = useAppStore(s => s.clearInbox)
  const navigate = useNavigate()

  const signIn = useCallback(
    async (username: string, password: string): Promise<string | null> => {
      try {
        const response = await apiLogin({ username, password })
        const session = await saveAuthSession(response)
        await bindSessionUserContext(response.username)
        setAuthSession(session)
        return null
      } catch (err) {
        if (err instanceof Error) return err.message
        return 'خطا در ورود'
      }
    },
    [setAuthSession]
  )

  const signOut = useCallback(async () => {
    await clearUserSessionContext()
    await clearAuthSession()
    setAuthSession(null)
    setSessionUserId(null)
    clearInbox()
    navigate('/login', { replace: true })
  }, [setAuthSession, setSessionUserId, clearInbox, navigate])

  const serverReachable = useAppStore(s => s.serverReachable)
  const isAuthenticated = isSessionValid(authSession, Date.now(), serverReachable)

  return {
    authSession: authSession as AuthSession | null,
    authLoaded,
    isAuthenticated,
    signIn,
    signOut
  }
}
