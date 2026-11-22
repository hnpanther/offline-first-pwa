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
import {
  saveBootstrapUnitContext,
  saveRequiredFormLookups
} from '@/services/forms/formLookups'
import { gateOf, loginWithDevice, type DeviceGate } from '@/services/device/deviceAuth'
import { setUnauthorizedHandler } from '@/services/api/client'
import { useAppStore } from '@/store'
import { serverNow } from '@/services/clock/serverClock'
import { clearSessionContact, markSessionStarted } from '@/services/auth/offlineSession'
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
    // The inbox sync that follows reads this lease and unions it with round lists.
    // Saving it here — before the session is published — is what downloads personnel
    // (and every other FILL-able form list) without a manual catalog refresh.
    // An older server omits the field; leave whatever lease is already stored.
    if (bootstrap.requiredFormLookups) {
      await saveRequiredFormLookups(bootstrap.requiredFormLookups)
    }
    await saveBootstrapUnitContext({
      primaryUnitId:
        bootstrap.primaryUnitId != null ? toIdString(bootstrap.primaryUnitId) : null,
      accessibleUnitIds: (bootstrap.accessibleUnitIds ?? []).map(id => toIdString(id))
    })
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
      // Already signed out — by the operator, the offline lock or a revoke the device found
      // (backend V28). A request that was in flight then and answers 401 now must not replace
      // the reason the login page is about to show with the generic «session ended».
      if (!useAppStore.getState().authSession) return
      useAppStore.getState().setSessionEnded(true)
      setAuthSession(null)
      setSessionUserId(null)
      clearInbox()
      void clearUserSessionContext()
      void clearSessionContact()
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
        // The offline-session ceiling counts from here (backend V28).
        await markSessionStarted()
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

  /**
   * Signs out. `offlineLocked` is the offline-session ceiling's lock (backend V28): the same
   * sign-out — nothing local is deleted, unsent work stays and is sent after the next sign-in —
   * with the login page told why.
   */
  const signOut = useCallback(async (reason?: { offlineLocked?: 'limit' | 'clock'; deviceRevoked?: boolean }) => {
    useAppStore.getState().setSessionBindingPending(false)
    // Set before the session is cleared: clearing it makes ProtectedRoute redirect on its own, and
    // that redirect replaces the router state below — the store is what survives (see the store).
    useAppStore.getState().setSignOutNotice(
      reason?.offlineLocked === 'clock'
        ? 'offlineLockedClock'
        : reason?.offlineLocked
          ? 'offlineLockedLimit'
          : reason?.deviceRevoked
            ? 'deviceRevoked'
            : null
    )
    await clearUserSessionContext()
    await clearAuthSession()
    await clearSessionContact()
    setAuthSession(null)
    setSessionUserId(null)
    clearInbox()
    navigate('/login', {
      replace: true,
      state: reason?.offlineLocked
        ? { offlineLocked: reason.offlineLocked }
        : reason?.deviceRevoked
          ? { deviceRevoked: true }
          : undefined
    })
  }, [setAuthSession, setSessionUserId, clearInbox, navigate])

  const serverReachable = useAppStore(s => s.serverReachable)
  const isAuthenticated = isSessionValid(authSession, serverNow(), serverReachable)

  return {
    authSession: authSession as AuthSession | null,
    authLoaded,
    isAuthenticated,
    signIn,
    signOut
  }
}
