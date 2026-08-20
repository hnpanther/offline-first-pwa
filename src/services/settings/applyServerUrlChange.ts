/**
 * Applies a settings save that may change the server address.
 *
 * <p>This exists as its own function for one reason: **the order of these steps is a security
 * property, and a security property that nothing tests is a comment.** It lived inline in
 * `SettingsPage`, where the only way to exercise it was to render the page.
 */
export interface ServerUrlChangeSteps {
  /** Stops the background sync loop and aborts anything already in flight. */
  stopSync: () => void
  /** Discards the stored JWT and everything derived from it. */
  clearSession: () => Promise<void>
  /** Writes the settings row, including the new server address. */
  save: () => Promise<void>
  /** Reloads onto the login screen, now pointing at the new server. */
  reload: () => void
}

/**
 * Runs the save, in the only order that cannot leak a token.
 *
 * When `reauth` is false this is just the save: nothing is stopped, nothing is cleared, and the
 * page carries on. When it is true — the origin actually changed — the session is torn down
 * *before* the new address is written:
 *
 * 1. `stopSync()`   — a request already scheduled must not fire against the new address either
 * 2. `clearSession()` — after this there is no token left to send anywhere
 * 3. `save()`       — only now does the new server exist in storage
 * 4. `reload()`     — land on the login screen for the server the operator chose
 *
 * The original code did 3 before 1 and 2, which left a window between two awaits in which a
 * background sync could read the **new** server from IndexedDB and the **old** JWT from
 * `syncMeta`, and send this plant's bearer token to a host that has no business holding it. The
 * window was small. It was also the entire thing this feature exists to prevent.
 *
 * @returns `true` if the session was torn down and the page is reloading, so the caller knows not
 *          to show a "saved" confirmation on a page that is going away.
 */
export async function applyServerUrlChange(
  reauth: boolean,
  steps: ServerUrlChangeSteps
): Promise<boolean> {
  if (!reauth) {
    await steps.save()
    return false
  }

  steps.stopSync()
  await steps.clearSession()
  await steps.save()
  steps.reload()
  return true
}
