import { useEffect } from 'react'
import { useAppStore } from '@/store'

/** Tracks device network (Wi‑Fi, mobile data, etc.) — separate from server reachability. */
export function useOnlineStatus(): boolean {
  const isOnline = useAppStore(s => s.isOnline)
  const setOnline = useAppStore(s => s.setOnline)
  const setServerReachable = useAppStore(s => s.setServerReachable)

  useEffect(() => {
    const handleOnline = () => {
      setOnline(true)
      setServerReachable(null)
    }
    const handleOffline = () => {
      setOnline(false)
      setServerReachable(null)
    }

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [setOnline, setServerReachable])

  return isOnline
}
