import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/services/api/client'
import {
  chunkForSubmit,
  classifySubmitFailure,
  payloadBytes,
  submitInChunks,
  type SubmitLimits
} from '@/services/sync/submitChunks'

/**
 * Issue P-04 — sending the queue in pieces, and telling a network blip from a refusal. Pure: no
 * storage, no network; `SyncManager`'s use of it is covered in `submitBatchFailures.test.ts`.
 */

const LIMITS: SubmitLimits = { maxItems: 20, maxBytes: 8 * 1024 * 1024 }
const items = (n: number) => Array.from({ length: n }, (_, i) => ({ localId: `l-${i}` }))

describe('chunkForSubmit', () => {
  it('splits by count, keeping the order', () => {
    const chunks = chunkForSubmit(items(45), LIMITS)
    expect(chunks.map(c => c.length)).toEqual([20, 20, 5])
    expect(chunks.flat().map(i => i.localId)).toEqual(items(45).map(i => i.localId))
  })

  it('splits by bytes before the count is reached', () => {
    const chunks = chunkForSubmit(items(10), { maxItems: 20, maxBytes: 100 }, () => 30)
    expect(chunks.map(c => c.length)).toEqual([3, 3, 3, 1])
  })

  it('gives an item over the budget a request of its own rather than dropping it', () => {
    const sizes = [10, 500, 10]
    const chunks = chunkForSubmit([0, 1, 2], { maxItems: 20, maxBytes: 100 }, i => sizes[i])
    expect(chunks).toEqual([[0], [1], [2]])
  })

  it('returns nothing for nothing', () => {
    expect(chunkForSubmit([], LIMITS)).toEqual([])
  })

  it('measures Persian text in UTF-8 bytes, not characters', () => {
    expect(payloadBytes('پمپ')).toBe(JSON.stringify('پمپ').length + 3)
  })
})

describe('classifySubmitFailure', () => {
  it.each([0, 408, 429, 502, 503, 504])('calls %i transient', status => {
    expect(classifySubmitFailure(new ApiError(status, 'x'))).toBe('transient')
  })

  it('calls 413 too large', () => {
    expect(classifySubmitFailure(new ApiError(413, 'x'))).toBe('too-large')
  })

  it.each([400, 403, 404, 409, 422, 500, 501])('calls %i refused', status => {
    expect(classifySubmitFailure(new ApiError(status, 'x'))).toBe('refused')
  })

  it('calls anything that is not an API answer transient, as it always was', () => {
    expect(classifySubmitFailure(new DOMException('aborted', 'AbortError'))).toBe('transient')
    expect(classifySubmitFailure(new TypeError('boom'))).toBe('transient')
  })
})

describe('submitInChunks', () => {
  const echo = (chunk: { localId: string }[]) => Promise.resolve(chunk.map(i => i.localId))

  it('sends 45 items as three requests and applies each answer as it arrives', async () => {
    const send = vi.fn(echo)
    const applied: string[][] = []
    const outcome = await submitInChunks(items(45), {
      send,
      onResults: async r => void applied.push(r),
      onOversized: vi.fn()
    }, LIMITS)

    expect(send).toHaveBeenCalledTimes(3)
    expect(applied.map(a => a.length)).toEqual([20, 20, 5])
    expect(outcome).toEqual({})
  })

  it('halves a chunk the server calls too large, and sends both halves', async () => {
    const send = vi.fn(async (chunk: { localId: string }[]) => {
      if (chunk.length > 10) throw new ApiError(413, 'Payload Too Large')
      return chunk.map(i => i.localId)
    })
    const applied: string[] = []
    await submitInChunks(items(20), {
      send,
      onResults: async r => void applied.push(...r),
      onOversized: vi.fn()
    }, LIMITS)

    expect(send.mock.calls.map(c => c[0].length)).toEqual([20, 10, 10])
    expect(applied).toEqual(items(20).map(i => i.localId))
  })

  it('hands one item that is still too large on its own to onOversized, and sends the rest', async () => {
    const send = vi.fn(async (chunk: { localId: string }[]) => {
      if (chunk.some(i => i.localId === 'l-2')) throw new ApiError(413, 'Payload Too Large')
      return chunk.map(i => i.localId)
    })
    const oversized = vi.fn(async () => {})
    const applied: string[] = []
    await submitInChunks(items(4), {
      send,
      onResults: async r => void applied.push(...r),
      onOversized: oversized
    }, LIMITS)

    expect(oversized).toHaveBeenCalledTimes(1)
    expect(oversized).toHaveBeenCalledWith({ localId: 'l-2' })
    expect(applied.sort()).toEqual(['l-0', 'l-1', 'l-3'])
  })

  it('stops at a dead link, keeping what earlier requests delivered', async () => {
    let call = 0
    const send = vi.fn(async (chunk: { localId: string }[]) => {
      if (++call === 2) throw new ApiError(0, 'ارتباط با سرور برقرار نشد.')
      return chunk.map(i => i.localId)
    })
    const applied: string[] = []
    const outcome = await submitInChunks(items(45), {
      send,
      onResults: async r => void applied.push(...r),
      onOversized: vi.fn()
    }, LIMITS)

    expect(send).toHaveBeenCalledTimes(2)
    expect(applied).toHaveLength(20)
    expect(outcome.transientError).toBe('ارتباط با سرور برقرار نشد.')
  })

  it('goes on past a refused request, and reports the refusal', async () => {
    let call = 0
    const send = vi.fn(async (chunk: { localId: string }[]) => {
      if (++call === 1) throw new ApiError(400, 'درخواست نامعتبر است.')
      return chunk.map(i => i.localId)
    })
    const applied: string[] = []
    const outcome = await submitInChunks(items(45), {
      send,
      onResults: async r => void applied.push(...r),
      onOversized: vi.fn()
    }, LIMITS)

    expect(send).toHaveBeenCalledTimes(3)
    expect(applied).toHaveLength(25)
    expect(outcome).toEqual({ refusedError: 'درخواست نامعتبر است.' })
  })

  it('does not swallow a failure to record an answer as if it were the network', async () => {
    await expect(
      submitInChunks(items(1), {
        send: echo,
        onResults: async () => {
          throw new Error('IndexedDB write failed')
        },
        onOversized: vi.fn()
      }, LIMITS)
    ).rejects.toThrow('IndexedDB write failed')
  })
})
