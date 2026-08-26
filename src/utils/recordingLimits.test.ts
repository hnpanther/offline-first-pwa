import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  endReasonMessage,
  startAudioRecording,
  startVideoRecording
} from '@/utils/mediaCapture'

/**
 * What ends a recording, and what it reports afterwards.
 *
 * **The defect these exist for.** A duration ceiling fired, called `recorder.stop()`, and did
 * nothing else — because `onstop` was only installed inside `stop()`, i.e. when the operator
 * pressed the button. So the clip was correctly capped at, say, two minutes and then reported as
 * however long the operator left the screen open. The server refuses a duration past its ceiling
 * and the upload queue parks a 4xx permanently, so **a valid two-minute clip was destroyed by the
 * number attached to it**. The microphone also stayed live the whole time, and the on-screen
 * counter kept climbing, so nothing told the operator the recording had already ended.
 *
 * Everything below is about that one class of bug: the recording ends once, on every path, and
 * says honestly how long it ran and what ended it.
 */

// ---------------------------------------------------------------- fakes

class FakeTrack {
  stopped = false
  kind: string
  constructor(kind: string) {
    this.kind = kind
  }
  stop() {
    this.stopped = true
  }
  getSettings() {
    return { width: 854, height: 480 }
  }
}

class FakeStream {
  tracks: FakeTrack[]
  constructor(kinds: string[]) {
    this.tracks = kinds.map(k => new FakeTrack(k))
  }
  getTracks() {
    return this.tracks
  }
  getVideoTracks() {
    return this.tracks.filter(t => t.kind === 'video')
  }
  get live() {
    return this.tracks.some(t => !t.stopped)
  }
}

/**
 * Enough of `MediaRecorder` to drive every ending.
 *
 * `stop()` sets the state and fires `onstop` synchronously, which is what the real one does
 * from the operator's point of view — the ordering that matters here is that `onstop` exists
 * *before* anything can call `stop()`, which is precisely what the fix changed.
 */
class FakeMediaRecorder {
  static isTypeSupported = () => true
  state: 'inactive' | 'recording' = 'inactive'
  ondataavailable: ((e: { data: { size: number } }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: (() => void) | null = null
  stopCount = 0

  constructor(
    public stream: unknown,
    public options: unknown
  ) {}

  start() {
    this.state = 'recording'
  }

  stop() {
    this.stopCount++
    this.state = 'inactive'
    this.onstop?.()
  }

  /** One timeslice's worth of encoded data, as the browser would deliver it. */
  emit(size: number) {
    this.ondataavailable?.({ data: { size } })
  }
}

let recorderInstance: FakeMediaRecorder
let streamInstance: FakeStream

function install(kinds: string[]) {
  streamInstance = new FakeStream(kinds)
  vi.stubGlobal('window', { isSecureContext: true })
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: vi.fn(async () => streamInstance) }
  })
  // A factory rather than a subclass assigning `this`: the recorder under test constructs its
  // own instance, and the test needs a handle on whichever one it built. `isTypeSupported` is a
  // static on the real class and `pickAudioMimeType` calls it before constructing anything.
  const factory = function (stream: unknown, options: unknown) {
    recorderInstance = new FakeMediaRecorder(stream, options)
    return recorderInstance
  }
  factory.isTypeSupported = () => true
  vi.stubGlobal('MediaRecorder', factory)
}

const CAP_MS = 120_000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------- audio

describe('startAudioRecording — the duration ceiling', () => {
  beforeEach(() => install(['audio']))

  it('reports the time actually recorded, not the time until the operator pressed stop', async () => {
    const handle = await startAudioRecording(CAP_MS)
    recorderInstance.emit(1024)

    // The ceiling fires. The clip is complete at this instant.
    vi.advanceTimersByTime(CAP_MS)
    expect(recorderInstance.state).toBe('inactive')

    // The operator does not notice for another three minutes.
    vi.advanceTimersByTime(180_000)
    const result = await handle.stop()

    // The whole bug in one assertion: this used to be 300_000 and the server refused it.
    expect(result.durationMs).toBe(CAP_MS)
    expect(result.endedBy).toBe('duration')
  })

  it('releases the microphone the moment the ceiling fires, not when the operator reacts', async () => {
    await startAudioRecording(CAP_MS)
    recorderInstance.emit(1024)
    expect(streamInstance.live).toBe(true)

    vi.advanceTimersByTime(CAP_MS)

    // A live track keeps the browser's recording indicator on. Leaving it until the operator
    // pressed a button read, correctly, as the app still listening.
    expect(streamInstance.live).toBe(false)
  })

  it('resolves `finished` so the UI can save the clip exactly as a manual stop would', async () => {
    const handle = await startAudioRecording(CAP_MS)
    recorderInstance.emit(1024)
    let settled = false
    void handle.finished.then(() => {
      settled = true
    })

    vi.advanceTimersByTime(CAP_MS)
    await vi.runAllTicks()
    await Promise.resolve()

    expect(settled).toBe(true)
  })

  it('reports the ceiling, not the suspension, when the process was frozen mid-recording', async () => {
    // Screen off: the timer is throttled and no media is produced. Media only grows when a
    // timeslice arrives, and the overdue check rides those — so the blob is at the ceiling and
    // the wall clock is not a measure of it. Reporting the wall clock here would hand the server
    // a duration it refuses and the queue would park a clip that is exactly as long as allowed.
    const handle = await startAudioRecording(CAP_MS)
    recorderInstance.emit(1024)

    vi.setSystemTime(new Date(Date.now() + 900_000))
    recorderInstance.emit(1024)
    const result = await handle.stop()

    expect(result.durationMs).toBe(CAP_MS)
    expect(result.endedBy).toBe('duration')
  })

  it('cuts from the data stream too, so a throttled background timer cannot let the clip overrun', async () => {
    // On Android with the screen off, `setTimeout` is throttled hard. If that were the only
    // ceiling the blob itself would run past it — and then no amount of honest reporting helps,
    // because the recording really is too long. `ondataavailable` rides the encoder instead.
    const handle = await startAudioRecording(CAP_MS)

    vi.setSystemTime(new Date(Date.now() + CAP_MS + 5_000))
    recorderInstance.emit(1024)

    expect(recorderInstance.state).toBe('inactive')
    const result = await handle.stop()
    expect(result.endedBy).toBe('duration')
  })

  it('attributes a stop the operator made to the operator', async () => {
    const handle = await startAudioRecording(CAP_MS)
    recorderInstance.emit(1024)

    vi.advanceTimersByTime(30_000)
    const result = await handle.stop()

    expect(result.durationMs).toBe(30_000)
    expect(result.endedBy).toBe('user')
    expect(streamInstance.live).toBe(false)
  })

  it('keeps the first reason when the operator presses stop just after a ceiling fired', async () => {
    // The message they get has to explain what actually happened. Overwriting the reason with
    // 'user' would hide the ceiling and leave them wondering why the clip is short.
    const handle = await startAudioRecording(CAP_MS)
    recorderInstance.emit(1024)
    vi.advanceTimersByTime(CAP_MS)

    const result = await handle.stop()

    expect(result.endedBy).toBe('duration')
  })

  it('stops the recorder exactly once however many ceilings are reached', async () => {
    const handle = await startAudioRecording(CAP_MS)
    recorderInstance.emit(1024)

    vi.advanceTimersByTime(CAP_MS)
    recorderInstance.emit(1024) // a late timeslice still arriving
    await handle.stop()

    expect(recorderInstance.stopCount).toBe(1)
  })

  it('reports a size cut as a size cut', async () => {
    const handle = await startAudioRecording(CAP_MS)

    vi.advanceTimersByTime(10_000)
    recorderInstance.emit(5 * 1024 * 1024) // past MAX_AUDIO_BYTES

    expect(recorderInstance.state).toBe('inactive')
    const result = await handle.stop()
    expect(result.endedBy).toBe('size')
    expect(result.durationMs).toBe(10_000)
  })

  it('releases the microphone on cancel', async () => {
    const handle = await startAudioRecording(CAP_MS)
    recorderInstance.emit(1024)

    handle.cancel()

    expect(streamInstance.live).toBe(false)
    expect(recorderInstance.state).toBe('inactive')
  })

  it('rejects rather than saving an empty clip', async () => {
    const handle = await startAudioRecording(CAP_MS)
    // No timeslice ever arrived — the encoder produced nothing.
    await expect(handle.stop()).rejects.toThrow()
  })
})

// ---------------------------------------------------------------- video

describe('startVideoRecording — the same rules', () => {
  beforeEach(() => install(['video', 'audio']))

  it('reports the time actually recorded', async () => {
    const handle = await startVideoRecording(CAP_MS)
    recorderInstance.emit(2048)

    vi.advanceTimersByTime(CAP_MS)
    vi.advanceTimersByTime(240_000)
    const result = await handle.stop()

    expect(result.durationMs).toBe(CAP_MS)
    expect(result.endedBy).toBe('duration')
  })

  it('releases the camera when the ceiling fires', async () => {
    await startVideoRecording(CAP_MS)
    recorderInstance.emit(2048)

    vi.advanceTimersByTime(CAP_MS)

    // A camera left running is worse than a microphone: the preview light stays on and the
    // battery drains for as long as the operator does not notice.
    expect(streamInstance.live).toBe(false)
  })

  it('reports a byte cut and still carries the frame size', async () => {
    const handle = await startVideoRecording(CAP_MS, 1024)

    vi.advanceTimersByTime(5_000)
    recorderInstance.emit(4096)

    const result = await handle.stop()
    expect(result.endedBy).toBe('size')
    expect(result.durationMs).toBe(5_000)
    expect(result.width).toBe(854)
    expect(result.height).toBe(480)
  })

  it('exposes the live stream for the preview and still ends cleanly', async () => {
    const handle = await startVideoRecording(CAP_MS)
    expect(handle.stream).toBe(streamInstance)

    recorderInstance.emit(2048)
    vi.advanceTimersByTime(1_000)
    await handle.stop()

    expect(streamInstance.live).toBe(false)
  })
})

// ---------------------------------------------------------------- the number the server sees

describe('what reaches the upload queue', () => {
  beforeEach(() => install(['audio']))

  it('never reports a duration the server would refuse', async () => {
    // The server allows the ceiling plus one second of slack (browsers report a duration a few
    // ms past a clean stop). Anything beyond that is a 400, which the upload queue parks
    // permanently — so this is the invariant that keeps a capped clip deliverable.
    const handle = await startAudioRecording(CAP_MS)
    recorderInstance.emit(1024)

    vi.advanceTimersByTime(CAP_MS)
    vi.advanceTimersByTime(600_000)
    const result = await handle.stop()

    expect(result.durationMs).toBeLessThanOrEqual(CAP_MS + 1_000)
  })
})


// ---------------------------------------------------------------- what the operator is told

describe('endReasonMessage', () => {
  it('says nothing when the operator ended the recording themselves', () => {
    expect(endReasonMessage('user', CAP_MS)).toBeNull()
  })

  it('names the duration ceiling, with the number actually in force', () => {
    // Read from the server's setting rather than hard-coded, so the message can never disagree
    // with the limit that stopped the recording.
    const message = endReasonMessage('duration', 90_000)
    expect(message).toContain('90')
    expect(message).not.toContain('{{seconds}}')
  })

  it('keeps the size ceiling as its own message', () => {
    // A size cut and a duration cut ask the operator for different things next; one message for
    // both would tell half of them to do the wrong thing.
    expect(endReasonMessage('size', CAP_MS)).not.toEqual(endReasonMessage('duration', CAP_MS))
    expect(endReasonMessage('size', CAP_MS)).toContain('حجم')
  })
})
