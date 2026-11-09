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
import { fetchBootstrap } from '@/services/api'
import { gateOf, loginWithDevice, type DeviceGate } from '@/services/device/deviceAuth'
import { setUnauthorizedHandler } from '@/services/api/client'
import { useAppStore } from '@/store'
import type { AuthSession } from '@/types/auth'
import { isSessionValid } from '@/types/auth'
import { postLoginPath } from '@/utils/loginRedirect'
import { toIdString } from '@/utils/ids'

/**
 * The outcome of a sign-in attempt.
 *
 * `deviceGate` is set when the device, not the password, stopped the login — the login screen
 * then shows the enrolment card instead of a plain error.
 */
export type SignInResult = { ok: true } | { ok: false; message: string; deviceGate?: DeviceGate }

/**
  * Binds the signed-in user to a stable `sessionUserId`.
  *
  * Login deliberately still succeeds when this cannot be resolved — the app is offline-first
  * and refusing entry because one call failed would lock an operator out of work they already
  * have on the device. Instead the session is marked *unbound*: `ensureSessionUserId()` retries
  * on every sync tick and inbox refresh, and until it succeeds outbound sync and inbox merge
  * hold back rather than act on an unattributable session (see the store's
  * `sessionBindingPending`).
  */
async function bindSessionUserContext(username: string): Promise<void> {
  const setSessionUserId = useAppStore.getState().setSessionUserId
  let userId: string | null = null
  try {
    const bootstrap = await fetchBootstrap()
    userId = toIdString(bootstrap.userId)
  } catch {
    // Same user returning to this device: their id is already on disk and still correct.
    const lastUsername = await getLastSessionUsername()
    if (lastUsername === username) {
      userId = await getSessionUserId()
    }
  }
  await activateUserSession(username, userId)
  if (userId) {
    setSessionUserId(userId)
    useAppStore.getState().setSessionBindingPending(false)
  } else {
    setSessionUserId(null)
    useAppStore.getState().setSessionBindingPending(true)
  }
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
      // A restored session that never got bound stays unbound across restarts, so raise the
      // flag here too rather than waiting for the first sync tick to notice.
      if (session && !useAppStore.getState().sessionUserId) {
        useAppStore.getState().setSessionBindingPending(true)
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
      useAppStore.getState().setSessionEnded(true)
      setAuthSession(null)
      setSessionUserId(null)
      clearInbox()
      void clearUserSessionContext()
      navigate('/login', { replace: true, state: { sessionEnded: true } })
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
    async (username: string, password: string): Promise<SignInResult> => {
      try {
        // Attaches a device proof only when the server enforces enrolment; otherwise this is
        // the same single login request it always was.
        const response = await loginWithDevice(username, password)
        const session = await saveAuthSession(response)
        await bindSessionUserContext(response.username)
        setAuthSession(session)
        return { ok: true }
      } catch (err) {
        const deviceGate = gateOf(err) ?? undefined
        if (err instanceof Error) return { ok: false, message: err.message, deviceGate }
        return { ok: false, message: 'خطا در ورود' }
      }
    },
    [setAuthSession]
  )

  const signOut = useCallback(async () => {
    useAppStore.getState().setSessionBindingPending(false)
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
