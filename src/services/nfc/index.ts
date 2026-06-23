import type { NFCTagData, NFCScanResult } from '@/types'

/**
 * NFC abstraction layer.
 * All NFC interaction goes through this module so the underlying
 * implementation can be swapped (e.g. Web NFC → native bridge) without
 * touching any UI component.
 */

// Extend the global NDEFReader type (Web NFC API)
declare global {
  interface Window {
    NDEFReader?: new () => NDEFReader
  }

  interface NDEFReader extends EventTarget {
    scan(options?: { signal?: AbortSignal }): Promise<void>
    addEventListener(
      type: 'reading',
      listener: (event: NDEFReadingEvent) => void,
      options?: boolean | AddEventListenerOptions
    ): void
    addEventListener(
      type: 'readingerror',
      listener: (event: Event) => void,
      options?: boolean | AddEventListenerOptions
    ): void
  }

  interface NDEFReadingEvent extends Event {
    serialNumber: string
    message: NDEFMessage
  }

  interface NDEFMessage {
    records: NDEFMessageRecord[]
  }

  interface NDEFMessageRecord {
    recordType: string
    mediaType?: string
    data?: DataView
    toRecords?: () => NDEFMessageRecord[]
    encoding?: string
    lang?: string
    id?: string
  }
}

export function isNFCSupported(): boolean {
  return typeof window !== 'undefined' && 'NDEFReader' in window
}

type NFCReadCallback = (result: NFCScanResult) => void

let activeAbortController: AbortController | null = null

/**
 * Start scanning for NFC tags.
 * Calls `onRead` each time a tag is detected.
 * Returns a cleanup function that stops scanning.
 */
export async function startNFCScan(onRead: NFCReadCallback): Promise<() => void> {
  if (!isNFCSupported()) {
    onRead({
      success: false,
      error: 'NFC در این دستگاه پشتیبانی نمی‌شود.'
    })
    return () => {}
  }

  try {
    activeAbortController = new AbortController()
    const reader = new window.NDEFReader!()

    reader.addEventListener('reading', (event: NDEFReadingEvent) => {
      const tagData = parseNDEFEvent(event)
      onRead({ success: true, tagData })
    })

    reader.addEventListener('readingerror', () => {
      onRead({ success: false, error: 'خطا در خواندن تگ NFC' })
    })

    await reader.scan({ signal: activeAbortController.signal })

    return () => stopNFCScan()
  } catch (err) {
    const message = err instanceof Error ? err.message : 'خطا در راه‌اندازی NFC'
    onRead({ success: false, error: message })
    return () => {}
  }
}

export function stopNFCScan(): void {
  activeAbortController?.abort()
  activeAbortController = null
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseNDEFEvent(event: NDEFReadingEvent): NFCTagData {
  const records = event.message.records.map(r => ({
    recordType: r.recordType,
    mediaType: r.mediaType,
    data: r.data ? decodeDataView(r.data) : undefined
  }))

  // Extract a human-readable message from the first text record
  const textRecord = records.find(r => r.recordType === 'text' || r.recordType === 'url')

  return {
    serialNumber: event.serialNumber,
    message: textRecord?.data,
    records
  }
}

function decodeDataView(data: DataView): string {
  try {
    return new TextDecoder().decode(data)
  } catch {
    return ''
  }
}
