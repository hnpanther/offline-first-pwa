import { useEffect } from 'react'
import { useAppStore } from '@/store'

/** Tracks navigator.onLine and updates the store. */
export function useOnlineStatus(): boolean {
  const isOnline = useAppStore(s => s.isOnline)
  const setOnline = useAppStore(s => s.setOnline)

  useEffect(() => {
    const handleOnline = () => setOnline(true)
    const handleOffline = () => setOnline(false)

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [setOnline])

  return isOnline
}
