import { useEffect, useCallback } from 'react'
import { startNFCScan, stopNFCScan, isNFCSupported } from '@/services/nfc'
import { useAppStore } from '@/store'
import type { NFCScanResult, NFCTagData } from '@/types'

interface UseNFCReturn {
  isScanning: boolean
  isSupported: boolean
  lastTag: NFCTagData | null
  error: string | null
  startScan: () => Promise<void>
  stopScan: () => void
}

export function useNFC(): UseNFCReturn {
  const isScanning = useAppStore(s => s.isScanning)
  const lastTag = useAppStore(s => s.lastScannedTag)
  const error = useAppStore(s => s.nfcError)
  const setScanning = useAppStore(s => s.setScanning)
  const setLastScannedTag = useAppStore(s => s.setLastScannedTag)
  const setNFCError = useAppStore(s => s.setNFCError)

  const handleScanResult = useCallback(
    (result: NFCScanResult) => {
      // A tag read while no scan was requested must not become "the last tag": the fill page
      // acts on the stored tag the moment the next scan starts, and would open that asset
      // without the operator touching anything.
      if (!useAppStore.getState().isScanning) return
      if (!result.success || !result.tagData) {
        setNFCError(result.error ?? 'خطا در خواندن تگ')
        return
      }
      setNFCError(null)
      setLastScannedTag(result.tagData)
    },
    [setNFCError, setLastScannedTag]
  )

  const startScan = useCallback(async () => {
    if (isScanning) return
    // Only a tag read after this press may answer it.
    setLastScannedTag(null)
    setScanning(true)
    setNFCError(null)
    await startNFCScan(handleScanResult)
  }, [isScanning, setScanning, setNFCError, setLastScannedTag, handleScanResult])

  const stopScan = useCallback(() => {
    stopNFCScan()
    setScanning(false)
  }, [setScanning])

  useEffect(() => {
    return () => {
      if (isScanning) stopNFCScan()
    }
  }, [isScanning])

  return {
    isScanning,
    isSupported: isNFCSupported(),
    lastTag,
    error,
    startScan,
    stopScan
  }
}
