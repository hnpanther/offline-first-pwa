# Synchronisation

How data moves between the tablet and the server, in what order, and what happens when each
step fails.

**Code:** [`src/services/sync/`](../src/services/sync/) — `index.ts` (the manager),
`pullBootstrap.ts`, `pullInbox.ts`, `logSheetSync.ts`, `attachmentSync.ts`,
`mergeLogSheetBundle.ts`, `cleanupLogSheets.ts`

---

## The shape of it

```
        PULL (server → device)                PUSH (device → server)

  GET /api/bootstrap    ── master data      POST /api/log-sheets/batch  ── drafts,
  GET /api/log-sheets/inbox ── my sheets                                   submissions,
  GET /api/log-sheets/{id}/bundle ── one                                   actions
        sheet, everything needed offline    POST /api/attachments       ── one file
                                                                           at a time
                                            POST /api/nfc-fault-reports/batch
```

Two rules hold the whole design together:

1. **The device is the source of truth for work it performed.** A reading taken in the field
   exists whether or not the server has heard of it. Sync is delivery, not authorisation.
2. **Every push is idempotent.** Each item carries a `clientActionId` the device mints. A
   request that times out and is retried is applied once. Without this, a flaky link produces
   duplicate history, which is unrecoverable.

---

## When sync runs

| Trigger | Where |
|---|---|
| On an interval | `settings.syncIntervalMs` (default 30 s, clamped 10 s–1 h) |
| When the browser comes back online | `handleOnline` — the `online` event |
| On demand | The sync button |

```ts
private intervalMs = 30_000
private handleOnline = (): void => { … }
```

`syncInFlight` and `isSyncing` guard re-entry: a tick that arrives while the previous one is
still running is dropped rather than queued. Two concurrent passes would push the same items
twice, and idempotency should be the safety net, not the mechanism.

> **The interval is stored in milliseconds and displayed in seconds.** Convert on exactly one
> side. See [`services/settings/syncInterval.ts`](../src/services/settings/syncInterval.ts) —
> converting twice silently multiplied the stored value by 1000 on every save.

---

## The push sequence

From `executeSync()`:

### 1. A session, or nothing

```ts
const session = await getAuthSession()
if (!session) return
```

### 2. A session user id, or nothing

```ts
const sessionUserId = await ensureSessionUserId()
if (!sessionUserId) return
```

**This is the main place the binding heals**, because sync ticks on a timer and on every
reconnect. Without an id nothing below can be attributed — the outbound queue would come back
empty anyway, so returning here is the same outcome stated honestly. Continuing would show a
zero pending badge, which reads as "everything is sent."

### 3. Expire what has visibly lapsed

```ts
await this.markExpiredSheets()
```

A sheet whose deadline passed while the device was offline is marked locally, so the operator
sees the truth before a round trip rather than after.

### 4. Collect what is pending

Log sheets and fault reports in parallel. Fault reports are collected **only if the session
holds the permission**:

```ts
const canSyncFaultReports = hasPermission(session, 'POST:/api/nfc-fault-reports/batch')
```

Queuing items the server will refuse would leave a pending count that never drains.

### 5. Nothing to submit is not nothing to do

```ts
if (totalPending === 0) {
  await this.syncAttachments()   // attachments queue independently
  await this.refreshPendingCount()
  return
}
```

**Attachments are a separate queue.** A sheet that synced on an earlier pass can still be
waiting on its photos, and a 20 MB video must never block a 2 KB set of readings. This is the
single most important structural decision in sync.

### 6. Push the sheets, then bind the attachments

```ts
if (result.outcome === 'SUBMITTED') {
  await updateLogSheet(ls.localId, { syncStatus: 'synced', serverId: …, serverStatus: 'SUBMITTED' })
  if (serverId) {
    await bindAttachmentsToServerSheet(ls.localId, serverId)
  }
}
```

**The sheet now exists on the server, so its attachments finally have somewhere to go.** Until
that stamp lands the upload queue skips them by design — an attachment referencing a sheet the
server has never seen would be rejected, and retried forever.

---

## Submission outcomes

The batch endpoint returns an outcome per item, and each means something different to the
device:

| Outcome | Meaning | Device does |
|---|---|---|
| `SUBMITTED` | Accepted | Mark synced, stamp `serverId`, release attachments |
| `DUPLICATE` | Already had it (a retry) | Treat as success — this is idempotency working |
| `EXPIRED` | Deadline passed server-side | Keep the data, surface the state; **not** an error |
| `CANCELLED` | The round was called off | Same |
| `VOIDED` / other | Server refused | Keep the data, show why |

> **A refused submission is never discarded.** The operator did the work. The server stores the
> payload in `log_sheet_void_submissions` and the device keeps its copy, so a supervisor can
> un-void it and nothing is lost to a timing problem. See `docs/log-sheets.md` in the backend
> repository.

**Archived sheets take a different path.** `parseArchivedLogSheetViewId` detects a sheet that
was completed and archived, and `applyArchivedLogSheetOutcome` records the result against the
archive rather than the live store — a resubmission of history must not resurrect it as active
work.

---

## Deadlines, offline

**A deadline is judged on when the work was done, not when it reached the server.** An operator
who finishes at 17:55 against an 18:00 deadline and only finds signal at 19:30 keeps their
round. This is `isLogSheetExpiredForSync` on the device and `submitIfStillCompletable` on the
server, and both sides have to agree or offline work is lost to the clock:

| | Device (`isLogSheetExpiredForSync`) | Server (`submitIfStillCompletable`) |
|---|---|---|
| Submitted locally, `completedAt ≤ dueAt` | Still queued, however late the link returns | Accepted — **even if the sheet is already `EXPIRED`** |
| Submitted locally, `completedAt > dueAt` | Refused before it is queued | Refused → void submission |
| Still a draft | Judged on the wall clock — there is no completion to date it by | n/a |

A `serverStatus` of `EXPIRED` overrides the stamps in both directions: the server said so, and
the device does not argue with it except through the completion time above.

## What an inbox pull does to offline work

`mergeInboxIntoLocalSheets` is where every server-side lifecycle decision lands on the device.
It runs on every pass, against rows that may hold hours of work nobody else has a copy of, so
its rule is narrow: **update what the server owns, never destroy what the operator did.**

| While the tablet was offline | On the next pull |
|---|---|
| The deadline passed | The draft is marked `EXPIRED` locally (`expireStaleLocalDrafts`) — the operator learns it before a round trip, and the readings stay |
| A supervisor **extended** an expired round | New `dueAt`, status back to `IN_PROGRESS`, failure banner cleared, readings intact, submittable again |
| A supervisor **cancelled** the round | The sheet leaves the inbox and the draft is blocked. The readings stay — a cancel is reopenable |
| A cancelled round was later **extended** | Same as the extension row: it comes back editable, with the work still in it |
| A completion was rejected as `EXPIRED` but finished **in time** | Re-queued with a **fresh `clientActionId`** — the old one was already answered, so reusing it would read as a replay |
| A completion genuinely finished **late** | Left refused. Reviving it would push work the server has already ruled on, on every pass, forever |
| A completion was submitted but never sent, and the deadline passed | Marked failed/`EXPIRED`, data kept, available as a void submission when it is pushed |
| Nothing changed | Nothing changes — the merge is idempotent across passes |

> **Absence is not a reason.** The inbox says only that a sheet is no longer assigned, never
> why: released, reassigned or cancelled all look identical. `shouldMarkDraftRevokedForMissingInbox`
> therefore blocks the draft either way but only ever *adds* the vaguer «واگذار شده» wording —
> once the row already knows it was `CANCELLED`, from opening the sheet online or from a
> `CANCELLED` submit outcome, a later pull must not talk it back down to a guess.

Regression tests: [`logSheetLifecycle.test.ts`](../src/services/sync/logSheetLifecycle.test.ts).

---

## Pull

### `pullBootstrap`

Master data plus server-owned settings (the attachment ceilings). Staleness-gated:

```ts
pullBootstrapIfStale(maxAgeMs)
```

> The comparison is `elapsed >= maxAge`, not `>`. With `maxAgeMs = 0` — "pull now" — a strict
> `>` is false when no time has passed, so a forced pull did nothing. A test caught this; the
> code was wrong, not the test.

The attachment limits arriving here are what let the device refuse an oversized file **before**
the operator records it rather than after.

### `pullInbox`

The operator's sheets: assigned plus claimable pool.

### Bundle merge

`mergeLogSheetBundle` merges a server bundle into local state **without clobbering unsynced
local edits**. A sheet the operator has been filling must not be overwritten by the server's
older copy of it. This is the most delicate code in the sync layer and has the most tests.

---

## Attachment upload

**Code:** [`attachmentSync.ts`](../src/services/sync/attachmentSync.ts)

- **Only this operator's own work.** See below — on a shared tablet this is the difference
  between delivering evidence and destroying it.
- **One file at a time.** Concurrent large uploads on plant Wi-Fi finish nothing.
- **Only for sheets that exist on the server** — gated on `logSheetServerId`.
- **`syncStatus` is the queue**, and it is indexed.
- **Failure is retried, not dropped.** The blob stays until the server confirms it.
- **Deleted after confirmation**, and only then — the device's copy is the only copy until the
  server has it.
- **Deletions drain first**, before any upload in the same pass.

### Deleting is sync work too

A pass runs `drainPendingDeletes()` and only then the uploads. Both halves exist because the
server enforces the per-field ceiling over **its own** attachments: a deletion that never
reached it leaves a file nobody can see holding a slot, and the operator's replacement is
refused for a field that looks half empty.

| Situation | What happens |
|---|---|
| Delete, sheet not submitted | Marked `pendingDelete`, hidden everywhere at once, `DELETE /api/attachments/{id}` on the next pass, then the row goes |
| Delete, sheet submitted | Local row goes; the server keeps its copy — delivered evidence |
| Delete while offline | Marked and queued; delivered when the link returns |
| Sheet submitted before the queued delete drains | The deletion is dropped, not applied |
| File never uploaded | Row deleted outright — there is nothing on the server to remove |
| Server answers 404 | Treated as done; the end state is what mattered |

Deletions run first so a replacement captured after one is accepted on the **same** pass rather
than being refused and waiting for the next tick. And a "field is full" refusal is a **409**,
which `isPermanentFailure` deliberately excludes: unlike a rejected file type, it stops being
true as soon as a slot frees, so the file stays queued instead of being parked forever.

### Whose files these are

A tablet is shared; captured media is not. **Signing out removes the session key and nothing
else** — every sheet, blob and queue row stays, because on an offline round it is the only copy
of the work.

So "queued on this device" and "this operator may send it" are different sets, and treating them
as one cost a round of evidence in the plant:

> Operator 1 of unit 1 took a round offline, photographed the equipment, and signed out still
> offline. Operator 2 of unit 2 picked the tablet up, connected and signed in. The pass pushed
> operator 1's files under operator 2's token; the server refused each with **403**, correctly;
> the refusal was read as permanent, so the files were **parked** — and when operator 1 signed
> back in, the queue no longer offered them at all.

`isAttachmentUploadableByUser` is the gate, on uploads and on server-side deletions alike:

| Situation | Sent? |
|---|---|
| The sheet is this operator's work | Yes |
| Assigned to them, nothing saved locally yet | Yes |
| Belongs to another operator | No — left untouched for them |
| No sheet row to prove ownership by | No — uploading on a guess is what caused the defect |
| Sheet already delivered (`synced`) but photos still queued | Judged by ownership like any other; this is the case shared-tablet isolation deliberately leaves alone, and it is what leaked |
| Sheet revoked or superseded | No — the server would refuse it on every pass forever |

**403 is not a permanent failure**, for the same reason 409 is not: it describes who was signed
in, not the file. The status is recorded on the row (`failedStatus`) because `syncError` holds
the backend's own translated sentence and cannot be classified later. Signing in gives the owner
back any row parked with 403 — or with no recorded status at all, which means a build that
predates the field and is exactly the stranded population.

The pending badge counts the same filtered set. A shared tablet must never show a number that
cannot reach zero: it reads as broken sync, and invites someone to "fix" it by clearing the
device, which is how the evidence would actually be lost.

---

## Conflict rules

| Situation | Resolution |
|---|---|
| Server changed master data | Server wins — it is reference data |
| Device has an unsynced draft | Device wins — the server has no competing version |
| Device submits an expired sheet | Server records it as a void submission; nothing is lost |
| Same sheet submitted twice | `clientActionId` makes the second a `DUPLICATE` |
| Two operators on one pool sheet | The server's claim guard settles it; the loser gets a refusal outcome and keeps their data |
| Server reopened a completion the device already delivered | Server wins — but only the operator may act on it, through the fill page's continue action (below) |

---

## Reopening a delivered completion

Once a completion syncs, the server owns it: the device has no way back to a draft, and that is
deliberate — otherwise an operator could reopen work a supervisor considers final. The way back
is a supervisor **reopening** the sheet (`POST /log-sheets/{id}/reopen`, new deadline), which
returns it to `IN_PROGRESS` with the readings intact.

The device handles that in two separate halves, and the separation is the design:

**Detection is passive.** The reopened sheet is back in the operator's assigned inbox, so the
ordinary merge writes the fresh `serverStatus` and `dueAt` onto the local row and changes
nothing else. The row stays `submitted`/`synced` — a combination that cannot arise any other
way, which is what `isReopenedAfterSync` reads. `alignLocalWorkflowWithServer` is untouched by
this feature and still returns `null` for a synced row whose assignee has not changed.

**Resuming is explicit and server-verified.** The fill page's «ادامه‌ی کار» re-fetches the
bundle and runs `canContinueReopenedLogSheet` against it before any local change:

```ts
await resetLogSheetToOpenDraft(localId)   // keeps entries, drops clientActionId
await applyLogSheetBundle(bundle)         // now takes the plain draft path
```

> **The order is load-bearing.** Reversed, the bundle apply hits the `synced` short-circuit and
> does nothing at all — a button that silently fails.

Why re-fetch when the merge already used a fresh bundle: that inbox response may have been read
from the server *moments before* this device's own submission landed, which would make a
just-completed sheet look reopened. A fetch issued while the row is already `synced` cannot see
that state, because the `synced` stamp is only written after the server committed the completion.

`cleanupLogSheets` holds a reopened row back from the 24-hour synced purge while its new
deadline stands — it is live work, and it is also the only place `filledVia` survives.

---

## A sync pass must not disturb the screen

Sync runs on a timer and on every reconnect, while an operator is mid-round with a form open. So
a pass is only allowed to *update* what is on screen — never to rebuild it.

The line that matters is **`loading`**. A page that renders a blocking loader unmounts its whole
subtree, and React destroys the state of everything in it, including react-hook-form's values in
an open asset dialog. The dialog then comes back still open, rebuilt from stored data, with
everything typed or captured since silently gone.

`LogSheetFillPage` therefore keeps two separate paths:

| Effect | Trigger | Sets `loading`? |
|---|---|---|
| Load | route id, or the session identity behind it | **Yes** — but `shouldShowFullPageLoader` blocks only while the sheet on screen is not the one being asked for |
| Inbox refresh | `inboxLastSyncAt` — every pass | **No.** Re-reads the row and re-renders, nothing more |

> **Identity churn is not a reason to reload.** The load effect used to depend on a callback that
> closed over `inboxAssignedIds`, which is rebuilt from a new array on every inbox pull — so each
> pass triggered a full reload, bundle fetch included, and took the open form with it. The check
> is read through a ref now, and the effect depends on `hasAuthSession` rather than the session
> object.

Unsaved values are additionally mirrored into a `FormDraftCache` held by the page, so an unmount
from any *other* cause restores rather than loses. See `AGENTS.md` for the full rule.

## Debugging

| Symptom | Look at |
|---|---|
| Pending count never drops | Is `ensureSessionUserId()` returning null? Sync returns early. |
| Attachments stuck | Does the sheet have a `serverId` yet? The queue skips unbound files by design. |
| Sync never fires | `settings.syncIntervalMs` — if it was corrupted to an enormous value, `clampSyncInterval` now catches it. |
| Duplicate history on the server | A missing or regenerated `clientActionId`. |
| A draft was overwritten | `mergeLogSheetBundle` — start from its tests. |
| An open form emptied itself mid-round | Something set the page's `loading` again. See the section above. |

## Related

- **[storage.md](storage.md)** — what is stored locally
- **[device-features.md](device-features.md)** — NFC, camera, GPS, orientation
- **[../AGENTS.md](../AGENTS.md)** — the traps
- **Backend repo → `docs/log-sheets.md`** — the endpoints on the other end
