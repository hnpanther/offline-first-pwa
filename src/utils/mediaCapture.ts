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

import { t } from '@/i18n'
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

/**
 * What ended a recording.
 *
 * A boolean `truncated` used to cover this, and it could not say *which* ceiling was hit — which
 * is the only part the operator can act on. Hitting the size cap means "record at a lower
 * quality or in shorter pieces"; hitting the duration cap means "that is the whole clip you are
 * allowed, record a second one". Two different instructions from one flag.
 */
export type RecordingEndReason = 'user' | 'duration' | 'size'

export interface AudioRecording {
  blob: Blob
  mimeType: string
  /**
   * How long the recording actually ran.
   *
   * **Measured to the moment the recorder stopped, not to the moment the operator noticed.**
   * This used to be `Date.now() - startedAt` evaluated inside `stop()`, which is a different
   * number entirely once a ceiling has already cut the recording: the clip was correctly capped
   * at, say, two minutes, and then reported as however long the operator left the screen open —
   * five minutes, ten. The server refuses a duration past its ceiling and the client parks a 4xx
   * as permanent, so a perfectly valid two-minute clip was destroyed by a wrong number attached
   * to it.
   */
  durationMs: number
  /** Why the recording ended. `'user'` means they pressed stop. */
  endedBy: RecordingEndReason
}

export interface VideoRecording extends AudioRecording {
  width?: number
  height?: number
}

export interface AudioRecorderHandle {
  /**
   * Resolves the moment recording actually ends, whoever ended it.
   *
   * **This is what turns a ceiling into a save.** A cap firing used to stop the `MediaRecorder`
   * and nothing else: the microphone stayed live, the browser kept showing its recording
   * indicator, the on-screen counter kept climbing, and the clip sat unsaved until the operator
   * eventually pressed a button that no longer did what it said. Awaiting this lets the UI run
   * exactly the same save path a manual stop runs.
   */
  finished: Promise<void>
  stop: () => Promise<AudioRecording>
  cancel: () => void
}

/**
 * The end of a recording, owned in one place for both recorders.
 *
 * <h3>Why this exists at all</h3>
 *
 * Both recorders used to assign {@code recorder.onstop} *inside* their `stop()` promise — i.e.
 * only once the operator pressed a button. A ceiling firing before that left the recording in a
 * half-ended state that nothing was watching:
 *
 * | what a stop should do | what a ceiling actually did |
 * |---|---|
 * | close the blob | ✅ |
 * | release the microphone / camera | ❌ no handler existed, so the track stayed live |
 * | stop the browser's recording indicator | ❌ |
 * | save the clip | ❌ it sat in memory |
 * | stop the on-screen counter | ❌ it kept climbing |
 * | report an honest duration | ❌ it reported time-until-the-button, not time-recorded |
 *
 * The last one was the expensive part: the server refuses a duration past its ceiling and the
 * upload queue parks a 4xx permanently, so a valid capped clip was destroyed by the number
 * attached to it.
 *
 * <h3>The fix, in one sentence</h3>
 *
 * `onstop` is installed **once, at construction**, so every path — the operator, the duration
 * ceiling, the byte ceiling, `cancel()` — runs the same ending exactly once.
 *
 * <h3>Two ceilings for the same limit, deliberately</h3>
 *
 * `setTimeout` gives a precise cut in the normal case. `cutIfOverdue()`, called from
 * `ondataavailable` roughly once a second, is the one that holds when the tablet's screen goes
 * off: browsers throttle background timers heavily, and a throttled `setTimeout` would let the
 * blob itself run past the ceiling — at which point no amount of honest reporting helps, because
 * the recording really is too long. Driving the check from the media stream keeps it running
 * whenever the encoder is running.
 */
function beginRecording(
  recorder: MediaRecorder,
  releaseStream: () => void,
  startedAt: number,
  maxDurationMs: number
) {
  let stoppedAt: number | null = null
  let reason: RecordingEndReason = 'user'
  let errored = false
  let settle!: () => void
  const finished = new Promise<void>(resolve => {
    settle = resolve
  })

  const end = () => {
    if (stoppedAt !== null) return
    stoppedAt = Date.now()
    clearTimeout(autoStop)
    releaseStream()
    settle()
  }

  recorder.onstop = end
  recorder.onerror = () => {
    errored = true
    end()
  }

  /**
   * Ends the recording, attributing it to `why`.
   *
   * **First cut wins.** The `state !== 'recording'` guard is what makes that true: when the
   * duration ceiling fires and the operator presses stop a moment later, the reason stays
   * `'duration'` rather than being overwritten with `'user'`, so the message they get explains
   * what actually happened.
   */
  const cut = (why: RecordingEndReason) => {
    if (recorder.state !== 'recording') return
    reason = why
    recorder.stop()
  }

  const autoStop = setTimeout(() => cut('duration'), maxDurationMs)

  return {
    finished,
    cut,
    cutIfOverdue: () => {
      if (Date.now() - startedAt >= maxDurationMs) cut('duration')
    },
    /**
     * Time actually recorded, and never more than the ceiling.
     *
     * <p>Two parts, and both are load-bearing.
     *
     * <p><b>`stoppedAt` rather than the current clock.</b> This is the fix for the original
     * defect: read at `stop()` time it returned however long the operator left the screen open
     * after a ceiling had already ended the recording.
     *
     * <p><b>Clamped to the ceiling.</b> Not a fudge — it is the honest number. Media only grows
     * when `ondataavailable` delivers a chunk, and `cutIfOverdue` runs on every one of those, so
     * **the blob cannot exceed the ceiling by more than a single timeslice, by construction.**
     * Wall-clock time beyond that is the process having been suspended (screen off, tab
     * backgrounded) with no media produced at all, and reporting suspension as recorded content
     * would hand the server a duration it refuses — which the upload queue parks permanently,
     * destroying a clip that is in fact exactly as long as it is allowed to be. The byte
     * ceilings remain the real guard on payload size, which is what the server's own
     * `enforceDuration` says it relies on.
     */
    durationMs: () => Math.min((stoppedAt ?? Date.now()) - startedAt, maxDurationMs),
    endedBy: () => reason,
    failed: () => errored,
    cancel: () => {
      cut('user')
      // A recording that never started, or one already ended: `end()` is idempotent and the
      // track must be released either way.
      end()
    }
  }
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
  const releaseStream = () => stream.getTracks().forEach(t => t.stop())
  const chunks: Blob[] = []
  const startedAt = Date.now()
  let bytes = 0

  const ending = beginRecording(recorder, releaseStream, startedAt, maxDurationMs)

  recorder.ondataavailable = e => {
    if (e.data.size === 0) return
    chunks.push(e.data)
    bytes += e.data.size
    // Same reasoning as video: the bitrate is a hint. Stopping here keeps what was captured
    // instead of letting the server refuse the whole clip afterwards.
    if (bytes >= MAX_AUDIO_BYTES) ending.cut('size')
    // The duration ceiling again, from the data stream rather than from a timer. See `cut`.
    ending.cutIfOverdue()
  }
  // A timeslice is required for the byte and elapsed checks to run at all — without it
  // `ondataavailable` fires once, at the very end, which is far too late to stop anything.
  recorder.start(1000)

  const build = (): AudioRecording => ({
    blob: new Blob(chunks, { type: mimeType }),
    mimeType,
    durationMs: ending.durationMs(),
    endedBy: ending.endedBy()
  })

  return {
    finished: ending.finished,
    stop: async () => {
      ending.cut('user')
      await ending.finished
      if (ending.failed()) throw new Error('خطا در ضبط صدا.')
      const result = build()
      if (result.blob.size === 0) throw new Error('ضبط صدا انجام نشد.')
      return result
    },
    cancel: () => ending.cancel()
  }
}

export interface VideoRecorderHandle {
  /** Resolves the moment recording ends, whoever ended it. See {@link AudioRecorderHandle}. */
  finished: Promise<void>
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
  const releaseStream = () => stream.getTracks().forEach(t => t.stop())
  const chunks: Blob[] = []
  const startedAt = Date.now()
  let bytes = 0

  const settings = stream.getVideoTracks()[0]?.getSettings?.() ?? {}
  const ending = beginRecording(recorder, releaseStream, startedAt, maxDurationMs)

  recorder.ondataavailable = e => {
    if (e.data.size === 0) return
    chunks.push(e.data)
    bytes += e.data.size
    if (bytes >= maxBytes) ending.cut('size')
    ending.cutIfOverdue()
  }
  recorder.start(1000)

  const build = (): VideoRecording => ({
    blob: new Blob(chunks, { type: mimeType }),
    mimeType,
    durationMs: ending.durationMs(),
    width: typeof settings.width === 'number' ? settings.width : undefined,
    height: typeof settings.height === 'number' ? settings.height : undefined,
    endedBy: ending.endedBy()
  })

  return {
    stream,
    finished: ending.finished,
    stop: async () => {
      ending.cut('user')
      await ending.finished
      if (ending.failed()) throw new Error('خطا در ضبط ویدئو.')
      const result = build()
      if (result.blob.size === 0) throw new Error('ضبط ویدئو انجام نشد.')
      return result
    },
    cancel: () => ending.cancel()
  }
}

/**
 * What to tell the operator about how their recording ended, or {@code null} when they ended it.
 *
 * **Two ceilings, two messages, deliberately not one.** A size cut means "record at a lower
 * quality, or in shorter pieces"; a duration cut means "that is the whole clip you may record —
 * take a second one if you need more". A single «کوتاه شد» for both leaves the operator guessing
 * which lever to pull, and the size message in particular is actively wrong when the clock is
 * what stopped them. This is why {@link RecordingEndReason} replaced a boolean `truncated`.
 *
 * The seconds come from the ceiling actually in force — the server's setting, mirrored into the
 * device's `limits` — so the number in the message can never drift from the number enforced.
 *
 * Lives here rather than in the component so it can be tested without pulling in the UI, and so
 * the wording stays next to the code that decides the reason.
 */
export function endReasonMessage(
  endedBy: RecordingEndReason,
  maxDurationMs: number
): string | null {
  if (endedBy === 'size') return t.attachments.truncatedBySize
  if (endedBy === 'duration') {
    return t.attachments.truncatedByDuration.replace(
      '{{seconds}}',
      String(Math.round(maxDurationMs / 1000))
    )
  }
  return null
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
