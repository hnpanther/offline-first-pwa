/**
 * Sending a queue in pieces, and telling a network blip from a refusal (issue P-04).
 *
 * The whole queue used to go in one request, under one `catch` that called every failure a
 * network blip. So a body over nginx's limit (`413`), a queue over the server's 500-item ceiling
 * (`400`) or any server fault that repeats for this payload was retried every thirty seconds,
 * forever, with nothing marked and nothing shown — and one oversized round held back every round
 * queued behind it. The backend isolates each *item* in its own transaction; sending everything
 * in one request undid that at the transport.
 *
 * Here a queue goes out in requests of at most {@link SubmitLimits.maxItems} items and
 * {@link SubmitLimits.maxBytes} of JSON, and each answer is applied **as soon as it arrives** —
 * so a later failure can never lose an earlier request's outcomes.
 */

import { ApiError } from '@/services/api/client'

export interface SubmitLimits {
  maxItems: number
  /** Serialised UTF-8 bytes per request — well under nginx's 32 MB `client_max_body_size`. */
  maxBytes: number
}

export const DEFAULT_SUBMIT_LIMITS: SubmitLimits = {
  maxItems: 20,
  maxBytes: 8 * 1024 * 1024
}

/**
 * - `transient` — the request says nothing about the payload (no connection, a timeout, a
 *   gateway with no backend behind it, rate limiting). Stop the pass; everything unsent stays
 *   queued exactly as it was.
 * - `too-large` — `413`: this request's body is over a limit. Split it and try again.
 * - `refused` — any other answer: the server looked and said no, and saying it again will not
 *   change that by itself. The items stay queued (a fix on the server releases them), the other
 *   requests still go, and the operator is eventually told why.
 */
export type SubmitFailureKind = 'transient' | 'too-large' | 'refused'

const TRANSIENT_STATUSES = new Set([0, 408, 429, 502, 503, 504])

export function classifySubmitFailure(err: unknown): SubmitFailureKind {
  // Not an ApiError: an abort, or something below the API layer. Treated as the old code treated
  // everything — retry later — because nothing about it is known to be the payload's fault.
  if (!(err instanceof ApiError)) return 'transient'
  if (err.status === 413) return 'too-large'
  return TRANSIENT_STATUSES.has(err.status) ? 'transient' : 'refused'
}

const encoder = new TextEncoder()

/** What one item adds to a request body, in UTF-8 bytes — Persian text is two bytes a letter. */
export function payloadBytes(item: unknown): number {
  return encoder.encode(JSON.stringify(item)).length
}

/**
 * Splits items into requests no larger than the limits allow, keeping their order.
 *
 * An item larger than `maxBytes` on its own still gets a request of its own: only the server can
 * say whether it is too large, and {@link submitInChunks} handles that answer.
 */
export function chunkForSubmit<T>(
  items: readonly T[],
  limits: SubmitLimits = DEFAULT_SUBMIT_LIMITS,
  sizeOf: (item: T) => number = payloadBytes
): T[][] {
  const chunks: T[][] = []
  let current: T[] = []
  let currentBytes = 0
  for (const item of items) {
    const bytes = sizeOf(item)
    const full = current.length >= limits.maxItems || currentBytes + bytes > limits.maxBytes
    if (current.length > 0 && full) {
      chunks.push(current)
      current = []
      currentBytes = 0
    }
    current.push(item)
    currentBytes += bytes
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

export interface ChunkedSubmitHandlers<T, R> {
  send: (chunk: T[]) => Promise<R[]>
  /** What an item adds to the request body; {@link payloadBytes} of the item itself when absent. */
  sizeOf?: (item: T) => number
  /** Applied as soon as a request's answer arrives. An error here is not a send failure. */
  onResults: (results: R[]) => Promise<void>
  /** One item that is still too large in a request of its own. */
  onOversized: (item: T) => Promise<void>
}

export interface ChunkedSubmitOutcome {
  /** Why the pass stopped early; everything not yet answered is still queued. */
  transientError?: string
  /** The last refusal of a whole request; its items are still queued, the others went. */
  refusedError?: string
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'خطا در ارتباط با سرور'
}

export async function submitInChunks<T, R>(
  items: readonly T[],
  handlers: ChunkedSubmitHandlers<T, R>,
  limits: SubmitLimits = DEFAULT_SUBMIT_LIMITS
): Promise<ChunkedSubmitOutcome> {
  const outcome: ChunkedSubmitOutcome = {}
  const queue = chunkForSubmit(items, limits, handlers.sizeOf)

  while (queue.length > 0) {
    const chunk = queue.shift()!
    let results: R[]
    try {
      results = await handlers.send(chunk)
    } catch (err) {
      const kind = classifySubmitFailure(err)
      if (kind === 'transient') {
        outcome.transientError = messageOf(err)
        break
      }
      if (kind === 'too-large') {
        if (chunk.length === 1) {
          await handlers.onOversized(chunk[0])
        } else {
          // Halved and put back at the front, so order is kept and the halves go next.
          const middle = Math.ceil(chunk.length / 2)
          queue.unshift(chunk.slice(0, middle), chunk.slice(middle))
        }
        continue
      }
      outcome.refusedError = messageOf(err)
      continue
    }
    await handlers.onResults(results)
  }

  return outcome
}
