import { describe, expect, it } from 'vitest'
import {
  MAX_AUDIO_DURATION_MS,
  MAX_IMAGE_DIMENSION,
  fitWithin,
  formatBytes,
  formatDuration
} from '@/utils/mediaCapture'

/**
 * These cover the decisions that determine how much data leaves a tablet. `compressImage` and
 * `startAudioRecording` themselves need a canvas and a microphone, so they are exercised in the
 * live run rather than here; the arithmetic they depend on is what is pinned down below.
 */

describe('fitWithin', () => {
  it('scales a landscape photo down to the long-edge cap, keeping the aspect ratio', () => {
    // A typical 12 MP tablet camera frame.
    expect(fitWithin(4032, 3024, 1600)).toEqual({ width: 1600, height: 1200 })
  })

  it('scales by the long edge for a portrait photo too', () => {
    expect(fitWithin(3024, 4032, 1600)).toEqual({ width: 1200, height: 1600 })
  })

  it('leaves an image that is already small alone', () => {
    // Upscaling would add bytes without adding any information — the whole point is size.
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 })
  })

  it('leaves an image sitting exactly on the cap alone', () => {
    expect(fitWithin(1600, 900, 1600)).toEqual({ width: 1600, height: 900 })
  })

  it('never rounds a dimension down to zero', () => {
    // An extreme panorama: 10000x3 scaled by 1600/10000 gives 0.48px of height. A zero-height
    // canvas cannot be encoded at all, so the floor of 1 is what keeps the capture usable.
    expect(fitWithin(10000, 3, 1600)).toEqual({ width: 1600, height: 1 })
  })

  it('does not divide by zero on a degenerate image', () => {
    expect(fitWithin(0, 0, 1600)).toEqual({ width: 0, height: 0 })
  })

  it('keeps the shipped cap at a size that can still show a gauge face', () => {
    expect(MAX_IMAGE_DIMENSION).toBe(1600)
  })
})

describe('formatDuration', () => {
  it('formats a short clip', () => {
    expect(formatDuration(9_000)).toBe('0:09')
  })

  it('pads the seconds so the width does not jitter while recording', () => {
    expect(formatDuration(65_000)).toBe('1:05')
  })

  it('formats the recording cap itself', () => {
    expect(formatDuration(MAX_AUDIO_DURATION_MS)).toBe('2:00')
  })

  it('shows a dash rather than a bogus time when the duration is unknown', () => {
    expect(formatDuration(undefined)).toBe('—')
    expect(formatDuration(-1)).toBe('—')
  })
})

describe('formatBytes', () => {
  it('uses bytes below a kilobyte', () => {
    expect(formatBytes(512)).toBe('512 B')
  })

  it('uses kilobytes for a typical compressed photo', () => {
    expect(formatBytes(280 * 1024)).toBe('280 KB')
  })

  it('uses megabytes with one decimal for anything larger', () => {
    expect(formatBytes(3 * 1024 * 1024 + 512 * 1024)).toBe('3.5 MB')
  })

  it('shows a dash when the size is unknown', () => {
    expect(formatBytes(undefined)).toBe('—')
  })
})
