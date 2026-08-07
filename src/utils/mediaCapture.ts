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

/** Long-edge cap. Enough to read a gauge face or see a leak; far below what a camera emits. */
export const MAX_IMAGE_DIMENSION = 1600

/** Quality for the lossy re-encode. 0.8 is the usual knee — below it artefacts start showing. */
export const IMAGE_QUALITY = 0.8

/**
 * Hard stop for a recording. A forgotten open microphone is the realistic failure, and two
 * minutes of speech is already far more than a field note needs.
 */
export const MAX_AUDIO_DURATION_MS = 120_000

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

    const blob =
      (await canvasToBlob(canvas, 'image/webp', quality)) ??
      (await canvasToBlob(canvas, 'image/jpeg', quality))
    if (!blob) throw new Error('image encoding failed')

    return { blob, width, height }
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
  const mimeType = pickAudioMimeType()
  if (!mimeType) throw new Error('این مرورگر از ضبط صدا پشتیبانی نمی‌کند.')

  const stream = await navigator.mediaDevices.getUserMedia({
    // Mono at a low bitrate: speech, not music. Stereo would double the size for nothing.
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
  })
  const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 24_000 })
  const chunks: Blob[] = []
  const startedAt = Date.now()

  recorder.ondataavailable = e => {
    if (e.data.size > 0) chunks.push(e.data)
  }
  recorder.start()

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
          resolve({ blob, mimeType, durationMs: Date.now() - startedAt })
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
            durationMs: Date.now() - startedAt
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
