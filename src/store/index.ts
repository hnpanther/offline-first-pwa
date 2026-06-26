import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type { AssetEntry, DataRecord, NFCTagData, AppSettings } from '@/types'
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
  isOnline: boolean
  isSyncing: boolean
  lastSyncAt: number | null
  pendingCount: number
  failedCount: number
  syncError: string | null
  setOnline: (v: boolean) => void
  setSyncing: (v: boolean) => void
  setLastSyncAt: (ts: number) => void
  setPendingCount: (n: number) => void
  setFailedCount: (n: number) => void
  setSyncError: (err: string | null) => void
}

// ---------------------------------------------------------------------------
// Records slice
// ---------------------------------------------------------------------------
interface RecordsSlice {
  records: DataRecord[]
  recordsLoading: boolean
  setRecords: (records: DataRecord[]) => void
  setRecordsLoading: (v: boolean) => void
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
type AppStore = NFCSlice & AssetSlice & SyncSlice & RecordsSlice & SettingsSlice

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
    isSyncing: false,
    lastSyncAt: null,
    pendingCount: 0,
    failedCount: 0,
    syncError: null,
    setOnline: (v) => set({ isOnline: v }),
    setSyncing: (v) => set({ isSyncing: v }),
    setLastSyncAt: (ts) => set({ lastSyncAt: ts }),
    setPendingCount: (n) => set({ pendingCount: n }),
    setFailedCount: (n) => set({ failedCount: n }),
    setSyncError: (err) => set({ syncError: err }),

    // Records
    records: [],
    recordsLoading: false,
    setRecords: (records) => set({ records }),
    setRecordsLoading: (v) => set({ recordsLoading: v }),

    // Settings
    settings: { ...DEFAULT_SETTINGS },
    settingsLoaded: false,
    setSettings: (s) => set({ settings: s }),
    setSettingsLoaded: (v) => set({ settingsLoaded: v })
  }))
)
