/**
 * When a page is allowed to replace everything on screen with a loading spinner.
 *
 * The rule exists because of a defect found in a live run, and it is worth stating plainly:
 * **a blocking loader unmounts the entire subtree, including any dialog the operator has open
 * and every unsaved value inside it.** React destroys the component state of everything below
 * the early return; when the load finishes and the tree comes back, the form is rebuilt from
 * stored data and whatever was typed, captured or scanned since is simply gone — with the
 * dialog still sitting open, so nothing on screen says it happened.
 *
 * A page load therefore has to distinguish two situations that look identical to a `loading`
 * flag:
 *
 * - **There is nothing to show yet** — first visit, or the operator navigated to a *different*
 *   sheet. Blocking is right: the alternative is rendering the previous sheet's data under the
 *   new sheet's identity, which is worse than a spinner.
 * - **A refresh of what is already on screen** — a background reload triggered by a sync pass,
 *   an inbox pull, a reconnect. Here the page already holds a complete, valid sheet. Blocking
 *   buys nothing and costs the operator their work.
 *
 * The comparison is on **which sheet the current data belongs to**, not on a boolean "have I
 * loaded once", because switching sheets must still block.
 */
export function shouldShowFullPageLoader(
  loading: boolean,
  loadedId: string | null | undefined,
  requestedId: string | null | undefined
): boolean {
  if (!loading) return false
  // Normalised so that "" and null/undefined — both of which mean "no sheet" — compare equal
  // and neither is ever mistaken for a real id.
  return (loadedId ?? '') !== (requestedId ?? '')
}
