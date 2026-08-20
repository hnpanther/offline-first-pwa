import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type { AssetEntry, NFCTagData, AppSettings } from '@/types'
import type { AuthSession } from '@/types/auth'
import type { ServerLogSheet } from '@/services/api'
import { DEFAULT_SETTINGS } from '@/services/storage/db'

// ---------------------------------------------------------------------------
// NFC slice
// ---------------------------------------------------------------------------
interface NFCSlice {
  isScanning: boolean
  lastScannedTag: NFCTagData | null
  nfcError: string | null
  setScanning: (v: boolean) => void
  setLastScannedTag: (tag: NFCTagData | null) => void
  setNFCError: (err: string | null) => void
}

// ---------------------------------------------------------------------------
// Asset slice
// ---------------------------------------------------------------------------
interface AssetSlice {
  currentAsset: AssetEntry | null
  assetLoading: boolean
  assetError: string | null
  setCurrentAsset: (asset: AssetEntry | null) => void
  setAssetLoading: (v: boolean) => void
  setAssetError: (err: string | null) => void
}

// ---------------------------------------------------------------------------
// Sync slice
// ---------------------------------------------------------------------------
interface SyncSlice {
  /** Device network (Wi‑Fi, mobile data, etc.) */
  isOnline: boolean
  /** App/API host reachability; null until first probe */
  serverReachable: boolean | null
  isSyncing: boolean
  lastSyncAt: number | null
  pendingCount: number
  failedCount: number
  syncError: string | null
  setOnline: (v: boolean) => void
  setServerReachable: (v: boolean | null) => void
  setSyncing: (v: boolean) => void
  setLastSyncAt: (ts: number) => void
  setPendingCount: (n: number) => void
  setFailedCount: (n: number) => void
  setSyncError: (err: string | null) => void
}

// ---------------------------------------------------------------------------
// Records slice
// ---------------------------------------------------------------------------
// A reserved placeholder, kept so the slice list in `AppStore` stays a complete map of the
// store's intended shape. Intersecting with an empty interface is a no-op, so it costs nothing
// at runtime or in types; `object` or `unknown` would not be a no-op and would change `AppStore`.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface RecordsSlice {
}

// ---------------------------------------------------------------------------
// Auth slice
// ---------------------------------------------------------------------------
interface AuthSlice {
  authSession: AuthSession | null
  authLoaded: boolean
  sessionUserId: string | null
  /**
   * The user was signed out by the app rather than by choice — expired token,
   * revoked from the admin panel, or superseded by a login elsewhere.
   *
   * This lives in the store instead of the router's location state because the
   * two navigations that can land on /login race each other: the unauthorized
   * handler's imperative `navigate('/login', { state: { sessionEnded: true } })`
   * and `ProtectedRoute`'s own `<Navigate to="/login" state={{ from }} />`, which
   * fires as soon as the session is cleared and overwrites the reason. Store
   * state is immune to that — whichever navigation wins, the flag survives.
   */
  sessionEnded: boolean
  /**
   * The session has no resolved `sessionUserId` yet — login succeeded but the bootstrap call
   * that identifies the user did not.
   *
   * <p>While this is true the app is deliberately half-open: local work is fully usable, but
   * outbound sync and inbox merge are held back, because neither can attribute work to a user
   * it cannot name. Sync would push nothing anyway; inbox merge would actively overwrite the
   * operator's typed values. `ensureSessionUserId()` retries on every sync tick and inbox
   * refresh, so this clears itself as soon as the server is reachable again.
   */
  sessionBindingPending: boolean
  setAuthSession: (session: AuthSession | null) => void
  setAuthLoaded: (v: boolean) => void
  setSessionUserId: (id: string | null) => void
  setSessionEnded: (v: boolean) => void
  setSessionBindingPending: (v: boolean) => void
}

// ---------------------------------------------------------------------------
// Inbox slice
// ---------------------------------------------------------------------------
interface InboxSlice {
  inboxAssigned: ServerLogSheet[]
  inboxAvailable: ServerLogSheet[]
  inboxTeamOpen: ServerLogSheet[]
  inboxLoading: boolean
  inboxError: string | null
  inboxWarning: string | null
  inboxLastSyncAt: number | null
  setInbox: (
    assigned: ServerLogSheet[],
    available: ServerLogSheet[],
    teamOpen: ServerLogSheet[],
    syncAt: number
  ) => void
  setInboxLoading: (v: boolean) => void
  setInboxError: (err: string | null) => void
  setInboxWarning: (msg: string | null) => void
  clearInbox: () => void
}

// ---------------------------------------------------------------------------
// Settings slice
// ---------------------------------------------------------------------------
interface SettingsSlice {
  settings: AppSettings
  settingsLoaded: boolean
  setSettings: (s: AppSettings) => void
  setSettingsLoaded: (v: boolean) => void
}

// ---------------------------------------------------------------------------
// Combined store
// ---------------------------------------------------------------------------
type AppStore = NFCSlice & AssetSlice & SyncSlice & RecordsSlice & SettingsSlice & AuthSlice & InboxSlice

export const useAppStore = create<AppStore>()(
  subscribeWithSelector((set) => ({
    // NFC
    isScanning: false,
    lastScannedTag: null,
    nfcError: null,
    setScanning: (v) => set({ isScanning: v }),
    setLastScannedTag: (tag) => set({ lastScannedTag: tag }),
    setNFCError: (err) => set({ nfcError: err }),

    // Asset
    currentAsset: null,
    assetLoading: false,
    assetError: null,
    setCurrentAsset: (asset) => set({ currentAsset: asset }),
    setAssetLoading: (v) => set({ assetLoading: v }),
    setAssetError: (err) => set({ assetError: err }),

    // Sync
    isOnline: navigator.onLine,
    serverReachable: null,
    isSyncing: false,
    lastSyncAt: null,
    pendingCount: 0,
    failedCount: 0,
    syncError: null,
    setOnline: (v) => set({ isOnline: v }),
    setServerReachable: (v) => set({ serverReachable: v }),
    setSyncing: (v) => set({ isSyncing: v }),
    setLastSyncAt: (ts) => set({ lastSyncAt: ts }),
    setPendingCount: (n) => set({ pendingCount: n }),
    setFailedCount: (n) => set({ failedCount: n }),
    setSyncError: (err) => set({ syncError: err }),

    // Records

    // Settings
    settings: { ...DEFAULT_SETTINGS },
    settingsLoaded: false,
    setSettings: (s) => set({ settings: s }),
    setSettingsLoaded: (v) => set({ settingsLoaded: v }),

    // Auth
    authSession: null,
    authLoaded: false,
    sessionUserId: null,
    sessionEnded: false,
    sessionBindingPending: false,
    setAuthSession: (session) => set({ authSession: session }),
    setAuthLoaded: (v) => set({ authLoaded: v }),
    setSessionUserId: (id) => set({ sessionUserId: id }),
    setSessionEnded: (v) => set({ sessionEnded: v }),
    setSessionBindingPending: (v) => set({ sessionBindingPending: v }),

    // Inbox
    inboxAssigned: [],
    inboxAvailable: [],
    inboxTeamOpen: [],
    inboxLoading: false,
    inboxError: null,
    inboxWarning: null,
    inboxLastSyncAt: null,
    setInbox: (assigned, available, teamOpen, syncAt) =>
      set({
        inboxAssigned: assigned,
        inboxAvailable: available,
        inboxTeamOpen: teamOpen,
        inboxLastSyncAt: syncAt,
        inboxError: null,
        inboxWarning: null
      }),
    setInboxLoading: (v) => set({ inboxLoading: v }),
    setInboxError: (err) => set({ inboxError: err }),
    setInboxWarning: (msg) => set({ inboxWarning: msg }),
    clearInbox: () =>
      set({
        inboxAssigned: [],
        inboxAvailable: [],
        inboxTeamOpen: [],
        inboxLastSyncAt: null,
        inboxError: null,
        inboxWarning: null
      })
  }))
)
