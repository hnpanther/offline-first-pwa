import { useCallback, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  peekAuthSession,
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
  const location = useLocation()

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const session = await peekAuthSession()
      if (cancelled) return
      setAuthSession(session)
      setAuthLoaded(true)
      if (session && location.pathname === '/login') {
        navigate('/', { replace: true })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [setAuthSession, setAuthLoaded, navigate, location.pathname])

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
