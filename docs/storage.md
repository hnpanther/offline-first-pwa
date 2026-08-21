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

Current version: **2**.

### Server-owned reference data

Refetched by `pullBootstrap`; safe to lose because the next sync rebuilds it.

| Store | Key + indexes | Holds |
|---|---|---|
| `assetClasses` | `id, createdAt` | Equipment classes |
| `assetEntries` | `id, nfcTagId, nfcSerial, classId, subFunctionId` | Assets |
| `locations` | `id, code, parentId` | Location tree |
| `plantSystems` | `id, code, locationId` | Systems |
| `mainFunctions` | `id, code, systemId, locationId` | Main functions |
| `subFunctions` | `id, code, tag, mainFunctionId, systemId, locationId` | Sub-functions |
| `logSheetTemplates` | `id, scopeType, scopeId` | Templates |
| `fieldDefinitions` | `id, classId, order` | Form schemas |
| `operationalUnits` | `id, code, parentId` | Org chart |

**`assetEntries` indexes both `nfcTagId` and `nfcSerial`** because a scan resolves on either
one, and it has to resolve instantly while the operator holds a phone against a pipe.

**`subFunctions.tag` is indexed** for the same reason — the tag is what the chip actually
contains.

### Local work

This is the data that matters. Losing it loses field readings.

| Store | Key + indexes | Holds |
|---|---|---|
| `logSheets` | `id, localId, serverId, templateId, status, createdAt` | Sheets and their drafts |
| `attachments` | `id, logSheetLocalId, logSheetServerId, assetId, fieldKey, syncStatus, createdAt` | Media blobs |
| `nfcFaultReports` | `id, logSheetServerId, assetId, syncStatus, createdAt` | Reported broken chips |
| `logSheetUserArchives` | `id, serverId, userId` | Completed sheets, per user |

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
| `settings` | `key` | `AppSettings` — server URL, sync interval, NFC mode, screen orientation |
| `syncMeta` | `key` | Last-sync timestamps per resource |

`settings` never syncs. Some of it is device-specific by nature (screen orientation depends on
how *that* tablet is mounted), and a shared account must not drag one device's choice onto
another.

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

It is idempotent and writes per sheet, so an upgrade interrupted halfway leaves every row readable
and can simply run again.

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

| Event | Reference data | Drafts | Attachments | Settings |
|---|---|---|---|---|
| App closed and reopened | ✅ | ✅ | ✅ | ✅ |
| Logout | ✅ | ✅ | ✅ | ✅ |
| Browser cache cleared | ❌ | ❌ | ❌ | ❌ |
| "Clear site data" | ❌ | ❌ | ❌ | ❌ |
| PWA uninstalled | ❌ | ❌ | ❌ | ❌ |

**Logout does not clear local work**, and that is deliberate on a shared tablet: an operator
signing out at the end of a shift must not destroy a round the next operator has not synced yet.
`logSheetUserArchives` is keyed by `userId` so each person sees only their own completed sheets.

## Related

- **[sync.md](sync.md)** — how this data moves to and from the server
- **[../AGENTS.md](../AGENTS.md)** — the traps
- **Backend repo → `docs/schema.md`** — the server side of the same data
