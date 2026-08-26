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

  GET /api/bootstrap    ── master data      POST /api/log-sheets/progress ── what a round
  GET /api/log-sheets/inbox ── my sheets                                     has recorded
  GET /api/log-sheets/{id}/bundle ── one                                     so far
        sheet, everything needed offline    POST /api/log-sheets/batch    ── completions
                                            POST /api/attachments         ── one file
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

> **A round in progress is visible to a supervisor within one interval.** The progress push runs
> on this same timer, so «N از M دارایی» on the panel lags by at most `syncIntervalMs`. Saving an
> asset deliberately does *not* fire an immediate sync: the inbox tick is already the fleet's cost
> driver (see below), and one request per asset save would multiply it by the size of a round.

> **Lowering the interval costs the server, not the tablet.** Every tick calls
> `GET /api/log-sheets/inbox`, and the server rebuilds a **full bundle per assigned sheet** on
> each call — roughly a dozen queries each, with no conditional GET, because the inbox is what
> pre-provisions a tablet to work offline rather than a listing. So the load is
> `tablets × assigned sheets × ~12 queries ÷ interval`, and halving the interval doubles it
> across the whole fleet. Comfortable at this deployment's size; the arithmetic and the three
> ways out are written down in the backend's
> [`docs/roadmap.md`](../../../JavaProject/backend-offline-first/docs/roadmap.md) § 3. Check it
> before making the app "feel more responsive" this way.

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

### 3b. Report how far the open rounds have got

```ts
if (hasPermission(session, PERM_LOG_SHEET_PROGRESS)) {
  await this.pushProgress()
}
```

**A separate queue from the submissions, and the separation is the whole design.** A submit
delivers work the operator has finished and must never be lost; a progress report is a live
statement about work in progress, and losing one costs nothing. Its own try/catch, its own
permission, its own fields on the row (`progressSyncStatus`, `progressSyncedAt`,
`progressError`) — **nothing in this path writes `status`, `syncStatus` or `syncError`.** Those
belong to the submit queue, and a refused progress push writing them is how real, undelivered
readings would end up marked failed.

Gated on the permission for the same reason fault reports are: queuing items the server will
refuse leaves a queue that never drains. It is a distinct permission server-side, so holding
`POST:/api/log-sheets/batch` does not imply it.

**Only what changed is sent.** `dirtyEntriesForProgress` filters on `locallyEditedAt` — the only
marker that means "somebody edited this *on this device*" (see the bundle-merge section for why no
question about `formData` can answer that). Since an accepted push clears the marker, "has a
marker" is exactly "changed since the last accepted report". A cleared answer is dirty too: an
emptying save stamps the marker, so a deliberate clear is reported like any other edit and the
server's `wouldBlankUnseenAnswer` decides whether to honour it.

**The marker is cleared conditionally**, and both simplifications fail:

| | What breaks |
|---|---|
| Clear every marker | An edit made while the request was in flight is lost — the row takes the server's older value on the next merge |
| Clear none | The device wins those entries on every future merge, so a supervisor's correction in the browser never reaches the tablet — log sheet 85 by a third route |

So the payload build snapshots each entry's marker, and only entries still holding that exact
value are cleared. The row is re-read after the response rather than reused, for the same reason.

**Not counted in the pending badge.** The badge means "work not yet on the server"; a round being
walked always has some, so counting it would show a number that reads as broken sync for the whole
shift. The fill page shows «آخرین ارسال پیشرفت به سرور» instead.

Shared tablets: `isLogSheetProgressOwnedByUser` mirrors `isLogSheetOutboundOwnedByUser` with
`status` inverted — open work rather than delivered work — and refuses unprovable ownership, a
revoked or superseded row, and an expired or cancelled round. Pushing a colleague's draft under
the signed-in operator's token would publish one person's readings under another's name and earn
the 403 that once cost a round's photographs.

Outcomes: `SAVED` / `NO_CHANGE` are accepted; `SUPERSEDED`, `CANCELLED`, `EXPIRED`,
`VALIDATION_ERROR`, `ERROR` are recorded on `progressSyncStatus` and nowhere else. There is no
`DUPLICATE` — progress carries no `clientActionId`, because it is *meant* to be re-sent.

Regression: [`progressSync.test.ts`](../src/services/sync/progressSync.test.ts).

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
| `SUBMITTED` | Accepted | Mark synced, stamp `serverId`, release attachments. (The *outcome* name; the sheet's later `APPROVED` status is a separate thing — see below) |
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
| A supervisor **approved** the completed round | The local row takes `serverStatus: 'APPROVED'` and stays delivered. Nothing else changes: the readings are the record of what happened at the equipment, and a review is not a reason to touch them |
| Nothing changed | Nothing changes — the merge is idempotent across passes |

> **Absence is not a reason.** The inbox says only that a sheet is no longer assigned, never
> why: released, reassigned or cancelled all look identical. `shouldMarkDraftRevokedForMissingInbox`
> therefore blocks the draft either way but only ever *adds* the vaguer «واگذار شده» wording —
> once the row already knows it was `CANCELLED`, from opening the sheet online or from a
> `CANCELLED` submit outcome, a later pull must not talk it back down to a guess.

Regression tests: [`logSheetLifecycle.test.ts`](../src/services/sync/logSheetLifecycle.test.ts).

---

## `APPROVED`: a status this device must treat as ordinary

The server gained an `APPROVED` status — a supervisor's sign-off laid on top of `SUBMITTED`. On
this device it means **exactly** what `SUBMITTED` means: the round is delivered, the server owns
it, and nothing here behaves differently.

That sounds like it needs no work, and that is the trap.

**An unhandled status is not inert.** Every branch of `alignLocalWorkflowWithServer` ends in
`return null`, which means *nothing to do*. A status it does not recognise therefore falls all the
way through and leaves the stale local draft **alive and editable** for a round the server has
closed. The operator edits it, submits, the server voids it as superseded — and from their side
the work simply vanished, with no error anywhere on either machine.

So the completed test is a named function rather than a comparison, and every check that read
`serverStatus === 'SUBMITTED'` now goes through it:

```ts
// src/types
export function isCompletedServerStatus(status?: LogSheetServerStatus | null): boolean {
  return status === 'SUBMITTED' || status === 'APPROVED'
}
```

| Reader | Why it has to accept both |
|---|---|
| `alignLocalWorkflowWithServer` | Resolves the local copy — `'mark-synced'`. The failure above |
| `canContinueReopenedLogSheet` | Refuses «ادامه‌ی کار» on a closed round. An approved round is *further* from reopenable than a completed one |
| `canSubmitLogSheet` | Blocks a second submit of work the server already holds |
| `isSupersededSyncError` | Recognises "somebody else's completion beat mine" |
| `loadLogSheetsForSessionUser` | Decides whether an archived row was this operator's own completed work |

Two writes are worth knowing about:

- **`applyLogSheetBundle` stores the server's own status**, `serverSheet.status ?? 'SUBMITTED'`,
  where it used to hard-code `'SUBMITTED'` on the completed branch. That was harmless while
  `SUBMITTED` was the only completed status and became a lie the day `APPROVED` existed — the row
  would disagree with the server about a value the list chip and the reopen detection both read.
- **The batch-submit outcomes still write `'SUBMITTED'`**, because that is genuinely what the
  response tells us: an outcome of `SUBMITTED` means this device just delivered it, and a
  `DUPLICATE` or `SUPERSEDED` carries no status at all. The next bundle refresh corrects a round
  that had already been approved. Nothing reads the difference — both go through
  `isCompletedServerStatus`.

**An approved sheet is never in the inbox** (the server's inbox is `ASSIGNED` and `IN_PROGRESS`
only), and `shouldMarkDraftRevokedForMissingInbox` has an allow-list of `ASSIGNED` /
`IN_PROGRESS` / `PENDING` — so its absence is not read as a revocation.

Regression tests: [`approvedLogSheet.test.ts`](../src/services/sync/approvedLogSheet.test.ts) and
the `APPROVED` cases in [`logSheetWorkflow.test.ts`](../src/utils/logSheetWorkflow.test.ts).

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

### The local-work archive, and the round trip that broke it

There is **one local row per server sheet**, and a tablet is shared. So when a sheet's ownership
moves, the row has to be cleared — otherwise the next operator opens it and finds the previous
one's readings. `alignLocalWorkflowWithServer` returns `reset-draft`, and `applyLogSheetBundle`
calls `archiveLocalWorkBeforeClear` **before** clearing: the operator's values are copied into
`logSheetUserArchives`, keyed by `(serverId, userId)`.

`loadLogSheetsForSessionUser` then merges those archives back into what the operator sees, as
read-only cards with a synthetic `archive:{serverId}:{userId}` id.

#### The rule that decides whether an archive is shown

```ts
if (
  liveRow &&
  resolveLocalWorkOwner(liveRow) === userId &&
  sheetHasLocalEntryData(liveRow) &&
  !archiveHoldsWorkTheLiveRowLacks(archived, liveRow)
) {
  continue          // the live row is the real copy; the archive is noise
}
```

Both of the last two clauses are fixes for bugs that were reproduced end to end, and the
reasoning is worth keeping.

**`sheetHasLocalEntryData` — ownership comes back, the work does not.**

- **A false revoke during sync** leaves the live row still holding the operator's values. Two
  cards for one sheet would be confusing and the archive adds nothing — hide it.
- **A reassignment** clears the live row. If the sheet is later assigned **back**, the same user
  owns that now-empty row again — so an ownership-only rule skipped the archive as stale and the
  readings became unreachable. They were still on disk and shown nowhere.

**`archiveHoldsWorkTheLiveRowLacks` — a partial restore is not a finished one.** Restore one of
two archived assets and the live row now holds work, so the sheet-level check above hid the card
— taking the restore button with it and stranding the second asset exactly the way the original
bug stranded everything. The question is therefore asked per asset: does the archive still hold
an answered asset the live row has nothing for? Found by running a two-pass restore in a browser
after a green suite; `restoreRoundTrip.test.ts` § *a restore finished in two passes* is the
regression, including the counterweight that a **complete** restore still drops the card.

#### Showing it is automatic; copying it back never is

Nothing is copied into the live sheet on its own, deliberately. The archive carries
`locallyEditedAt` markers, so restored values **win the next merge** — and while the sheet
belonged to somebody else, that somebody may have recorded their own readings, which an automatic
restore would bury with no trace. That is the log sheet 85 failure by another route.

So the copy back is an action the operator takes, having seen what it would replace. That is the
next section.

#### When the archive is removed

Two ways. Either the sheet is `submitted` + `synced` for that user — the work reached the server,
so there is nothing to recover and a permanent duplicate of their own round would be noise — or
the operator restored **everything** the archive still had to offer. A partial restore keeps it,
so the rest stays reachable rather than being stranded the way the original bug stranded it.

There is no time-based purge: an archive whose sheet never completes stays until it does.

Covered by `reassignRoundTrip.test.ts` (14 cases, including the neighbouring states the rule
must not have broken) and `liveReassignRoundTrip.test.ts` (the same sequence over bundles
captured from a running server).

### Restoring an archived round

`restoreArchivedWork.ts` — `buildRestorePlan` and `restoreArchivedEntries`. The operator taps
**بازگرداندن مقادیر** on the archived History card, ticks the assets they want, and those are
written into the live sheet, which they then review and submit as normal.

#### Why per asset, and why conflicts start unticked

An asset the live sheet already answers is a **conflict**: somebody recorded a reading there
while they held the sheet. Both versions are shown, field by field with the class's own labels,
and the checkbox starts **off**. Assets nobody touched start on, because for those there is no
real decision. Nothing about the archive is destroyed by declining.

#### What a restore writes

Per chosen asset, starting from the live entry so a field the archive says nothing about is left
alone:

| | |
|---|---|
| A filled archived value | overwrites the live value |
| A **blank** archived value | is skipped — the operator's own blank is not a reading, and restoring it over somebody else's value would be a deletion dressed as a restore |
| `locallyEditedAt` | stamped **now**, not carried from the archive. The opinion is being formed at this moment by an operator who has just compared both versions; carrying the old timestamp would claim the edit predates values the server has since sent |
| `createdAt` / `updatedAt` | **not** restored. Those are the version of the entry this device last saw, echoed back on submit and checked by the server's `wouldBlankUnseenAnswer`. The live row's are current; the archive's are stale |
| `filledVia` | carried from the archive — the server never sends it back, so losing it would relabel a hand-entered row as NFC-scanned |
| `filledByName` | cleared, exactly as an ordinary save clears it. Attribution is the server's to re-stamp |

#### The attachment rule

Media is not in `formData`: the bytes live in `db.attachments`, and the form value holds only a
list of ids. Clearing the live row dropped those ids and left every file on the device — so the
field renders empty while the files are still there, and no amount of retyping brings a
photograph back. This is the half of the bug that had no workaround.

The invariant, which is what the tests assert directly:

> For every (asset, field) a restore writes, the ids in `formData` are **exactly** the ids of the
> attachment rows this device holds for that (sheet, asset, field), excluding rows already queued
> for deletion — deduplicated, and never an id that resolves to nothing.

Three consequences, each deliberate:

- **Nothing missing.** A file on the device is referenced even if the archive never knew about it
  — another operator may have captured it on this tablet. Dropping a reference does not delete
  the file, it hides it, and hiding somebody's photograph is a failure this codebase has already
  paid for once.
- **Nothing extra.** An id whose row is gone is not written. A dangling reference renders as a
  broken slot and misleads the field's counter. Those ids are counted and **shown** to the
  operator instead, so the loss is not silent.
- **Never an empty reference.** A field with no surviving rows is omitted from the restored
  `formData` entirely, rather than written as `{type:'attachment', ids:[]}` — a key that means
  "nothing" is exactly the contamination gotcha #87 is about.

No blob is read, moved, re-encoded or deleted. A restore is a reference-level operation, and
`restoreRoundTrip.test.ts` asserts the attachment table is byte-for-byte identical afterwards.

The per-field ceiling is **not** re-checked here. The server enforces it per
(sheet, asset, field, kind) at upload, as a 409 that frees itself; referencing files that already
exist on the device cannot make that worse, and dropping one to fit would be "missing".

#### When it refuses

`restoreArchivedEntries` rebuilds the plan internally, so a sync that landed between the dialog
opening and the operator confirming cannot make it write something they were never shown:

| Refusal | Means |
|---|---|
| `no-archive` | the archive is gone (submitted and synced, or already fully restored) |
| `no-live-sheet` | no local row for that server id |
| `not-your-work` | the sheet has been handed to somebody else again |
| `sheet-not-editable` | the live sheet is no longer a draft |

Each maps to its own Persian message, because "try again" and "this is not yours any more" call
for different things from the operator.

#### Two things a design for this got wrong, worth not re-proposing

This was designed on paper first (it was §7 of the server repo's `docs/roadmap.md`, now removed
because it is built). Two parts of that design were changed on contact with the code:

- **"Offer it only when the live row is empty."** That hides the action in precisely the case
  where the operator most needs it — the other operator did part of the round, and somebody has
  to decide which version stands. Those assets are shown as conflicts instead, both values
  visible, unticked.
- **"Record *why* a snapshot was archived, and offer the restore only for the reassignment
  case."** The built version never asks why. It asks whether there is anything to restore and
  whether the live sheet is this user's and still a draft — which are the conditions that
  actually decide whether the write is safe, are already knowable, and stay true whatever new
  archiving reason gets added later. A reason field would have been a second source of truth
  about the same question.

The paper design also did not mention attachments at all, which turned out to be the harder half
and the only part with no manual workaround.

#### Tests

`restoreArchivedWork.test.ts` (51) covers the plan, the readings, the attachment invariant, the
archive lifecycle and every refusal. `restoreRoundTrip.test.ts` (17) drives the whole reported
sequence through `applyLogSheetBundle` — so the archive it restores from is one the shipping sync
path produced — and includes the two-pass case. `liveReassignRoundTrip.test.ts` (10) repeats the
round trip and the restore over bundles captured from a running server.

### Capturing media: one recording, one row, one reference

Two rules hold this together, and both were learned from the same field report — *record a clip,
delete it, and the field is full forever*.

**One recording is saved once.** Every ending resolves the recorder's `finished` promise and the
component deliberately routes all of them — operator, duration cap, byte cap — through one stop
handler. A *manual* stop resolves `finished` from inside that handler, so the effect watching it
re-entered in the same tick, past a guard reading the stale recorder from its closure, and the
already-finished recorder returned the same blob again. `createCaptureGuard()` admits exactly one
save per recording; it is a closure in a ref because React state cannot see a second call in the
same tick.

**The reference is what the device holds.** `fieldReferenceFor(deviceRows, currentIds)` rebuilds a
field's id list from `getAttachmentsForEntry` rather than adding to or subtracting from the `ids`
the render closed over. Two writes in one tick otherwise read the same stale list and one row ends
up named by nothing — and such a row is *invisible and countable at the same time*, because the
item list is built from the reference while the ceiling is counted from the device. That is what
turned a duplicated clip into a dead end: full field, empty screen, no button to press.

It also **adopts** an unreferenced row instead of ignoring it. That is deliberate and is the only
way a tablet already carrying an orphan can be freed: opening the field repairs the reference, the
row appears, and the operator can delete it. Narrow by construction — only rows for exactly this
(sheet, asset, field), which are that field's own captures. Nothing is invented, nothing deleted.

Both rules are exercised by `attachmentCapture.test.ts` and were verified in a browser against a
real draft sheet, for audio and for video.

### Bundle merge

`mergeLogSheetBundle` merges a server bundle into local state **without clobbering unsynced
local edits**. A sheet the operator has been filling must not be overwritten by the server's
older copy of it. This is the most delicate code in the sync layer and has the most tests.

The merge is **per entry**, keyed on `assetId`, and per entry it is all-or-nothing — there is no
field-level merging, so two people editing different fields of the same asset is last-writer-wins
by design.

Per entry, one question decides everything: **did somebody edit this asset on this device?** —
which is not the same as "does this device hold a value for it".

```ts
const localWins = preserveLocal && localEditsPending && existing?.locallyEditedAt != null
```

`locallyEditedAt` is stamped by `applyOperatorEntrySave` on every operator save, including one
that **empties** the entry — emptying it is an opinion too. Nothing that receives from the server
ever sets it. That is the entire property the rule rests on, and it is why the expression is a
single condition rather than a disjunction.

`localEditsPending` is false once the row is `submitted` + `synced`: everything it holds then came
from the server, so a marker still standing describes an opinion that no longer exists. Markers
are also cleared outright when the server accepts the work. Both, not one — the reopen-and-continue
path turns a delivered row back into a draft, which re-arms the gate for anything left behind.

#### Why nothing about `formData` can answer this

Three predicates have stood here, and the two that read the data both lost real readings.

**Key presence** — `Object.keys(localForm).length > 0`. The server's web fill form posts every
field of every entry on every save, so one supervisor save wrote `{"Bar": "", "Status": ""}` onto
assets nobody had opened. The device then counted every asset in that sheet as its own work and
never accepted a server value for it again; an operator handed a reopened sheet could not see what
a supervisor had just entered, and their next submit sent the blanks back. Log sheet 85.

**Value presence** — `hasEntryFormData(localForm)`. It fixed the blanks and failed twice more. It
reads a *deliberate clear* as no opinion, so the next periodic sync restored the value the
operator had just removed. And — the failure that removed it from this expression entirely — **it
cannot tell a value this device entered from a value this device was sent.** After any sync the
local copy holds the server's own readings, so value presence is true for every filled entry on
the device from then on, whoever filled it. A supervisor correcting a reading in the browser
reached a device that had already decided it owned the entry: the correction never appeared, and
the device's next submit wrote the stale value back over it.

Both predicates are sound; both are the wrong question. The data looks identical whichever way it
arrived, so the answer has to be recorded when it is formed rather than inferred afterwards.

`hasEntryFormData` is still used — by the submit path, the progress UI and the `version(2)`
migration — and still asks about **values**, not keys. The predicate is `isValueFilled` in
[`entryTimestamps.ts`](../src/utils/entryTimestamps.ts), and it must keep meaning exactly what the
server's `FormDataValidationSupport.isAnswered` means:

| Value | Answer? |
|---|---|
| `undefined`, `null`, `''`, `'   '` | no |
| `[]` | no |
| `{ type: 'attachment', ids: [] }` | **no** — a non-empty object meaning *nothing attached* |
| `0`, `false`, `'0'` | **yes** — a reading of zero is a reading |
| any other object (a location coordinate) | yes |

#### Entries written before the marker existed

They hold real work and carry no proof of it, so under the rule above the server would win them.
The `version(2)` migration in [`db.ts`](../src/services/storage/db.ts) stamps them once, at
upgrade — every entry that holds data, in a sheet that is not already `submitted` + `synced` — so
they keep the old behaviour for exactly as long as they exist, which is until each sheet is
submitted and its markers are cleared.

Deliberately a bounded migration and **not** a permanent `|| hasEntryFormData(...)` in the merge:
an OR arm that only matters for old rows still runs on every merge, on every device, forever, and
carries the correction-losing failure with it — to protect rows that stop existing after the first
submit.

See AGENTS.md § Log sheet merge, and the server's `docs/log-sheets.md` § Who wins when two people
have touched the same sheet for the other halves of the fix. Regression coverage:
[`serverCorrectionWins.test.ts`](../src/services/sync/serverCorrectionWins.test.ts) drives the
whole sequence — sync, edit elsewhere, sync, submit — end to end.

#### Checking the merge against a real server

Every other test here builds its bundle by hand, which is the right way to cover behaviour and
shares one blind spot with the code under test: if the DTO the server actually sends has drifted
from the shape the fixtures assume, all of them stay green and none is about production any more.

[`liveBundleMerge.test.ts`](../src/services/sync/liveBundleMerge.test.ts) closes that. It runs the
shipping path — `applyLogSheetBundle`, a real Dexie database — over two bundles captured from a
running backend, and **skips itself** unless pointed at them, so it can never be mistaken for
coverage it did not provide.

To use it: fetch `GET /api/log-sheets/{id}/bundle` for an **open** sheet (`IN_PROGRESS`, assigned
to the user you authenticate as) into one file, change one entry from the web panel, fetch it
again into a second, then:

```bash
LIVE_BUNDLE_BEFORE=before.json LIVE_BUNDLE_AFTER=after.json LIVE_BUNDLE_ASSET=48   npx vitest run src/services/sync/liveBundleMerge.test.ts
```

The sheet has to be open. On a completed one — `SUBMITTED` **or** `APPROVED` — the device
correctly gives up its local copy, so the "operator's edit survives" case does not apply and will
fail. That is the merge being right, not the test.

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
| Device has a draft it has already **reported** | Server wins for anything it has not edited since. The report clears `locallyEditedAt`, so a supervisor's correction in the browser reaches the tablet instead of being overwritten at submit |
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

**An approved round cannot be reopened at all** until the supervisor withdraws the approval:
`reopen`, `void` and `extend` all refuse `APPROVED` on the server. The device does not need to
know that rule — it only needs `canContinueReopenedLogSheet` to refuse the status, which it does
through `isCompletedServerStatus`, so «ادامه‌ی کار» is never offered on a round the server would
turn down.

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
