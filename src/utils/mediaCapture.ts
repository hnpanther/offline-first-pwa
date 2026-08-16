/**
 * Turning a camera or microphone capture into something small enough to sync.
 *
 * Compression here is **not** an optimisation, it is what makes the feature viable. A tablet
 * camera produces 8–12 MP JPEGs of several megabytes each; at the project's own target load
 * (50 assets a sheet, a sheet a day) storing those untouched would be tens of gigabytes a year
 * moving over a field network. Compressed, a photo is 200–400 KB and a minute of speech about
 * 150 KB, which the existing sync can carry without noticing.
 *
 * The original is deliberately discarded. Keeping it "just in case" doubles device storage for
 * a copy nothing ever reads.
 */

import { canUseMediaDevices } from '@/utils/mediaPermissions'

/** Long-edge cap. Enough to read a gauge face or see a leak; far below what a camera emits. */
export const MAX_IMAGE_DIMENSION = 1600

/** Quality for the lossy re-encode. 0.8 is the usual knee — below it artefacts start showing. */
export const IMAGE_QUALITY = 0.8

/**
 * Hard stop for a recording. A forgotten open microphone is the realistic failure, and two
 * minutes of speech is already far more than a field note needs.
 *
 * This is only the fallback: the real ceiling comes from the server's settings, so an
 * administrator can change it centrally and every tablet picks it up on the next bootstrap.
 */
export const MAX_AUDIO_DURATION_MS = 120_000

/** Fallback video ceiling, same story as the audio one. */
export const MAX_VIDEO_DURATION_MS = 120_000

/**
 * Video encoding, chosen to keep two minutes near 11 MB.
 *
 * 480p at 700 kbps is the deliberate call. Industrial evidence — a leak, a flame, a vibrating
 * coupling, a gauge sweeping — is entirely legible at that size; 720p would roughly double the
 * bytes for no diagnostic gain, and unlike a photo a video cannot be cheaply re-encoded on the
 * device afterwards. The constraints handed to `getUserMedia` and `MediaRecorder` are the only
 * lever there is, so they have to be right at capture time.
 */
export const MAX_VIDEO_DIMENSION = 854
export const VIDEO_BITS_PER_SECOND = 700_000
export const VIDEO_AUDIO_BITS_PER_SECOND = 24_000

/**
 * Hard byte ceiling for one recording, enforced while it runs.
 *
 * A bitrate is a **hint**, not a promise: a high-motion scene (steam, spray, a swinging torch)
 * makes the encoder overshoot badly. Without this a "120 second" clip could arrive at 40 MB and
 * be refused by the server after the operator already recorded it. Stopping early keeps what
 * they captured up to that point, which is far better than losing all of it.
 */
export const MAX_VIDEO_BYTES = 15 * 1024 * 1024
export const MAX_AUDIO_BYTES = 4 * 1024 * 1024

export interface CompressedImage {
  blob: Blob
  width: number
  height: number
}

/**
 * Scales an image down and re-encodes it, preferring WebP.
 *
 * WebP is ~30% smaller than JPEG at equivalent quality and is universal on Android Chrome,
 * which is the deployment target; the JPEG fallback exists for anything else. Falling back to
 * the *original* file when encoding fails would defeat the purpose, so a failed encode is an
 * error rather than a silent pass-through.
 */
export async function compressImage(
  file: Blob,
  maxDimension = MAX_IMAGE_DIMENSION,
  quality = IMAGE_QUALITY
): Promise<CompressedImage> {
  const bitmap = await loadBitmap(file)
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, maxDimension)

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas 2d context unavailable')
    ctx.drawImage(bitmap, 0, 0, width, height)

    return { blob: await encodeCanvasImage(canvas, quality), width, height }
  } finally {
    // ImageBitmap holds decoded pixels — on a 12 MP photo that is ~48 MB of memory.
    bitmap.close?.()
  }
}

/**
 * Target dimensions preserving aspect ratio.
 *
 * Images already inside the cap are returned untouched: upscaling a small photo would add
 * bytes without adding information.
 */
export function fitWithin(
  width: number,
  height: number,
  maxDimension: number
): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= maxDimension || longest === 0) {
    return { width, height }
  }
  const scale = maxDimension / longest
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  }
}

/** The best video container this browser can record, or null when none is supported. */
export function pickVideoMimeType(): string | null {
  // VP8/Opus in WebM is what Android Chrome actually produces and is by far the smallest of
  // the widely supported options; the rest are fallbacks for browsers with other encoders.
  const candidates = [
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4'
  ]
  if (typeof MediaRecorder === 'undefined') return null
  return candidates.find(type => MediaRecorder.isTypeSupported(type)) ?? null
}

/** The best audio container this browser can record, or null when none is supported. */
export function pickAudioMimeType(): string | null {
  // Opus in WebM is the small-and-universal choice on Android Chrome; the rest are fallbacks
  // for browsers that expose MediaRecorder with a different container.
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4'
  ]
  if (typeof MediaRecorder === 'undefined') return null
  return candidates.find(type => MediaRecorder.isTypeSupported(type)) ?? null
}

export interface AudioRecording {
  blob: Blob
  mimeType: string
  durationMs: number
  /** Set when the recording was cut short by the byte ceiling rather than by the operator. */
  truncated?: boolean
}

export interface VideoRecording extends AudioRecording {
  width?: number
  height?: number
}

export interface AudioRecorderHandle {
  stop: () => Promise<AudioRecording>
  cancel: () => void
}

/**
 * Starts recording from the microphone.
 *
 * The caller gets a handle rather than a promise of the finished clip, because the UI needs to
 * show elapsed time and offer both stop and cancel. **The microphone track is always stopped**,
 * on every exit path — a live track leaves the browser's recording indicator on and keeps the
 * hardware busy, which users reasonably read as the app spying on them.
 */
export async function startAudioRecording(
  maxDurationMs = MAX_AUDIO_DURATION_MS
): Promise<AudioRecorderHandle> {
  // Checked before anything else: over plain HTTP `navigator.mediaDevices` is undefined, and
  // calling straight into it throws a TypeError about reading a property of undefined — which
  // is a useless thing to put in front of an operator standing at a pump.
  if (!canUseMediaDevices()) {
    throw new DOMException('Media devices unavailable', 'SecurityError')
  }

  const mimeType = pickAudioMimeType()
  if (!mimeType) throw new Error('این مرورگر از ضبط صدا پشتیبانی نمی‌کند.')

  const stream = await navigator.mediaDevices.getUserMedia({
    // Mono at a low bitrate: speech, not music. Stereo would double the size for nothing.
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
  })
  const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 24_000 })
  const chunks: Blob[] = []
  const startedAt = Date.now()
  let bytes = 0
  let truncated = false

  recorder.ondataavailable = e => {
    if (e.data.size === 0) return
    chunks.push(e.data)
    bytes += e.data.size
    // Same reasoning as video: the bitrate is a hint. Stopping here keeps what was captured
    // instead of letting the server refuse the whole clip afterwards.
    if (bytes >= MAX_AUDIO_BYTES && recorder.state === 'recording') {
      truncated = true
      recorder.stop()
    }
  }
  // A timeslice is required for the byte check to run at all — without it `ondataavailable`
  // fires once, at the very end, which is far too late to stop anything.
  recorder.start(1000)

  const releaseStream = () => stream.getTracks().forEach(t => t.stop())
  const autoStop = setTimeout(() => {
    if (recorder.state === 'recording') recorder.stop()
  }, maxDurationMs)

  return {
    stop: () =>
      new Promise<AudioRecording>((resolve, reject) => {
        clearTimeout(autoStop)
        recorder.onstop = () => {
          releaseStream()
          const blob = new Blob(chunks, { type: mimeType })
          if (blob.size === 0) {
            reject(new Error('ضبط صدا انجام نشد.'))
            return
          }
          resolve({ blob, mimeType, durationMs: Date.now() - startedAt, truncated })
        }
        recorder.onerror = () => {
          releaseStream()
          reject(new Error('خطا در ضبط صدا.'))
        }
        if (recorder.state === 'recording') {
          recorder.stop()
        } else {
          // Already stopped by the duration cap — onstop will not fire again.
          releaseStream()
          resolve({
            blob: new Blob(chunks, { type: mimeType }),
            mimeType,
            durationMs: Date.now() - startedAt,
            truncated
          })
        }
      }),
    cancel: () => {
      clearTimeout(autoStop)
      if (recorder.state === 'recording') recorder.stop()
      releaseStream()
    }
  }
}

export interface VideoRecorderHandle {
  stop: () => Promise<VideoRecording>
  cancel: () => void
  /** Live preview source, so the operator can see what they are filming. */
  stream: MediaStream
}

/**
 * Starts recording video from the rear camera.
 *
 * Everything here is about keeping the file small enough to sync over a plant network:
 * 480p, a low bitrate, speech-grade audio, a duration cap **and** a byte cap. The byte cap is
 * the one that actually saves you — the others are requests the encoder may not honour.
 *
 * The caller gets the live `MediaStream` back so the UI can show a preview; without one the
 * operator is filming blind, which in practice means re-filming.
 */
export async function startVideoRecording(
  maxDurationMs = MAX_VIDEO_DURATION_MS,
  maxBytes = MAX_VIDEO_BYTES
): Promise<VideoRecorderHandle> {
  if (!canUseMediaDevices()) {
    throw new DOMException('Media devices unavailable', 'SecurityError')
  }
  const mimeType = pickVideoMimeType()
  if (!mimeType) throw new Error('این مرورگر از ضبط ویدئو پشتیبانی نمی‌کند.')

  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      // `ideal` rather than `exact`: a camera that cannot do exactly this should still record
      // at its nearest mode, not refuse outright.
      width: { ideal: MAX_VIDEO_DIMENSION },
      height: { ideal: 480 },
      frameRate: { ideal: 24, max: 30 },
      facingMode: 'environment'
    },
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
  })

  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
    audioBitsPerSecond: VIDEO_AUDIO_BITS_PER_SECOND
  })
  const chunks: Blob[] = []
  const startedAt = Date.now()
  let bytes = 0
  let truncated = false

  const settings = stream.getVideoTracks()[0]?.getSettings?.() ?? {}

  recorder.ondataavailable = e => {
    if (e.data.size === 0) return
    chunks.push(e.data)
    bytes += e.data.size
    if (bytes >= maxBytes && recorder.state === 'recording') {
      truncated = true
      recorder.stop()
    }
  }
  recorder.start(1000)

  const releaseStream = () => stream.getTracks().forEach(t => t.stop())
  const autoStop = setTimeout(() => {
    if (recorder.state === 'recording') recorder.stop()
  }, maxDurationMs)

  const finish = (): VideoRecording => ({
    blob: new Blob(chunks, { type: mimeType }),
    mimeType,
    durationMs: Date.now() - startedAt,
    width: typeof settings.width === 'number' ? settings.width : undefined,
    height: typeof settings.height === 'number' ? settings.height : undefined,
    truncated
  })

  return {
    stream,
    stop: () =>
      new Promise<VideoRecording>((resolve, reject) => {
        clearTimeout(autoStop)
        recorder.onstop = () => {
          releaseStream()
          const result = finish()
          if (result.blob.size === 0) {
            reject(new Error('ضبط ویدئو انجام نشد.'))
            return
          }
          resolve(result)
        }
        recorder.onerror = () => {
          releaseStream()
          reject(new Error('خطا در ضبط ویدئو.'))
        }
        if (recorder.state === 'recording') {
          recorder.stop()
        } else {
          // Already stopped by the duration or byte cap — onstop will not fire again.
          releaseStream()
          resolve(finish())
        }
      }),
    cancel: () => {
      clearTimeout(autoStop)
      if (recorder.state === 'recording') recorder.stop()
      releaseStream()
    }
  }
}

export function formatDuration(ms: number | undefined): string {
  if (ms == null || ms < 0) return '—'
  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes == null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Encodes a canvas the way every image in this app is encoded: WebP, falling back to JPEG.
 *
 * Shared with the annotation step so a marked-up photo cannot end up in a different format
 * from a plain one — the server sniffs magic bytes and only ever sees the two it already
 * accepts. A failed encode is an error rather than a silent pass-through: handing back the
 * unencoded original would defeat the compression this whole module exists for.
 */
export async function encodeCanvasImage(
  canvas: HTMLCanvasElement,
  quality = IMAGE_QUALITY
): Promise<Blob> {
  const blob =
    (await canvasToBlob(canvas, 'image/webp', quality)) ??
    (await canvasToBlob(canvas, 'image/jpeg', quality))
  if (!blob) throw new Error('image encoding failed')
  return blob
}

async function loadBitmap(file: Blob): Promise<ImageBitmap> {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file)
  }
  throw new Error('این مرورگر از پردازش تصویر پشتیبانی نمی‌کند.')
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number
): Promise<Blob | null> {
  return new Promise(resolve => {
    // toBlob hands back null when the browser cannot encode that type, which is how the
    // WebP → JPEG fallback above is driven.
    canvas.toBlob(blob => resolve(blob && blob.type === type ? blob : null), type, quality)
  })
}
