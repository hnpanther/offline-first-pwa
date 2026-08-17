import { describe, expect, it } from 'vitest'
import { shouldShowFullPageLoader } from '@/utils/pageLoadState'

/**
 * When the fill page is allowed to blank itself out.
 *
 * The bug this exists for, found in a live run: the page returned a full-screen spinner for any
 * `loading`, and `loading` was set again on every sync pass that refreshed the inbox. React
 * unmounts everything below an early return, so each refresh destroyed the open asset dialog and
 * its react-hook-form state. The dialog reappeared a moment later, still open, rebuilt from
 * stored data — with the operator's typed readings, selections and freshly captured photo
 * references gone and nothing on screen to say so.
 *
 * The rule below is what separates "I have nothing to show" from "I am refreshing what is
 * already on screen". Only the first may block.
 */
describe('deciding when to block the whole page with a loader', () => {
  it('blocks on the first load, when there is genuinely nothing to show', () => {
    expect(shouldShowFullPageLoader(true, null, 'sheet-1')).toBe(true)
  })

  it('does not block while refreshing the sheet already on screen', () => {
    // The case that cost an operator their work: same sheet, a background reload.
    expect(shouldShowFullPageLoader(true, 'sheet-1', 'sheet-1')).toBe(false)
  })

  it('blocks when the route moved to a different sheet', () => {
    // Not blocking here would render sheet-1's assets and readings under sheet-2's identity
    // until the load finished — worse than a spinner, because it looks like real data.
    expect(shouldShowFullPageLoader(true, 'sheet-1', 'sheet-2')).toBe(true)
  })

  it('never blocks when nothing is loading', () => {
    expect(shouldShowFullPageLoader(false, null, 'sheet-1')).toBe(false)
    expect(shouldShowFullPageLoader(false, 'sheet-1', 'sheet-2')).toBe(false)
  })

  it('treats an absent id and an empty id as the same "no sheet"', () => {
    // Both mean "nothing loaded". Letting them differ would leave the page blocked forever on a
    // route with no id, or blink a spinner for a difference that is not one.
    expect(shouldShowFullPageLoader(true, null, undefined)).toBe(false)
    expect(shouldShowFullPageLoader(true, '', null)).toBe(false)
  })
})
