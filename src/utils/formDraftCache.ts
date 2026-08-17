/**
 * In-progress form values, held somewhere that outlives the form.
 *
 * The form an operator fills lives in a dialog. A dialog is a child, and a child can be
 * unmounted by anything happening above it — a page-level loading state, a route re-render, an
 * error boundary. React throws away its state when that happens, and react-hook-form's values
 * go with it. On the way back the form is rebuilt from stored data, so a reading typed a minute
 * ago and never saved is gone, silently, with the dialog still open.
 *
 * That is not hypothetical: it was reproduced on a tablet coming back online mid-round, and it
 * cost every unsaved field of the asset being filled — text, selections and captured media
 * references alike.
 *
 * Fixing the trigger is the primary work; this is the guard that makes the *class* of failure
 * survivable. The cache is created by the **page**, which stays mounted, and handed to the
 * dialog, which may not. Whatever the dialog last held can therefore be restored the moment it
 * comes back.
 *
 * Deliberately in memory only. This is not persistence — a saved entry goes to IndexedDB
 * through the ordinary save path. Writing every keystroke to storage would trade a rare loss
 * for constant I/O on a device that is already busy, and it would resurrect abandoned edits
 * after a reload, which nobody asked for.
 */
export interface FormDraftCache {
  /** Records the current values for a key. Called on every change; must stay cheap. */
  remember(key: string, values: Record<string, unknown>): void
  /**
   * The values held for a key, or `undefined` if none.
   *
   * Reading does **not** consume the entry: one unmount can be followed by another, and each
   * remount has to find the draft still there. Entries leave only through {@link forget}.
   */
  read(key: string): Record<string, unknown> | undefined
  /**
   * Drops a key's values.
   *
   * Called when the edit reaches a conclusion — saved (the values are in storage now) or
   * cancelled (the operator chose to discard them). Not calling it would restore an abandoned
   * draft the next time the same asset is opened, which reads as the app ignoring a cancel.
   */
  forget(key: string): void
  /** Drops everything — used when the page moves to a different log sheet. */
  clear(): void
}

/**
 * Whether a form that is showing `draftKey` still needs filling in.
 *
 * `initialisedFor` is what the form instance was last filled in for — held in a ref, so it is
 * `null` again after a remount, which is precisely the condition under which the values have to
 * be restored.
 *
 * The two answers that matter are the negatives. **A form already showing its asset must not be
 * re-initialised**: that is the failure this replaces, where an effect re-ran because an
 * unrelated prop changed identity and quietly overwrote everything typed since. And a closed
 * form is never initialised, so opening one always starts from a decided source rather than
 * from whatever the previous asset left behind.
 */
export function needsFormInitialisation(
  initialisedFor: string | null,
  draftKey: string | null
): boolean {
  if (!draftKey) return false
  return initialisedFor !== draftKey
}

/**
 * What a form should show when it opens or comes back from an unmount.
 *
 * **The draft wins whenever there is one.** It exists only if the form was holding unsaved work
 * when it went away, which makes it strictly newer than the stored entry — a snapshot taken when
 * the form opened and not moved since. Preferring the stored copy is what loses the work.
 */
export function formInitialValues(
  draft: Record<string, unknown> | undefined,
  stored: Record<string, unknown> | undefined
): Record<string, unknown> {
  return draft ?? stored ?? {}
}

export function createFormDraftCache(): FormDraftCache {
  const drafts = new Map<string, Record<string, unknown>>()

  return {
    remember(key, values) {
      if (!key) return
      // Copied rather than stored by reference: react-hook-form hands out its own live values
      // object, and keeping a reference to it would mean the "draft" mutates along with the
      // form — including being emptied by the very reset this cache exists to survive.
      drafts.set(key, { ...values })
    },
    read(key) {
      if (!key) return undefined
      const values = drafts.get(key)
      // Copied on the way out too, so a caller handing this to a form cannot write back into
      // the cache through it.
      return values ? { ...values } : undefined
    },
    forget(key) {
      drafts.delete(key)
    },
    clear() {
      drafts.clear()
    }
  }
}
