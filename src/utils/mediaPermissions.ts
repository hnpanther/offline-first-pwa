/**
 * Turning a browser media failure into something an operator can act on.
 *
 * This exists because of a real asymmetry that confuses people: taking a photo goes through
 * `<input type="file" capture>`, which hands off to the OS camera app and needs **no site
 * permission at all**, while recording audio goes through `getUserMedia`, which does. So a
 * tablet can happily take photos and then refuse to record, with no obvious reason why.
 *
 * The second half of the problem is worse. Once microphone access has been denied for an
 * origin, Chrome does not prompt again — every later call rejects instantly. Showing the raw
 * `DOMException.message` there ("Permission denied") tells the operator nothing about how to
 * get out of it, and there is no prompt left to grant. So we detect that state explicitly and
 * spell out where the setting lives.
 */

export type MediaPermissionState = 'granted' | 'denied' | 'prompt' | 'unknown'

export interface MediaFailure {
  /** Short line for the alert. */
  message: string
  /**
   * True when the browser will not ask again and the operator must change a setting. Drives
   * whether the UI shows the how-to-fix steps or just a retry.
   */
  needsManualGrant: boolean
}

/**
 * Whether this page can use the microphone/camera APIs at all.
 *
 * `getUserMedia` is gated on a secure context. Over plain HTTP `navigator.mediaDevices` is not
 * merely restricted, it is **undefined** — calling it throws a `TypeError` about reading a
 * property of undefined, which is a genuinely baffling thing to show a field operator.
 */
export function canUseMediaDevices(): boolean {
  if (typeof navigator === 'undefined') return false
  return typeof window !== 'undefined' && window.isSecureContext === true
    ? !!navigator.mediaDevices?.getUserMedia
    : false
}

/**
 * Current microphone permission, when the browser will tell us.
 *
 * The Permissions API is the only way to distinguish "the operator dismissed the prompt once"
 * (which a retry can still fix) from "this origin is blocked" (which only a settings change
 * can). Firefox does not support the `microphone` descriptor and throws, hence `'unknown'`,
 * which callers must treat as "just try it and see".
 */
export async function getMicrophonePermission(): Promise<MediaPermissionState> {
  if (typeof navigator === 'undefined' || !navigator.permissions?.query) return 'unknown'
  try {
    const status = await navigator.permissions.query({
      name: 'microphone' as PermissionName
    })
    return status.state as MediaPermissionState
  } catch {
    return 'unknown'
  }
}

/**
 * Explains a `getUserMedia` rejection in Persian, and says whether it is recoverable in-app.
 *
 * The `DOMException.name` values are the reliable signal here — the messages are
 * browser-specific English prose and not worth parsing.
 */
export function describeMediaError(err: unknown, blockedByPolicy = false): MediaFailure {
  const name = err instanceof DOMException || (err instanceof Error && 'name' in err)
    ? (err as Error).name
    : ''

  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return {
        // Covers both "dismissed the prompt" and "blocked for this site". The caller has
        // usually already checked the Permissions API and can be more specific.
        message: blockedByPolicy
          ? 'دسترسی به میکروفون برای این سایت مسدود شده است.'
          : 'اجازه استفاده از میکروفون داده نشد.',
        needsManualGrant: true
      }
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return { message: 'میکروفونی روی این دستگاه پیدا نشد.', needsManualGrant: false }
    case 'NotReadableError':
    case 'TrackStartError':
      return {
        // Typically another app (a call, a voice recorder) holds the microphone.
        message: 'میکروفون در اختیار برنامه دیگری است. آن برنامه را ببندید و دوباره تلاش کنید.',
        needsManualGrant: false
      }
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return { message: 'میکروفون این دستگاه با تنظیمات ضبط سازگار نیست.', needsManualGrant: false }
    case 'SecurityError':
      return { message: 'ضبط صدا فقط روی اتصال امن (HTTPS) ممکن است.', needsManualGrant: false }
    case 'AbortError':
      return { message: 'ضبط صدا متوقف شد.', needsManualGrant: false }
    default:
      return {
        message: err instanceof Error && err.message ? err.message : 'خطا در دسترسی به میکروفون.',
        needsManualGrant: false
      }
  }
}
