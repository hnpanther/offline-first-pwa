import { describe, expect, it } from 'vitest'
import {
  createFormDraftCache,
  formInitialValues,
  needsFormInitialisation
} from '@/utils/formDraftCache'

/**
 * Keeping an asset form's unsaved values alive across an unmount.
 *
 * Reproduced on a tablet coming back online mid-round: the page put itself into a loading state,
 * React unmounted its whole subtree — the open asset dialog included — and react-hook-form's
 * values went with it. The dialog came back still open, rebuilt from the entry snapshot taken
 * when it was first opened, so a reading typed a minute earlier and a photo captured since were
 * both gone, silently.
 *
 * The trigger is fixed elsewhere (`shouldShowFullPageLoader`). This is the guard that makes the
 * whole class of failure survivable, whatever unmounts the dialog next: the values live in the
 * page, which stays mounted, and the form reads them back when it returns.
 */

const STORED = { Bar: '12', Pic: { type: 'attachment', ids: ['old-photo'] } }
const EDITED = { Bar: '77', Pic: { type: 'attachment', ids: ['fresh-photo'] } }

describe('holding in-progress values outside the form', () => {
  it('gives back what was last remembered', () => {
    const cache = createFormDraftCache()
    cache.remember('asset-48', EDITED)

    expect(cache.read('asset-48')).toEqual(EDITED)
  })

  it('knows nothing about an asset that was never edited', () => {
    const cache = createFormDraftCache()

    expect(cache.read('asset-48')).toBeUndefined()
  })

  it('keeps the draft after it is read, because one unmount can follow another', () => {
    // A reconnect can put the page through more than one load. If reading consumed the entry,
    // the second remount would find nothing and fall back to stored data — the original bug,
    // just harder to hit.
    const cache = createFormDraftCache()
    cache.remember('asset-48', EDITED)

    expect(cache.read('asset-48')).toEqual(EDITED)
    expect(cache.read('asset-48')).toEqual(EDITED)
  })

  it('does not hand out a reference the form can write back through', () => {
    // react-hook-form passes its own live values object to the subscriber. Storing it by
    // reference would let a later reset empty the very draft this exists to protect.
    const cache = createFormDraftCache()
    const live: Record<string, unknown> = { Bar: '77' }
    cache.remember('asset-48', live)

    live.Bar = ''
    const readBack = cache.read('asset-48') as Record<string, unknown>
    readBack.Bar = 'tampered'

    expect(cache.read('asset-48')).toEqual({ Bar: '77' })
  })

  it('separates assets, so one form cannot restore into another', () => {
    const cache = createFormDraftCache()
    cache.remember('asset-48', { Bar: '77' })
    cache.remember('asset-49', { Bar: '99' })

    expect(cache.read('asset-48')).toEqual({ Bar: '77' })
    expect(cache.read('asset-49')).toEqual({ Bar: '99' })
  })

  it('forgets an asset once its edit has concluded', () => {
    // Saved or cancelled, either way the draft is spent: restoring it later would resurrect an
    // edit the operator finished with, which reads as the app ignoring them.
    const cache = createFormDraftCache()
    cache.remember('asset-48', EDITED)

    cache.forget('asset-48')

    expect(cache.read('asset-48')).toBeUndefined()
  })

  it('drops everything when the page moves to another sheet', () => {
    // Keys are asset ids, and an asset appears in many sheets. Carrying drafts across would
    // restore one sheet's unsaved readings into another's form.
    const cache = createFormDraftCache()
    cache.remember('asset-48', EDITED)
    cache.remember('asset-49', { Bar: '99' })

    cache.clear()

    expect(cache.read('asset-48')).toBeUndefined()
    expect(cache.read('asset-49')).toBeUndefined()
  })
})

describe('deciding whether a form still needs filling in', () => {
  it('fills in a form that has just opened', () => {
    expect(needsFormInitialisation(null, 'asset-48')).toBe(true)
  })

  it('leaves a form alone once it is showing its asset', () => {
    // The defect this replaces: the reset effect re-ran whenever an unrelated prop changed
    // identity, overwriting everything typed since with the stored snapshot.
    expect(needsFormInitialisation('asset-48', 'asset-48')).toBe(false)
  })

  it('fills it in again when the operator scans a different asset', () => {
    expect(needsFormInitialisation('asset-48', 'asset-49')).toBe(true)
  })

  it('does nothing for a closed form', () => {
    expect(needsFormInitialisation('asset-48', null)).toBe(false)
    expect(needsFormInitialisation(null, null)).toBe(false)
  })

  it('treats a remount as needing to be filled in again', () => {
    // `initialisedFor` is a ref, so it is null again after an unmount — which is exactly the
    // signal that the values have to be restored, this time from the draft.
    const afterRemount = null
    expect(needsFormInitialisation(afterRemount, 'asset-48')).toBe(true)
  })
})

describe('choosing what a form opens with', () => {
  it('prefers the draft, because it is the newer of the two', () => {
    expect(formInitialValues(EDITED, STORED)).toEqual(EDITED)
  })

  it('falls back to the stored entry when there is no draft', () => {
    expect(formInitialValues(undefined, STORED)).toEqual(STORED)
  })

  it('opens empty when the asset has neither', () => {
    expect(formInitialValues(undefined, undefined)).toEqual({})
  })
})

describe('the sequence that used to lose an operator’s work', () => {
  it('restores everything unsaved when the form is unmounted and comes back', () => {
    const cache = createFormDraftCache()
    const stored = STORED
    let initialisedFor: string | null = null

    // The dialog opens on a scanned asset and fills in from stored data.
    expect(needsFormInitialisation(initialisedFor, 'asset-48')).toBe(true)
    initialisedFor = 'asset-48'
    let shown = formInitialValues(cache.read('asset-48'), stored)
    expect(shown).toEqual(STORED)

    // The operator types a reading and captures a photo. Every change is mirrored out.
    cache.remember('asset-48', EDITED)

    // A sync pass puts the page into a loading state and React takes the subtree with it.
    initialisedFor = null

    // Back again — same asset, same open dialog, and nothing was saved in between.
    expect(needsFormInitialisation(initialisedFor, 'asset-48')).toBe(true)
    shown = formInitialValues(cache.read('asset-48'), stored)
    expect(shown).toEqual(EDITED)
  })

  it('does not resurrect the draft after the entry has been saved', () => {
    const cache = createFormDraftCache()
    cache.remember('asset-48', EDITED)

    // Saving writes the values to IndexedDB and retires the draft; the stored entry now holds
    // them, and it is the source of truth from here on.
    cache.forget('asset-48')
    const savedEntry = EDITED

    expect(formInitialValues(cache.read('asset-48'), savedEntry)).toEqual(savedEntry)
  })

  it('does not resurrect the draft after the operator cancelled', () => {
    const cache = createFormDraftCache()
    cache.remember('asset-48', EDITED)

    cache.forget('asset-48')

    expect(formInitialValues(cache.read('asset-48'), STORED)).toEqual(STORED)
  })
})
