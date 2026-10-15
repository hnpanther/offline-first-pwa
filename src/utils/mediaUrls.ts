import type { LocalAttachment } from '@/types'

/**
 * Object URLs for one media field's attachments: one per attachment, kept for as long as that
 * attachment is on screen, and revoked exactly once.
 *
 * <h2>Why this exists</h2>
 *
 * <p>Images always got their URL from a list that was revoked on every refresh. Video and audio
 * did not. They called {@code URL.createObjectURL(item.blob)} inline in the render, so every
 * render minted a fresh URL and none was ever revoked. That alone pins each clip's bytes in memory
 * once per render. And renders are frequent here: the recording counter ticks four times a second,
 * and a keystroke anywhere in the asset form re-renders the field. A tablet stays on one screen for
 * a whole shift. Measured in a browser: twenty re-renders of one video and one audio field left
 * forty URLs alive. Each render also handed the {@code <video>} and {@code <audio>} elements a new
 * {@code src}, so a clip the operator was playing back jumped to the start and reloaded whenever
 * anything else on the form changed.
 *
 * <h2>The three rules it keeps</h2>
 *
 * <ol>
 *   <li><b>One URL per attachment id, reused across refreshes.</b> A refresh that keeps an
 *       attachment keeps its URL, so a playing clip is not reloaded. A reclaimed image's bytes are
 *       not downloaded again just because the field refreshed. An attachment's bytes never
 *       change, so the id is a safe key.</li>
 *   <li><b>A URL is revoked when its attachment leaves the field, and on {@link release}</b>,
 *       never earlier. Nothing else revokes them.</li>
 *   <li><b>A superseded refresh commits nothing.</b> Downloading a reclaimed image is
 *       asynchronous. A second refresh can start while the first is still waiting, and the
 *       shared-array version let the late one publish URLs the newer one had already revoked: a
 *       broken image. Each {@link update} takes a generation number, and one that is no longer
 *       the newest revokes what it created and returns {@code null}.</li>
 * </ol>
 *
 * <p>Only images are fetched back when their bytes have been reclaimed, as before. A clip without
 * its bytes gets no URL, and its player stays empty rather than downloading megabytes over a
 * plant network just because a field was opened.
 *
 * <p>{@link release} is not terminal. React StrictMode runs a component's effects twice in
 * development, and the field is used again after that cleanup. A later {@link update} simply
 * starts over.
 */
export class MediaUrlCache {
  private urls = new Map<string, string>()
  private generation = 0

  constructor(
    private readonly deps: {
      create: (blob: Blob) => string
      revoke: (url: string) => void
      /** Fetches bytes this device no longer holds. Used for images only. */
      download: (id: string) => Promise<Blob>
    }
  ) {}

  /**
   * Makes the cache hold exactly one URL for each displayable row.
   *
   * @returns id → URL for the rows now on screen, or {@code null} when a newer call superseded
   *          this one (the caller must then leave its state alone)
   */
  async update(
    rows: readonly Pick<LocalAttachment, 'id' | 'kind' | 'blob'>[]
  ): Promise<Map<string, string> | null> {
    const generation = ++this.generation
    const next = new Map<string, string>()
    const createdHere: string[] = []

    for (const row of rows) {
      const existing = this.urls.get(row.id)
      if (existing) {
        next.set(row.id, existing)
        continue
      }
      let blob = row.blob
      if (!blob) {
        if (row.kind !== 'IMAGE') continue
        try {
          blob = await this.deps.download(row.id)
        } catch {
          continue
        }
        if (generation !== this.generation) break
      }
      const url = this.deps.create(blob)
      createdHere.push(url)
      next.set(row.id, url)
    }

    if (generation !== this.generation) {
      createdHere.forEach(url => this.deps.revoke(url))
      return null
    }

    for (const [id, url] of this.urls) {
      if (next.get(id) !== url) this.deps.revoke(url)
    }
    this.urls = next
    return new Map(next)
  }

  /** Revokes every URL and abandons any update still in flight. */
  release(): void {
    this.generation++
    this.urls.forEach(url => this.deps.revoke(url))
    this.urls = new Map()
  }
}
