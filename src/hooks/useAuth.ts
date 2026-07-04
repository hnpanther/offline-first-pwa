import { useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  getAuthSession,
  saveAuthSession,
  clearAuthSession
} from '@/services/auth'
import { login as apiLogin } from '@/services/api'
import { setUnauthorizedHandler } from '@/services/api/client'
import { useAppStore } from '@/store'
import type { AuthSession } from '@/types/auth'
import { isSessionValid } from '@/types/auth'

export function useAuthInit(): void {
  const setAuthSession = useAppStore(s => s.setAuthSession)
  const setAuthLoaded = useAppStore(s => s.setAuthLoaded)
  const clearInbox = useAppStore(s => s.clearInbox)
  const navigate = useNavigate()

  useEffect(() => {
    void (async () => {
      const session = await getAuthSession()
      setAuthSession(session)
      setAuthLoaded(true)
    })()
  }, [setAuthSession, setAuthLoaded])

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setAuthSession(null)
      clearInbox()
      navigate('/login', { replace: true })
    })
    return () => setUnauthorizedHandler(null)
  }, [navigate, setAuthSession, clearInbox])
}

export function useAuth() {
  const authSession = useAppStore(s => s.authSession)
  const authLoaded = useAppStore(s => s.authLoaded)
  const setAuthSession = useAppStore(s => s.setAuthSession)
  const clearInbox = useAppStore(s => s.clearInbox)
  const navigate = useNavigate()

  const signIn = useCallback(
    async (username: string, password: string): Promise<string | null> => {
      try {
        const response = await apiLogin({ username, password })
        const session = await saveAuthSession(response)
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
    await clearAuthSession()
    setAuthSession(null)
    clearInbox()
    navigate('/login', { replace: true })
  }, [setAuthSession, clearInbox, navigate])

  const isAuthenticated = isSessionValid(authSession)

  return {
    authSession: authSession as AuthSession | null,
    authLoaded,
    isAuthenticated,
    signIn,
    signOut
  }
}
