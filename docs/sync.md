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

- **One file at a time.** Concurrent large uploads on plant Wi-Fi finish nothing.
- **Only for sheets that exist on the server** — gated on `logSheetServerId`.
- **`syncStatus` is the queue**, and it is indexed.
- **Failure is retried, not dropped.** The blob stays until the server confirms it.
- **Deleted after confirmation**, and only then — the device's copy is the only copy until the
  server has it.

---

## Conflict rules

| Situation | Resolution |
|---|---|
| Server changed master data | Server wins — it is reference data |
| Device has an unsynced draft | Device wins — the server has no competing version |
| Device submits an expired sheet | Server records it as a void submission; nothing is lost |
| Same sheet submitted twice | `clientActionId` makes the second a `DUPLICATE` |
| Two operators on one pool sheet | The server's claim guard settles it; the loser gets a refusal outcome and keeps their data |

---

## Debugging

| Symptom | Look at |
|---|---|
| Pending count never drops | Is `ensureSessionUserId()` returning null? Sync returns early. |
| Attachments stuck | Does the sheet have a `serverId` yet? The queue skips unbound files by design. |
| Sync never fires | `settings.syncIntervalMs` — if it was corrupted to an enormous value, `clampSyncInterval` now catches it. |
| Duplicate history on the server | A missing or regenerated `clientActionId`. |
| A draft was overwritten | `mergeLogSheetBundle` — start from its tests. |

## Related

- **[storage.md](storage.md)** — what is stored locally
- **[device-features.md](device-features.md)** — NFC, camera, GPS, orientation
- **[../AGENTS.md](../AGENTS.md)** — the traps
- **Backend repo → `docs/log-sheets.md`** — the endpoints on the other end
