/**
 * Applies a settings save that may change the server address.
 *
 * <p>This exists as its own function for one reason: **the order of these steps is a security
 * property — and, since the address can strand a device, a data-safety one — and a property that
 * nothing tests is a comment.** It lived inline in `SettingsPage`, where the only way to exercise
 * it was to render the page.
 */
export interface ServerUrlChangeSteps {
  /**
   * Asks the new address whether this plant's server answers there — `GET /api/health`, the same
   * probe as the dot on the login page. Only run when the origin changes.
   */
  verify: () => Promise<boolean>
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
 * What happened, so the page knows what to show.
 *
 * - `saved` — an ordinary save; the page stays and may say so.
 * - `unreachable` — the new address did not answer; **nothing** was changed.
 * - `reloading` — the session was torn down and the page is going away.
 */
export type ServerUrlChangeOutcome = 'saved' | 'unreachable' | 'reloading'

/**
 * Runs the save, in the only order that can neither leak a token nor strand the device.
 *
 * When `reauth` is false this is just the save: nothing is checked, stopped or cleared, and the
 * page carries on. When it is true — the origin actually changed:
 *
 * 0. `verify()`       — the new address must answer **before anything is touched**
 * 1. `stopSync()`     — a request already scheduled must not fire against the new address either
 * 2. `clearSession()` — after this there is no token left to send anywhere
 * 3. `save()`         — only now does the new server exist in storage
 * 4. `reload()`       — land on the login screen for the server the operator chose
 *
 * <h2>Why step 0 refuses rather than warns</h2>
 *
 * Settings is reachable only by a plant-wide administrator, *after logging in* — and logging in
 * goes to the stored address. Once a wrong address is saved and the session is gone, nobody can
 * log in to change it back: a typo, an `http://` address the packaged app refuses to send
 * (`cleartextTrafficPermitted="false"`), a certificate from a CA the app does not trust. The only
 * way out is clearing the app's data, which destroys every reading that has not reached the
 * server. A save that cannot be undone on the device is refused while it can still be refused.
 *
 * <p>The cost is that an address cannot be configured ahead of the server answering on it. That is
 * the right trade: the old address keeps working until the new one does, and that ordering is the
 * one the deployment docs prescribe anyway.
 *
 * <h2>Why steps 1–3 are in this order</h2>
 *
 * The original code did 3 before 1 and 2, which left a window between two awaits in which a
 * background sync could read the **new** server from IndexedDB and the **old** JWT from
 * `syncMeta`, and send this plant's bearer token to a host that has no business holding it. The
 * window was small. It was also the entire thing this feature exists to prevent.
 */
export async function applyServerUrlChange(
  reauth: boolean,
  steps: ServerUrlChangeSteps
): Promise<ServerUrlChangeOutcome> {
  if (!reauth) {
    await steps.save()
    return 'saved'
  }

  // A probe that throws — synchronously or not — is a probe that did not hear the server. Same
  // answer, same refusal.
  let answers = false
  try {
    answers = (await steps.verify()) === true
  } catch {
    answers = false
  }
  if (!answers) return 'unreachable'

  steps.stopSync()
  await steps.clearSession()
  await steps.save()
  steps.reload()
  return 'reloading'
}
