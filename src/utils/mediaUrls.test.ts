import { describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { MediaUrlCache } from '@/utils/mediaUrls'
import type { AttachmentKind } from '@/types'

/**
 * Object URLs for a media field: one per attachment, reused, revoked exactly once.
 *
 * <p>The defect: video and audio called {@code URL.createObjectURL} inline in the render. Every
 * render made a new URL, none was revoked, and the player's {@code src} changed under the
 * operator. Measured in a browser, twenty re-renders of one video and one audio field left forty
 * live URLs and reloaded both players twenty times. See the class comment for the full story.
 */

function fakeUrls() {
  let n = 0
  const live = new Set<string>()
  const revoked: string[] = []
  return {
    live,
    revoked,
    create: vi.fn((_blob: Blob) => {
      const url = `blob:test/${++n}`
      live.add(url)
      return url
    }),
    revoke: vi.fn((url: string) => {
      if (!live.has(url)) throw new Error(`revoked twice or never created: ${url}`)
      live.delete(url)
      revoked.push(url)
    })
  }
}

function row(id: string, kind: AttachmentKind, withBlob = true) {
  return { id, kind, blob: withBlob ? new Blob([id], { type: 'application/octet-stream' }) : undefined }
}

function cacheWith(urls: ReturnType<typeof fakeUrls>, download = vi.fn(async (id: string) => new Blob([id]))) {
  return { cache: new MediaUrlCache({ create: urls.create, revoke: urls.revoke, download }), download }
}

describe('MediaUrlCache', () => {
  it('gives video and audio a URL, not only images', async () => {
    const urls = fakeUrls()
    const { cache } = cacheWith(urls)

    const map = await cache.update([row('v', 'VIDEO'), row('a', 'AUDIO'), row('i', 'IMAGE')])

    expect([...map!.keys()]).toEqual(['v', 'a', 'i'])
    expect(urls.live.size).toBe(3)
  })

  it('reuses one URL per attachment across refreshes, so a playing clip is not reloaded', async () => {
    const urls = fakeUrls()
    const { cache } = cacheWith(urls)
    const rows = [row('v', 'VIDEO'), row('a', 'AUDIO')]

    const first = await cache.update(rows)
    for (let i = 0; i < 20; i++) await cache.update(rows)
    const last = await cache.update(rows)

    expect(urls.create).toHaveBeenCalledTimes(2)
    expect(last!.get('v')).toBe(first!.get('v'))
    expect(last!.get('a')).toBe(first!.get('a'))
    expect(urls.live.size).toBe(2)
  })

  it('revokes the URL of an attachment that left the field, and only that one', async () => {
    const urls = fakeUrls()
    const { cache } = cacheWith(urls)

    const before = await cache.update([row('v1', 'VIDEO'), row('v2', 'VIDEO')])
    const after = await cache.update([row('v2', 'VIDEO')])

    expect(urls.revoked).toEqual([before!.get('v1')])
    expect(after!.get('v2')).toBe(before!.get('v2'))
    expect(urls.live.size).toBe(1)
  })

  it('creates a URL for a newly captured attachment and keeps the existing ones', async () => {
    const urls = fakeUrls()
    const { cache } = cacheWith(urls)

    const before = await cache.update([row('a1', 'AUDIO')])
    const after = await cache.update([row('a1', 'AUDIO'), row('a2', 'AUDIO')])

    expect(after!.get('a1')).toBe(before!.get('a1'))
    expect(after!.get('a2')).toBeDefined()
    expect(urls.revoked).toEqual([])
  })

  it('release revokes everything exactly once, and the cache still works afterwards (StrictMode remount)', async () => {
    const urls = fakeUrls()
    const { cache } = cacheWith(urls)

    await cache.update([row('v', 'VIDEO'), row('i', 'IMAGE')])
    cache.release()
    expect(urls.live.size).toBe(0)
    cache.release()
    expect(urls.revoke).toHaveBeenCalledTimes(2)

    const again = await cache.update([row('v', 'VIDEO')])
    expect(again!.get('v')).toBeDefined()
    expect(urls.live.size).toBe(1)
  })

  it('fetches a reclaimed image back once, not on every refresh', async () => {
    const urls = fakeUrls()
    const { cache, download } = cacheWith(urls)

    await cache.update([row('i', 'IMAGE', false)])
    await cache.update([row('i', 'IMAGE', false)])
    await cache.update([row('i', 'IMAGE', false)])

    expect(download).toHaveBeenCalledTimes(1)
    expect(urls.live.size).toBe(1)
  })

  it('does not download a clip whose bytes were reclaimed, and gives it no URL', async () => {
    const urls = fakeUrls()
    const { cache, download } = cacheWith(urls)

    const map = await cache.update([row('v', 'VIDEO', false), row('a', 'AUDIO', false)])

    expect(download).not.toHaveBeenCalled()
    expect(map!.size).toBe(0)
  })

  it('skips an image that cannot be fetched back, offline, without failing the others', async () => {
    const urls = fakeUrls()
    const download = vi.fn(async () => {
      throw new Error('offline')
    })
    const { cache } = cacheWith(urls, download)

    const map = await cache.update([row('gone', 'IMAGE', false), row('v', 'VIDEO')])

    expect([...map!.keys()]).toEqual(['v'])
  })

  it('a refresh overtaken while downloading commits nothing and revokes what it made', async () => {
    const urls = fakeUrls()
    let finishDownload!: (blob: Blob) => void
    const download = vi.fn(
      () => new Promise<Blob>(resolve => (finishDownload = resolve))
    )
    const { cache } = cacheWith(urls, download)

    // The older refresh makes a URL for the clip, then waits on the reclaimed image.
    const older = cache.update([row('v', 'VIDEO'), row('i', 'IMAGE', false)])
    await Promise.resolve()
    // A newer refresh runs to completion first; the image is still downloading.
    const newer = await cache.update([row('a', 'AUDIO')])
    finishDownload(new Blob(['i']))

    expect(await older).toBeNull()
    expect([...newer!.keys()]).toEqual(['a'])
    // Only the newer refresh's URL survives; the older one's clip URL was revoked, not leaked.
    expect([...urls.live]).toEqual([newer!.get('a')])
  })

  it('an update still downloading when the field unmounts leaves nothing behind', async () => {
    const urls = fakeUrls()
    let finishDownload!: (blob: Blob) => void
    const download = vi.fn(
      () => new Promise<Blob>(resolve => (finishDownload = resolve))
    )
    const { cache } = cacheWith(urls, download)

    const pending = cache.update([row('v', 'VIDEO'), row('i', 'IMAGE', false)])
    await Promise.resolve()
    cache.release()
    finishDownload(new Blob(['i']))

    expect(await pending).toBeNull()
    expect(urls.live.size).toBe(0)
  })

  it('hands out a copy, so a caller cannot change what the cache will revoke', async () => {
    const urls = fakeUrls()
    const { cache } = cacheWith(urls)

    const map = await cache.update([row('v', 'VIDEO')])
    map!.clear()
    cache.release()

    expect(urls.live.size).toBe(0)
  })
})

/**
 * The tripwire for the original defect: a render-time {@code URL.createObjectURL} in a JSX
 * attribute. It is easy to write, it looks right in review, it works in a short manual test, and
 * it leaks one URL per render. The old video and audio players were exactly
 * {@code src={item.blob ? URL.createObjectURL(item.blob) : undefined}}.
 */
describe('no object URL is created in a JSX attribute', () => {
  function tsxFiles(dir: string): string[] {
    const out: string[] = []
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) out.push(...tsxFiles(full))
      else if (name.endsWith('.tsx')) out.push(full)
    }
    return out
  }

  // Comments are deliberately not stripped. A naive block-comment regex treats the `/*` in
  // `accept="image/*"` as an opening and hides the very lines this scan exists to read.

  const RENDER_TIME_URL = /=\{[^}]*createObjectURL\(/

  it('catches the shape that leaked', () => {
    expect(RENDER_TIME_URL.test('src={item.blob ? URL.createObjectURL(item.blob) : undefined}')).toBe(true)
    expect(RENDER_TIME_URL.test('src={mediaSrc.get(item.id)}')).toBe(false)
  })

  it('finds none in src', () => {
    const offences = tsxFiles('src').filter(file =>
      RENDER_TIME_URL.test(readFileSync(file, 'utf8'))
    )
    expect(offences).toEqual([])
  })
})
