import type { NFCTagData, NFCScanResult } from '@/types'

/**
 * NFC abstraction layer.
 * All NFC interaction goes through this module so the underlying
 * implementation can be swapped (e.g. Web NFC → native bridge) without
 * touching any UI component.
 */

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
    data?: DataView | ArrayBuffer | Uint8Array | null
    toRecords?: () => NDEFMessageRecord[]
    encoding?: string
    lang?: string
    id?: string
  }
}

const URL_PREFIXES = [
  '',
  'http://www.',
  'https://www.',
  'http://',
  'https://',
  'tel:',
  'mailto:',
  'ftp://anonymous:anonymous@',
  'ftp://ftp.',
  'ftps://',
  'sftp://',
  'smb://',
  'nfs://',
  'ftp://',
  'dav://',
  'news:',
  'telnet://',
  'imap:',
  'rtsp://',
  'urn:',
  'pop:',
  'sip:',
  'sips:',
  'tftp:',
  'btspp://',
  'btl2cap://',
  'btgoep://',
  'tcpobex://',
  'irdaobex://',
  'file://',
  'urn:epc:id:',
  'urn:epc:tag:',
  'urn:epc:pat:',
  'urn:epc:raw:',
  'urn:epc:',
  'urn:nfc:'
]

export function isNFCSupported(): boolean {
  return typeof window !== 'undefined' && 'NDEFReader' in window
}

type NFCReadCallback = (result: NFCScanResult) => void

let activeAbortController: AbortController | null = null

/**
 * Asset tag id from NDEF payload — never the hardware UID.
 */
export function resolveNfcTagId(tag: NFCTagData): string {
  const fromMessage = tag.message?.trim()
  if (fromMessage) return fromMessage

  let best = ''
  for (const record of tag.records ?? []) {
    const value = record.data?.trim() ?? ''
    if (value.length > best.length) best = value
  }
  return best
}

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

function parseNDEFEvent(event: NDEFReadingEvent): NFCTagData {
  const records = event.message.records.map(r => {
    const decoded = decodeRecordData(r)
    return {
      recordType: r.recordType,
      mediaType: r.mediaType,
      data: decoded || undefined
    }
  })

  const best = pickLongest(records.map(r => r.data))

  return {
    serialNumber: event.serialNumber,
    message: best,
    records
  }
}

function decodeRecordData(record: NDEFMessageRecord): string {
  const bytes = toBytes(record.data)
  if (!bytes || bytes.byteLength === 0) return ''

  const candidates: string[] = []

  if (isPlainTextPayload(record)) {
    candidates.push(decodeRawBytes(bytes))
  }

  if (record.recordType === 'url') {
    candidates.push(decodeUrlBytes(bytes))
  }

  if (record.recordType === 'text' && isValidNdefTextHeader(bytes)) {
    candidates.push(decodeNdefTextBytes(bytes))
  }

  // Always include raw UTF-8 — handles text/plain and mis-labelled text records.
  candidates.push(decodeRawBytes(bytes))

  return pickLongest(candidates)
}

function isPlainTextPayload(record: NDEFMessageRecord): boolean {
  const type = record.recordType.toLowerCase()
  const media = (record.mediaType ?? '').toLowerCase()

  if (type === 'text/plain' || media === 'text/plain') return true
  if (type.startsWith('text/')) return true
  if (type === 'mime' && media.startsWith('text/')) return true
  return false
}

function isValidNdefTextHeader(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 3) return false

  const status = bytes[0]
  const langLength = status & 0x3f
  if (langLength === 0 || langLength > 8) return false
  if (1 + langLength >= bytes.byteLength) return false

  for (let i = 1; i <= langLength; i++) {
    const c = bytes[i]
    const isLetter = (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)
    const isSubtag = c === 0x2d
    if (!isLetter && !isSubtag) return false
  }

  return true
}

function decodeNdefTextBytes(bytes: Uint8Array): string {
  const status = bytes[0]
  const langLength = status & 0x3f
  const isUtf16 = (status & 0x80) !== 0
  const textStart = 1 + langLength
  if (textStart >= bytes.byteLength) return ''

  const textBytes = bytes.subarray(textStart)
  return new TextDecoder(isUtf16 ? 'utf-16' : 'utf-8').decode(textBytes).trim()
}

function decodeUrlBytes(bytes: Uint8Array): string {
  const code = bytes[0]
  const prefix = URL_PREFIXES[code] ?? ''
  if (bytes.byteLength <= 1) return prefix
  return `${prefix}${decodeRawBytes(bytes.subarray(1))}`.trim()
}

function decodeRawBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8')
      .decode(bytes)
      .replace(/\0/g, '')
      .trim()
  } catch {
    return ''
  }
}

function toBytes(data: NDEFMessageRecord['data']): Uint8Array | null {
  if (!data) return null
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (data instanceof Uint8Array) return data
  if (data instanceof DataView) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  }
  return null
}

function pickLongest(values: (string | undefined)[]): string {
  let best = ''
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed && trimmed.length > best.length) best = trimmed
  }
  return best
}
