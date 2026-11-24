# Local Storage — IndexedDB (Dexie)

Everything the device keeps, why each store exists, and the rules for changing the schema.

**Code:** [`src/services/storage/db.ts`](../src/services/storage/db.ts)

---

## Why IndexedDB rather than localStorage

An operator walks a round with no network and records readings, photos, voice notes and video.
`localStorage` is synchronous, string-only and capped at a few megabytes — it cannot hold a
Blob, and writing to it blocks the UI thread mid-round. IndexedDB stores Blobs natively, is
asynchronous, and is limited by disk rather than by a fixed quota.

Dexie sits on top because raw IndexedDB's cursor API is unusable at this scale.

---

## The stores

Current version: **5**.

| Version | What |
|---|---|
| 1 | Operational baseline — **closed** |
| 2 | `locallyEditedAt` backfill on entries (no store change) |
| 3 | `createdByUserId` backfill on attachments (no store change) |
| 4 | `lookupLists` + `lookupItems` |
| 5 | `formDefinitions` + `formSubmissions`; attachment indexes `formSubmissionLocalId`, `formSubmissionId` |

### Server-owned reference data

Refetched by `pullBootstrap` (and form catalog pull); safe to lose because the next sync rebuilds it.

| Store | Key + indexes | Holds |
|---|---|---|
| `assetClasses` | `id, createdAt` | Equipment classes |
| `assetEntries` | `id, nfcTagId, nfcSerial, classId, subFunctionId` | Assets |
| `locations` | `id, code, parentId` | Location tree |
| `plantSystems` | `id, code, locationId` | Systems |
| `mainFunctions` | `id, code, systemId, locationId` | Main functions |
| `subFunctions` | `id, code, tag, mainFunctionId, systemId, locationId` | Sub-functions |
| `logSheetTemplates` | `id, scopeType, scopeId` | Templates |
| `fieldDefinitions` | `id, classId, order` | Form schemas (per-class fallback) |
| `operationalUnits` | `id, code, parentId` | Org chart |
| `formDefinitions` | `id, code` | Fillable ad-hoc form catalog (carrier 3) — live fields for a *new* draft. **`title` is not indexed** — `getAllFormDefinitions` sorts in memory; `orderBy('title')` throws and empties `/forms` while `get(id)` deep-links still work |

**`assetEntries` indexes both `nfcTagId` and `nfcSerial`** because a scan resolves on either
one, and it has to resolve instantly while the operator holds a phone against a pipe.

**`subFunctions.tag` is indexed** for the same reason — the tag is what the chip actually
contains.

### Local work

This is the data that matters. Losing it loses field readings.

| Store | Key + indexes | Holds |
|---|---|---|
| `logSheets` | `id, localId, serverId, templateId, status, createdAt` | Sheets and their drafts. Backend V25 added four plain, non-indexed fields (no Dexie version bump): `serverKeptAt` (a refused submission the server kept), and `lateProgressSentMarker` / `lateProgressKeptMarker` / `lateProgressKeptAt` (an expired draft's edits sent once, and kept) — see [sync.md](sync.md) «Deadlines, offline». Backend V26 added `serverKeepRefusedAt` (a refusal answered `kept: false`), also plain. The sync tick reads the queue and the progress lane through the **`status`** index (`getLogSheetsByStatus`, issue P-08) |
| `formSubmissions` | `id, localId, serverId, formDefinitionId, status, syncStatus, createdByUserId, createdAt` | Ad-hoc form drafts / finals (carrier 3). Separate from log sheets — never counted in round compliance. `draftSyncStatus` / `locallyEditedAt` are plain properties for the draft-upsert lane (like progress); `syncStatus` is the final-submit lane. `createdByUserId` scopes outbound sync on a shared tablet. List and deep-link visibility also require `reporterUnitId` or `subjectUnitId` in bootstrap `accessibleUnitIds` (plant-wide skips the unit filter; an empty accessible set keeps the operator's own rows). The stored `formTitle` may be bilingual; the screen shows the Persian segment only (`persianFormTitle`). Synced rows follow the same `deviceRetention` windows as rounds via `cleanupFormSubmissions.ts`. Open drafts and pending finals are never purged. Failed finals follow the same unsynced / legacy windows as refused rounds (default switch-off keeps them forever; forms have no `kept` receipt). Sign-out does not delete these rows or their signature blobs |
| `attachments` | `id, logSheetLocalId, logSheetServerId, formSubmissionLocalId, formSubmissionId, assetId, fieldKey, syncStatus, createdAt` | Media blobs. Owner is XOR: log-sheet keys **or** form-submission keys. `createdByUserId` is a **plain, unindexed** property — see below; so is `idRemintedFrom` (issue P-06) |
| `nfcFaultReports` | `id, logSheetServerId, assetId, syncStatus, createdAt` | Reported broken chips |
| `logSheetUserArchives` | `id, serverId, userId` | Completed sheets, per user |

**Three progress fields on `logSheets` are plain properties, not indexes.**
`progressSyncStatus`, `progressSyncedAt` and `progressError` track a queue of their own — a live
report about a round still being walked, separate from `syncStatus`, which tracks the delivery of
finished work. They deliberately did **not** get a Dexie version bump: the progress queue scans
`getAllLogSheets()` and filters in memory, exactly as the submit queue already does, so nothing
selects on them. Keeping them out of `syncStatus` is what stops a refused progress report from
ever marking real, undelivered readings as failed.

**`logSheets` is keyed on both `localId` and `serverId`.** A sheet exists on the device before
the server has ever heard of it — `localId` is minted locally and is the stable identity
throughout; `serverId` arrives only after a successful sync. Code that assumes `serverId` is
present will break on exactly the offline path this app exists for.

**`attachments.syncStatus` is indexed** because the upload queue selects on it every tick.
`blob` is deliberately **not** indexed — IndexedDB cannot index a Blob, and nothing queries by
content.

### Device state

| Store | Key | Holds |
|---|---|---|
| `settings` | `key` | `AppSettings` — server URL, sync interval, NFC mode, screen orientation, and the server-owned values bootstrap mirrors here (`attachmentLimits`, the scan and annotation policies, and since backend V24 the optional `deviceRetention` — absent until a server sends it, which is what keeps the purge on the shipped constants; no Dexie version change, it is a field of the one settings row) |
| `syncMeta` | `key` | Last-sync timestamps per resource; `lastBacklogReport` (backend V25) — the last «ارسال‌نشده» count sent to the server and the session it went to, so an unchanged number is not resent every pass; `serverClock` (roadmap §7) — the measured `server − device` offset, its round trip, when it was measured and the server time last seen; `sessionLastContactAt` (backend V28) — server time of the last authenticated answer, which the offline-session ceiling counts from, cleared at sign-out; `deviceStatusCheckedAt` (backend V28) — device time of the signed-in device-status check, which spaces them 30 minutes apart |

`settings` also holds, since backend V28, the optional `offlineSessionLimit` (`{enabled, hours}`),
absent until a server sends it — which means never lock. No Dexie version change for either.

**Outside IndexedDB, three small things (backend V28):** `localStorage['mfdcs.deviceWipe']` — a wipe
order being carried out (`wiping`) or awaiting its signed confirmation (`confirming`), kept outside
`offline-pwa-db` because it must survive that database being deleted; `sessionStorage['mfdcs.deviceWiped']`
— «this start followed a wipe», read once by the login page; and in the separate
`mfdcs-device-identity` database a second row, `wipe-ack`, holding the key set aside to sign the wipe
confirmation (one store, one schema version, as before — a second row is not a schema change). The
app stores nothing else in either storage area.

`settings` never syncs. Some of it is device-specific by nature (screen orientation depends on
how *that* tablet is mounted), and a shared account must not drag one device's choice onto
another.

The row's `serverUrl` is **not always what the device uses.** `getSettings()` decides the address
on every read (`services/settings/deliveryServerUrl.ts`): in a browser's production bundle it is
the page's own origin whatever the row says — and the next settings save writes that origin back
— while the APK and `npm run dev` use the row, seeded from `VITE_SERVER_URL`. Read the address
through `getSettings()`, never from `db.settings` directly. No schema change: it is a rule about
reading the existing field.

---

## Attachments: why the id is minted on the device

```ts
attachments: 'id, logSheetLocalId, logSheetServerId, assetId, fieldKey, syncStatus, createdAt'
```

The attachment `id` is a **UUID generated on the tablet**, and the backend's `attachments.id`
is a `VARCHAR(36)` to match. This is the whole design: the device names the file, stores the
blob under that name, and uploads later. A server-generated id would mean a device could not
name its own capture until it had a network — precisely the situation this app is built for.

**Both `logSheetLocalId` and `logSheetServerId` are stored.** An attachment is captured against
a sheet that has no server id yet; the upload queue skips it by design until
`bindAttachmentsToServerSheet` stamps the server id after the sheet syncs. Until then there is
nowhere to send it.

**The id is the primary key, so changing it is a move, not an update.** When the server answers
that the id already names somebody else's file (`409 ATTACHMENT_ID_TAKEN`, issue P-06),
`remintTakenAttachment` adds the row under a fresh UUID, deletes the old one and rewrites the
round's reference to it — all in one `rw` transaction over `attachments` and `logSheets`, so no
reference can be left naming an id no row holds. `idRemintedFrom` keeps the old id and limits it to
once per file.

---

## Changing the schema

**`version(1)` is the operational baseline and is closed.** It holds every store, it is on
tablets in the field, and editing it strands them: IndexedDB refuses to open a database at a
version below the one that created it, `openDatabase()` then refuses to start rather than delete,
and the unsynced readings on those devices are unreachable until a build ships that can open the
database again.

**Add a new `version(n)` block. Never edit an existing one.**

```ts
this.version(2).stores({
  // every existing store, repeated verbatim — Dexie requires the full list
  assetClasses: 'id, createdAt',
  // …
  newStore: 'id, someIndex'
})
```

Rewriting an applied version makes a device's on-disk database un-openable, because IndexedDB
refuses to open a database at a lower version than it was created with.

If a change **reshapes** existing data rather than only adding stores, an `.upgrade()` callback
is required; a purely additive version needs none.

`dbSchema.test.ts` pins the current store list, the indexes the sync loops select on, each
store's primary key, **and the version number** — the last as a hard-coded value rather than a
range, so that adding a version block is a deliberate edit in the file whose subject is the schema
rather than something that ships as a side effect.

### `version(2)` — no schema change, one data migration

The only version above the baseline so far. It declares the identical store list and exists for
its `.upgrade()`: stamping `locallyEditedAt` on entries that hold work but predate that marker.

The sync merge decides per entry whether the device or the server owns the values, and it now
reads only that marker — because no question about `formData` can separate a reading the operator
typed from one the server sent (after any sync the device is holding the server's own values; see
[sync.md](sync.md#bundle-merge)). Entries written by earlier builds hold real unsent work and
carry no proof of it, so without this they would lose to the server on the next sync.

Its scope is deliberately narrow, and `preMarkerEntryMigration.test.ts` pins each part: only
entries that **hold data** (by `hasEntryFormData`, so blanks and emptied attachment fields are
skipped), only in sheets that are **not** already `submitted` + `synced`, and never over a marker
that is already there. A wrong marker is not a harmless over-approximation — it hands the device
that entry on every future merge, which is how a supervisor's later edits go invisible.

### `version(3)` — no schema change, one data migration

Also identical stores. It exists to stamp **`attachments.createdByUserId`** on media captured
before that field existed.

**Why captured media needs an owner of its own.** There is one local row per server sheet and it
is *reused* when a supervisor reassigns the round: `reset-draft` empties the readings but leaves
`localId` alone and never touches `db.attachments`. Ownership used to be inferred from the sheet
(`isAttachmentUploadableByUser` read `localOwnerUserId`), and that inference is exactly what
reassignment breaks — the sheet's owner becomes the new operator while the media on it is still
the previous one's. Every read keyed on `logSheetLocalId`, so on a shared tablet the previous
operator's photographs were counted against the new operator's field ceiling and **adopted into
their reading** the moment the field was opened. See [sync.md](sync.md#whose-files-these-are).

`logSheets` has `localOwnerUserId` and `nfcFaultReports` has `createdByUserId`; attachments were
the third outbound-syncable store and the one that never got it — which is what AGENTS.md means
by "this invariant has to be applied to every new outbound-syncable local table **separately**".

**Why it needs a version rather than a read-time default.** An unstamped row falls back to "it
belongs to whoever is signed in", the same rule `isNfcFaultReportOutboundOwnedByUser` uses and
the right default, because refusing would strand evidence of work that cannot be repeated. But
that fallback is precisely wrong for a colleague's media already on the tablet when the app
updates — so those rows are stamped once, from the sheet they hang off, while that answer is
still true. Reassignment is what makes it false, and it has not happened yet for anything still
sitting there.

`attachmentOwnerMigration.test.ts` pins the scope: the owner comes from the row's own sheet, an
owner already present is **never** overwritten (the sheet's may since have moved), a row whose
sheet is gone is left unstamped for the read-time fallback, and the whole thing is idempotent so
an interrupted upgrade can simply run again.

It is idempotent and writes per sheet, so an upgrade interrupted halfway leaves every row readable
and can simply run again.

### `version(4)` — two new stores, nothing else changed

`lookupLists` (keyed by the list's code lower-cased: revision, lease, cursor, the offline columns)
and `lookupItems` (keyed by the server's item id, indexed by `listId`) — the device's copy of the
reference lists its open rounds need (backend roadmap §31 Phase 2). No existing store, index or row
is touched, so the upgrade cannot lose anything already on a tablet.

These two are the **one exception to «reference data survives logout»**: a list may be personal
data, so it is cleared at sign-out (`clearUserSessionContext` → `clearAllLookups`), deleted when its lease ends — online
or not, at startup and whenever a field reads it — and dropped when no assigned round and no
FILL-able form needs it. Form personnel lists live in these same stores, not a second table;
sign-out also deletes the `requiredFormLookups` lease key, or the next sign-in would treat a
previous operator's lease as already downloaded. Nothing an operator recorded goes
with it: every lookup answer stores its own `{code, label}`, and form drafts, queued finals and
signature bytes are other stores. See `services/lookups/` and [sync.md](sync.md) — «Reference lists».

### The recovery path in `openDatabase()`

```ts
try {
  await db.open()
} catch (err) {
  // VersionError only: the on-disk version is newer than this build
}
```

Only a `VersionError` triggers a recreate — reachable on a dev device that ran the app before
the version numbers were collapsed to 1. **Any other failure is rethrown untouched.** Silently
wiping a user's database on an unrelated error would be far worse than failing loudly.

---

## What survives what

| Event | Reference data | Reference **lists** (lookup) | Drafts | Attachments | Settings |
|---|---|---|---|---|---|
| App closed and reopened | ✅ | ✅ while the lease runs | ✅ | ✅ | ✅ |
| Logout | ✅ | ❌ — `clearAllLookups` (form lists and round lists) and the `requiredFormLookups` key | ✅ rounds, form drafts, queued finals | ✅ including signature blobs | ✅ |
| Lease ends (from the last sync) / clock set back | ✅ | ❌ | ✅ | ✅ | ✅ |
| No assigned round **and** no FILL-able form needs the list any more | ✅ | ❌ at the next `syncRequiredLookups` | ✅ | ✅ | ✅ |
| Browser cache cleared | ❌ | ❌ | ❌ | ❌ | ❌ |
| "Clear site data" | ❌ | ❌ | ❌ | ❌ | ❌ |
| PWA uninstalled | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Offline-session lock** (backend V28) | ✅ | ❌ — as logout | ✅ | ✅ | ✅ |
| **Wipe ordered by the server** (backend V28) | ❌ | ❌ | ❌ — **unsent rounds too** | ❌ | ✅ server address only |

**Logout does not clear local work**, and that is deliberate on a shared tablet: an operator
signing out at the end of a shift must not destroy a round — or a form draft, a queued final, or
a signature blob — the next operator has not synced yet. Lookup lists are the exception, because
they can be personal data, and they go for both sources together.
`logSheetUserArchives` is keyed by `userId` so each person sees only their own completed sheets.
Form history on the device is the signed-in author's rows, further limited to an accessible unit.

## Related

- **[sync.md](sync.md)** — how this data moves to and from the server
- **[../AGENTS.md](../AGENTS.md)** — the traps
- **Backend repo → `docs/schema.md`** — the server side of the same data


## Form mutation atomicity (2026-11-24)

`formSubmissions.ts` wraps patch updates, draft saves, local finalization, draft/final
acknowledgements and sync-status changes in Dexie read-write transactions. Read and write
must share that transaction: merging an old object with `put` can overwrite a concurrent
save even when the acknowledgement compares edit stamps. Draft save stamps use the maximum
of wall clock, previous edit + 1 and previous acknowledgement + 1. No store/schema upgrade
is needed. Each remote history merge now reads/checks/writes in a per-submission read-write transaction too (F-01).


### Form schema and history metadata (2026-11-24)

CachedFormDefinition and LocalFormSubmission carry optional schemaVersionId. It is copied at
creation and preserved through saves/finalization/correction. LocalFormSubmission.serverUpdatedAt
records a received server revision timestamp to ignore older history responses; it is not a
cross-device optimistic lock. Both additions are ordinary Dexie payload properties, unindexed,
so no store migration is needed. Legacy rows with no version are not silently upgraded.
