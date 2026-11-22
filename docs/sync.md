# Synchronisation

How data moves between the tablet and the server, in what order, and what happens when each
step fails.

**Code:** [`src/services/sync/`](../src/services/sync/) — `index.ts` (the manager),
`pullBootstrap.ts`, `pullInbox.ts`, `logSheetSync.ts`, `attachmentSync.ts`,
`formDraftSync.ts`, `formSubmitSync.ts`, `formCatalogSync.ts`,
`mergeLogSheetBundle.ts`, `cleanupLogSheets.ts`

---

## The shape of it

```
        PULL (server → device)                PUSH (device → server)

  GET /api/bootstrap    ── master data      POST /api/log-sheets/progress ── what a round
                     (+ requiredFormLookups)                                  has recorded
  GET /api/log-sheets/inbox ── my sheets                                     so far
  GET /api/log-sheets/{id}/bundle ── one    POST /api/log-sheets/batch    ── completions
        sheet, everything needed offline    POST /api/attachments         ── one file
  GET /api/forms        ── fillable forms                                      at a time
                                            POST /api/nfc-fault-reports/batch
                                            POST /api/forms/drafts        ── form drafts
                                            POST /api/forms/submit        ── form finals
```

Two rules hold the whole design together:

1. **The device is the source of truth for work it performed.** A reading taken in the field
   exists whether or not the server has heard of it. Sync is delivery, not authorisation.
2. **Every push is idempotent.** Each item carries a `clientActionId` the device mints. A
   request that times out and is retried is applied once. Without this, a flaky link produces
   duplicate history, which is unrecoverable.

---

## Per-asset warning and danger bands

A band belongs to a machine as often as to a class — one pump's ampere range is not another's.
The bundle carries that as `sheet.fieldOverridesSnapshot`, beside the field definitions and
frozen at the same moment:

```json
{ "4711": { "source": "RANGES_ONLY", "fields": { "Ampere": { "warning": { "min": 18, "max": 42 } } } } }
```

Keyed by **asset id as a string**, then by field key. It is a **delta**: only the fields that
actually differ from the class appear, and an asset that overrides nothing is absent entirely,
as is the whole key on a sheet where nobody overrides anything. Carrying whole definitions per
asset would put ~135 KB on a 47-entry sheet instead of ~11 KB, on every fetch.

`source` is the asset's mode when the sheet was raised. `RANGES_ONLY` may only replace
`warning` and `danger`; `FULL` may additionally add a field, drop one with `"removed": true`,
or relabel it. It is stored rather than inferred because the two are not distinguishable from
the keys alone.

**This is for display.** The server recomputes `max_severity` and `breached_fields` from its own
copy of the same snapshot on every write — the mobile batch merge and the web fill both — and
it never reads severity, or even `classId`, from what the client posts. So a build of this app
that ignores the key stores exactly the same data; it simply colours a field by its class's
range instead of its own. Apply it through `sheetFieldDefinitions(sheet, classId, fallback,
assetId)` and nowhere else.

**Sub-classes change nothing here.** An asset class may have a parent; the asset points at the
leaf through its ordinary `classId`, and the server flattens the inheritance before freezing
the snapshot, so `fd.classId === entry.classId` keeps matching.

### Storing it is a separate step from applying it

`applyLogSheetBundle` does **not** spread the server's sheet onto the stored record — it copies
a named list of fields, across four branches (new sheet, plain refresh, `reset-draft`,
`mark-synced`). `fieldOverridesSnapshot` has to be in all four, and for a long time it was in
none: the column was correct in the database, correct on the wire, and absent on the tablet,
so every asset resolved to its class's bands no matter what the panel said.

It is patched only when the payload actually carries entries, on the same rule as
`fieldDefinitions`: an absent or empty key means *this payload says nothing*, and a sheet's
snapshot is written once at generation and never cleared, so keeping what the device already
holds is never the stale answer.

### A choice field's threshold is its options, not a range

A `select` or `multiselect` definition may carry `warningOptions` and `dangerOptions` beside
`options` — the choices that *are* the alert:

```json
{ "options": ["OF", "ON", "Idle"], "warningOptions": ["Idle"], "dangerOptions": ["OF"] }
```

The polarity is the opposite of `warning`/`danger`: a number must stay *inside* its band, an
option raises the alert by being chosen. Resolve severity through
`evaluateFieldSeverity(dataType, value, validation)` and nowhere else — it dispatches on the
type, and the numeric-only function it replaced answers `ok` for every select.

Three things must match the backend exactly. The server recomputes `max_severity` from its own
copy on every write, so a looser rule here does not corrupt data — it tells an operator a
reading is fine that comes back as a danger, which costs a second trip to the equipment:

| Rule | Why |
|---|---|
| A `multiselect` takes the **worst** chosen option | one dangerous tick among five safe ones is a danger |
| Matching is trimmed but **case-sensitive** | the server's submit-time allow-list is, so a looser match would accept a reading the server then rejects |
| No severities means never an alert | adding a vocabulary must not raise one on its own |

Both keys also arrive in a **per-asset** override, under `RANGES_ONLY` as well as `FULL`: which
choices mean trouble on one machine is a threshold, not structure, so the class keeps owning the
vocabulary. An explicit `null` or empty array means "this machine marks nothing", which is a
decision and not the same as inheriting.

The fill form colours a `select` by outlining the control and a `multiselect` by colouring
**each checkbox according to its own option**, which is the more useful answer when several
choices are visible at once.

### A threshold may apply only in one state of the asset

A `number`, `select` or `multiselect` definition may carry a `conditions` list: thresholds judged
only while **another answer on the same entry** says so.

```json
{
  "danger": { "min": 4.5, "max": 34.8 },
  "conditions": [ { "when": { "field": "status", "op": "in", "values": ["روشن"] } } ]
}
```

«جریان کمتر از ۴٫۵ خطر است» is true of a running pump and meaningless for a stopped one, and no
band can say it: a minimum of zero never fires (the interval is closed, `0 < 0` is false) and a
real threshold alerts on every standby machine. ISA-18.2 calls the result *suppressed by design*.

The evaluation order, which `utils/fieldValidation.ts` mirrors from the server's
`FieldValidationSupport` **exactly**:

| Stored shape | Verdict |
|---|---|
| no `conditions` key, or one that is not a list of objects | judged exactly as before this key existed |
| the first condition whose `when` holds | judged by **that** condition's thresholds; one declaring none of the four threshold keys gates the field's own bands, which is what the panel writes |
| no condition holds | `ok`, suppressed — the value is still **stored and synced**, so nothing has to be left blank |

`when` is a closed operator set: `in` / `notIn` take `values`, `gt` / `gte` / `lt` / `lte` take
`value`, `answered` / `notAnswered` take neither. An operator this build does not know, a
malformed gate, or a sibling with no answer each mean «does not hold» — which falls through to
the next condition and, failing that, suppresses the field. **Never an alert.**

Two rules that must match the backend, for the same reason as the option severities above:

| Rule | Why |
|---|---|
| The gate's **field key** is matched case-insensitively | the server's key uniqueness is already case-folded, and a case-sensitive lookup would make a correct gate never match — a danger band that judges nothing |
| The gate's compared **values** are trimmed and case-**sensitive** | the submit-time allow-list is, so a looser match would gate on a spelling the server refuses to store |

`conditions` also arrives in a **per-asset** override, under `RANGES_ONLY` as well as `FULL`, and
is **replaced whole** rather than merged — it is an ordered first-match statement. An explicit
`null` means «this machine has no condition», which drops the class's gate instead of inheriting
it.

Unlike the bands, this one is **not** display-only in effect: a build that ignored it would paint
a stopped pump red while the server records `ok`, on the same reading. The device half therefore
ships with the panel half.

It costs no extra subscription. `DynamicFormField` already watched its own value to colour it, and
the gate's parameters ride in that same watch — `name: [field.name, ...gateSources]`, with the
field's own value first. Only the one or two parameters a gate names are watched, never the whole
entry, and `forms/gateSources.ts` resolves which those are (case-insensitively, since the server's
keys are case-folded). The hint line under the field states the condition («فقط وقتی …»), because
a band shown without it reads as the whole rule.

### What `FULL` changes beyond colour

`RANGES_ONLY` really is display only. `FULL` is not: it adds and removes fields, so it changes
**which inputs the form has** and therefore the N-of-M completion badge. Both the fill dialog
and the badge resolve through `sheetFieldDefinitions(sheet, classId, fallback, assetId)` so
they cannot disagree — a badge reading «۲ از ۲» over a form with three inputs is a badge
telling the operator to submit an unfinished round.

The merge also honours `required`, `sortOrder` and `options` on a `FULL` override. Nothing
writes them today — the web panel's form does not post them — but the server's override
sanitiser allows them and `AssetFieldResolver` reads them, so a value arriving by any other
route must not produce one form on the web and another on the tablet.

## The round's own questions

A round can carry questions of its own — «آیا همه لوله‌ها بازدید شد؟», asked once per sheet
rather than once per asset. They are field definitions with a different owner, so
`DynamicClassForm` renders them unchanged; what is new is how they travel.

**Downward, the questions come from `context.sheetFieldDefinitions` first.** The bundle
serialises the whole sheet entity, so `sheetFieldDefinitionsSnapshot` and `sheetFormData` have
always been in the payload — but a **custom** sheet's snapshot is null until its first answer, so a
round set up with questions after it was created arrived here empty. The server now sends the list
its own fill page shows, resolved, in the bundle's context; `applyLogSheetBundle` prefers it and
falls back to the sheet's column for an older server. Declaring
them on `ServerLogSheet` is what lets `applyLogSheetBundle` copy them onto the stored row, as
`sheetFieldDefinitions` and `sheetFormData`. Both are **plain, non-indexed properties — no Dexie
version bump**, the same as `fieldDefinitions` and `fieldOverridesSnapshot` beside them.

**The schema and the answers are merged by opposite rules, and that is the point.** The frozen
questions follow the definitions: an empty or absent list means "this payload says nothing",
so a thin refresh never blanks a working form. The *answers* are values the device may hold a
newer version of, so they follow the entries:

```
sheetFormLocalWins = preserveLocal && localEditsPending && existing?.sheetFormLocallyEditedAt != null
```

`sheetFormLocallyEditedAt` is stamped by the save itself and cleared when the server accepts the
answers. **No question asked of `sheetFormData` can replace it**, for the reason
`mapServerEntryToLocal` sets out at length: after any sync the local answers *are* the server's
answers, so both key presence and value presence are permanently true and the server side of the
merge stops existing. Those two predicates were tried at entry level and each lost real readings.

**Upward it is one additive field**, `sheetFormData`, on the submit payload and on the progress
push. Omitted entirely when the device has no opinion — an absent key means "not carried", never
"cleared", which is what lets an older build keep submitting without wiping what the panel
stored.

**A round can be reported with no asset touched at all.** The operator answers the round-level
questions first, so `getLogSheetsPendingProgress` and the queue loop both read
`hasDirtySheetForm` beside `dirtyEntriesForProgress`. Counting entries alone left that answer on
the device with nothing to say it had never been delivered — and the server, reading the same
way, replied `NO_CHANGE`. Both sides were fixed together.

**The marker is forgotten only if the answer the server accepted is still the one on the
device.** An operator who answers again while the request is in flight keeps their marker and
the next pass delivers it — the same rule, and the same reason, as
`clearMarkersForAcceptedEntries`.

### Media answering a round-level question

A round-level question may be an image, a video, a voice note or a coordinate. The control is the
one an asset's media field uses; what changes is the owner.

**`LocalAttachment.assetId` is optional, and absent is an owner rather than a missing value** —
the media belongs to the round. It mirrors the server's `attachments.asset_id`, nullable since
V10: inside a log sheet there are exactly two owners media can have, `logSheetLocalId` is set
either way, so absence carries the one bit that tells them apart. It stays a plain Dexie index
and needed **no version bump**: an index does not list a row whose property is undefined, and
nothing queries `where('assetId')` — every read starts from the sheet and filters in memory.

`getAttachmentsForEntry` takes `assetId` as `string | undefined` and compares both sides through
`toIdString`, so absent matches absent and nothing else (an asset id is a database id and can
never be the empty string). The two owners therefore do not see each other's files, which is what
keeps the per-field ceiling from counting one against the other. **Per-operator ownership still
applies unchanged** — `createdByUserId`, the invariant that AGENTS.md says must be applied to
every outbound-syncable table separately.

**The upload omits the field rather than sending `"undefined"`.** `uploadAttachment` appends
`assetId` only when it is present; the server reads an absent one as "this answers the round's own
question", while the literal string would fail to parse as a Long and park the row as a permanent
failure — an operator's evidence refused for a client bug.

### Where a required question is enforced

`SheetQuestionsCard` has its own `useForm`, so `handleSubmit` refuses to call `onSave` while a
required question is unanswered. **That is the only place it is enforced.** The round's final
submission does not check it — on the device or on the server — and
`validateLogSheetBeforeSubmit` never looks at `sheetFormData` at all.

This is deliberate and it is the whole design of `required`: an operator standing at the
equipment, offline, with a day's readings queued must never be blocked by an answer they can
still supply. Enforced where somebody is answering those questions and nowhere else, it is help;
enforced on the submit it would be a round that cannot be delivered. Shape is still checked
everywhere, because a value the schema cannot describe is a client bug either way.

## When sync runs

Two different things run, on different triggers, and confusing them is how this page once claimed
something the code never did.

**The push pass** (`syncManager.sync()` — progress, submissions, attachments, fault reports):

| Trigger | Where |
|---|---|
| On an interval | `settings.syncIntervalMs` (default 30 s, clamped 10 s–1 h) |
| When the browser comes back online | `handleOnline` — the `online` event |
| On demand | The sync button |

**The inbox pull** (`pullAndMergeInbox` — `GET /api/log-sheets/inbox`, the bundle merge, and the
reference lists right after it) does **not** run on that interval. It runs only:

| Trigger | Where |
|---|---|
| Signing in, or opening the app already signed in | `useInboxSync` — its effect on `isAuthenticated` |
| The connection coming back (and the server becoming reachable again) | the same effect, on `isOnline` / `serverReachable` |
| The refresh button, and claim / release / assign on the list page | `LogSheetListPage` → `refreshInbox` |
| After the operator submits a round from the fill page | `LogSheetFillPage` → `refreshInbox` |
| After a push pass that **delivered something** (`syncedCount > 0`) | `useSync` — the `complete` event |

**Everything else that runs on its own** — none of it on the push timer:

| What | When |
|---|---|
| Bootstrap (units, ceilings, policies, `deviceRetention`, `offlineSession`, the clock) | at sign-in (forced), with the inbox pull, and when the app comes online — each time only if the last one is an hour old (`pullBootstrapIfStale`, on the server's clock) |
| The «ارسال‌نشده» report to the panel | at the end of a push pass that reached the server — only when the count changed, an hour passed, or the session is another one |
| The local round purge, the file-bytes purge | at the end of a push pass, and when the app comes online with a session («How long a round stays on this device») |
| Reference-list expiry | at start-up with a session and at sign-in, online or not |
| The wipe-order check (backend V28) | when the login page finds the server reachable; inside every sign-in; before the device key would be discarded; and its signed confirmation at every start until it lands |
| The device-status check while signed in (backend V28) | at start, on reconnection, on returning to the foreground and on a 5-minute tick — each time only if the last check is 30 minutes old; one at a time (`useDeviceStatusWatch`) |
| The offline-session check (backend V28) | at start, on every navigation, every 60 s, and when the app returns to the foreground — never interrupting the asset form |

So a tablet left open and online, delivering nothing, does **not** learn of a newly assigned round,
a cancellation or a change to a reference list until one of these happens. That is the behaviour
today, not a guarantee anybody chose: `git log` shows the push timer never pulled the inbox, and
the post-sync pull was added in `5953a36`. A periodic pull would be a decision with a server-side
cost — see the backend's `docs/roadmap.md` §3 before adding one.

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
> asset deliberately does *not* fire an immediate sync: one request per asset save would multiply
> the push traffic by the size of a round.

> **What an inbox pull costs the server.** Each pull rebuilds a **full bundle per assigned sheet**
> — roughly a dozen queries each, with no conditional GET, because the inbox is what
> pre-provisions a tablet to work offline rather than a listing. It is **not** paid on every push
> tick (above), only on the triggers listed — most often after a pass that delivered something.
> Making the pull periodic, or tying it to the push interval, would make the load
> `tablets × assigned sheets × ~12 queries ÷ interval`; the arithmetic and the three ways to cheapen
> a pull are in the backend's `docs/roadmap.md` § 3. Read it before adding a timer.

### Where a pass sends its requests

Every request of a pass — the batch, progress, fault reports, attachment uploads and downloads,
the inbox and the bootstrap — takes its base address from `getSettings().serverUrl`, read again
for each request (`getBaseUrl()` in `services/api/client.ts`). Which address that is depends on
the delivery (`services/settings/deliveryServerUrl.ts`):

- **A production bundle in a browser:** always the page's own origin, sent as relative `/api/...`.
  The stored value and `VITE_SERVER_URL` are ignored, so the same `dist/` keeps syncing when the
  site is reached under a new name or IP.
- **The APK and `npm run dev`:** the stored address, seeded from `VITE_SERVER_URL`. Changed only
  through Settings, which refuses an address that does not answer and ends the session before the
  new one is written — so a pass never carries an old token to a new host.

> **Unsynced work belongs to an origin, not to a tablet.** IndexedDB is per origin, so work queued
> under `https://abc.com` is only pushed by the app opened at `https://abc.com`. Moving a browser
> fleet to a new name therefore means letting every tablet sync on the old name first — README,
> "Moving the server to a new address". `serverAddressFollowsPage.test.ts` runs a real pass in
> both deliveries and checks every URL it puts on the wire.

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

### 3. No local expiry of queued work (backend V25, issue P-02)

This step used to be `markExpiredSheets()`: a queued completion finished after its deadline was
marked `failed`/EXPIRED here, **before it was sent**, "so the device does not queue work the
server is certain to refuse". But the server's answer to such work is to **keep** it as a void
submission (backend B-01), so not sending it removed the one chance it had. The step is gone; the
inbox merge no longer does the same thing by a second route either (it re-labels only a row the
server has already answered). A late completion goes out once, and the device records the answer
— see «Submission outcomes» and «Deadlines, offline». Drafts are still marked EXPIRED for display
by `expireStaleLocalDrafts`; that changes nothing about what is sent.

### 3b. Report how far the open rounds have got

```ts
if (hasPermission(session, PERM_LOG_SHEET_PROGRESS)) {
  await this.pushProgress()
}
```

### 3c. Ad-hoc form draft upserts (carrier 3)

```ts
if (hasPermission(session, PERM_FORMS_DRAFT)) {
  await this.pushFormDrafts()
}
```

**Separate carrier from log sheets.** `POST /api/forms/drafts` upserts open form drafts
(`formSubmissions` with `status: 'draft'`). Like progress:

- Never writes `syncStatus` / `syncError` / final `status` — those belong to the final-submit lane.
- Not counted in the pending badge (a draft being filled always has work in flight).
- Ownership is `createdByUserId` (shared tablet).
- Once the server answers `OK` with a `submissionId`, `bindAttachmentsToServerForm` stamps
  form-owned media so the attachment queue can upload.

Final submit (`POST /api/forms/submit`) runs later in the same pass with fault reports / sheet
batch — idempotent via `clientActionId` (`DUPLICATE` = accepted). Schema freeze is server-side on
first draft save; the device keeps `fieldDefinitionsSnapshot` on the local row from create time.

**Lookup lease:** bootstrap's `requiredFormLookups` is stored and **unioned** with inbox
`requiredLookups` before `syncRequiredLookups` — that helper set-diffs, so calling it with only
one source would drop the other's lists.

**An expired draft with edits is reported too, once (backend V25, issue P-01).** It used to be
excluded — «a progress report is about a round still being walked» — and an operator who walked
most of a round offline and reconnected after the deadline then had no route left: no progress,
no completion, readings only on the tablet. Now the push goes out; the server answers `EXPIRED`
with `kept: true` and stores the readings without applying them. The device records
`lateProgressSentMarker` (the newest marker the push covered, kept or not) and, when kept,
`lateProgressKeptMarker` / `lateProgressKeptAt`; the row is not pushed again until something newer
is edited or the round is reopened. **The edit markers stay** — see «Deadlines, offline» for why.

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

#### The round's own answers are pushed when they are saved

Reported from the field: online, the first «ذخیره پرسش‌ها» reached the panel and the second and
third did not, until the final submit. Three causes, each enough on its own, all fixed:

1. **They waited for the timer.** An asset save is reported on the next tick on purpose — one
   request per asset save would multiply the fleet's cost by the size of a round (backend roadmap
   §3). The round-level answers are saved with a button, once or a few times a round, and the
   supervisor reads them live; waiting up to the sync interval (30 s by default, up to an hour on
   a tablet whose interval was raised) looked exactly like «not sent». **«ذخیره پرسش‌ها» now calls
   `syncManager.pushProgressNow()`**: the progress pass only — no inbox pull, no submit — gated on
   the same permission and session as the timer's, never throwing, and the next tick retries it if
   it fails. Both passes run in one serial lane (`progressLane`), so they never build payloads from
   the same markers at once.
2. **A bundle merge could overwrite a save that landed during it** — see «Decided inside the write»
   under the bundle merge.
3. **A bundle older than what the device had delivered put the previous answers back.** A bundle
   fetched a moment before a push landed and merged a moment after it — the push having already
   cleared the marker — carried the server's previous answers, and the merge let the server win.
   Now an accepted push that carried the answers records the server's `savedAt` as
   `sheetFormDeliveredAt`, and the merge keeps the device's answers while the bundle's
   `sheetFormUpdatedAt` is **older** than that. Server clock on both sides; a supervisor's later
   correction in the panel is newer and still wins.

The card says where the saved answers are — «روی دستگاه ذخیره شد؛ در صف ارسال», «به سرور رسیده‌اند»
or the server's refusal — from `sheetFormDelivery` (`utils/sheetFormDelivery.ts`), so «ذخیره شد»
is never read as «the supervisor can see it». Regression:
[`sheetFormDelivery.test.ts`](../src/services/sync/sheetFormDelivery.test.ts).

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

### 6b. In requests of twenty, and a refusal is not a blip (issue P-04)

The queue used to go out as **one** request under one `catch` that called every failure a network
blip: a body over nginx's 32 MB (`413`), more than 500 items (`400`) or any server fault that repeats
for this payload was re-sent every thirty seconds for ever, nothing marked, nothing shown — and one
oversized round held back every round behind it. `submitChunks.ts` now:

| | |
|---|---|
| **Chunks** | at most **20 items and ~8 MB of UTF-8 JSON** per request (`DEFAULT_SUBMIT_LIMITS`), in queue order; an item over the byte budget gets a request of its own |
| **Applies each answer as it arrives** | so a later failure can never lose an earlier request's outcomes |
| `0`, `408`, `429`, `502`–`504`, or not an API answer | **transient** — the pass stops; everything unsent stays exactly as it was; no error is flashed |
| `413` | the request is **halved** and both halves go next; a single item still too large is marked `failed` with `SYNC_OUTCOME_MESSAGES.TOO_LARGE` (kept on the device, counted «ارسال‌نشده», never purged) |
| any other status | **refused** — the items stay `pending`, the *other* requests still go; after `REFUSED_PASSES_BEFORE_SHOWING` (**3**) such passes in a row the sync indicator shows the server's message (`error` event with `transient: false`). One clean pass resets the count |

Fault reports go through the same function. Results are keyed by `localId`, so nothing else in the
result handling had to change; it now lives in named steps (`applyLogSheetResult`,
`markLogSheetDelivered`, `markLogSheetRefused`, `markLogSheetTooLarge`). Tests:
`submitChunks.test.ts` (pure), `submitBatchFailures.test.ts` (through `SyncManager`).

### 6c. One read of the table per pass (issue P-08)

The queue reads `getLogSheetsByStatus('submitted')` and the progress lane
`getLogSheetsByStatus('draft')` — the existing `status` index, no Dexie version bump — instead of
deserialising every round (each with up to 300 entries) several times every thirty seconds. The
pass reads the whole table **once**, after the submit, for the purge (`purgeLocalLogSheets`) and
hands the survivors to the backlog report; that read must be fresh, because deciding to delete from a
stale copy could remove a round re-opened meanwhile.

---

## Submission outcomes

The batch endpoint returns an outcome per item, and each means something different to the
device:

| Outcome | Meaning | Device does |
|---|---|---|
| `SUBMITTED` | Accepted | Mark synced, stamp `serverId`, release attachments. (The *outcome* name; the sheet's later `APPROVED` status is a separate thing — see below) |
| `DUPLICATE` | Already delivered (a retry of a **delivered** submission) | Treat as success — this is idempotency working. Since backend V25 a retry of a *refused* submission is never `DUPLICATE` (B-03 / P-03): it is answered with the refusal again |
| `EXPIRED` | Deadline passed server-side | Keep the data, surface the state; **not** an error |
| `CANCELLED` | The round was called off | Same |
| `SUPERSEDED` | Somebody else completed it, or it is no longer assigned to you | Same |
| `VALIDATION_ERROR` / `ERROR` | Server refused | Keep the data, show why |
| *(none — the request itself failed)* | the network, a 5xx, 408 or 429 | Nothing changes; the round stays `pending` for the next pass (§6b) |
| *(none — the request was too large)* | `413` | Halved and re-sent; a round still too large on its own is marked `failed` with «بیش از حد بزرگ» and kept (§6b) |
| *(none — refused as a whole)* | any other status on the batch request | The rounds stay `pending`; the server's message is shown after three such passes in a row (§6b) |
| *(none — the session ended)* | `401` | The session is dropped and the login page opens («نشست شما به پایان رسیده است»); the round stays `pending` and is sent after the next sign-in. On a revoked device this is also where a **wipe order** is found (below) |

**The server may store a different completion time than the device sent (backend V28, B-17).** A
`completedAt` more than five minutes in the server's future is stored as the server's receipt time.
The answer does not say so and the device keeps its own copy as it was; the round's page in the panel
shows what happened. With this app's server clock the case only arises when the device has never
measured since its clock went wrong.

**`kept: true` (backend V25).** On `EXPIRED`, `CANCELLED` and `SUPERSEDED` the server says
whether it stored the submission as a void row for a supervisor. The device records it as
`serverKeptAt`; the row stays `failed` either way (the round was not applied), but a kept row is
no longer «ارسال‌نشده» — the server holds its readings. A server older than V25 never says it,
and an `EXPIRED` from one is counted as undelivered (it really is).

**`kept: false` (backend V26).** The one case where the server answers `SUPERSEDED` or `CANCELLED`
*without* keeping the submission: this operator already has five different refused submissions
on the round. Recorded as `serverKeepRefusedAt`, which overrides the outcome's usual meaning — the
round is «ارسال‌نشده» and is never purged. `kept: true` and `kept: false` each clear the other; an
answer saying neither leaves both as they were (`keptFieldsOf`, `isRefusalHeldByServer`).

> **A refused submission is never discarded.** The operator did the work. The server stores the
> payload in `log_sheet_void_submissions` — the per-asset readings and, since backend V14, the
> round's own answers (`sheetFormData`), which before it were discarded on that path; since backend
> V15 the photographs those name follow as the void's evidence (`isVoidedSubmission`), and one the
> server still refuses is parked with its bytes kept rather than retried for ever — and the
> device keeps its copy, so a supervisor can
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
| Submitted locally, `completedAt > dueAt` | **Sent once** (since V25; it used to be refused before it was queued) | Refused **and kept** → void submission, `kept: true` (B-01) |
| Still a draft, with edits, deadline passed | **Sent once as late progress** (P-01) | Not applied, **kept** as the round's late-progress row (B-02), `kept: true` |
| Still a draft, no edits | Judged on the wall clock — there is no completion to date it by | n/a |

**After `kept`, what makes the work stand is the supervisor extending the deadline.** The inbox
merge sees the round open again and: re-queues a refused completion with a **new**
`clientActionId` (the server accepts it on its own `completedAt`); and clears a draft's
`lateProgressSentMarker`, so its readings go out again as ordinary progress and are applied. Their
edit markers were deliberately never cleared on `kept` — kept is not applied, and the markers are
what make this device's values win the merge against the server's older ones. If the supervisor
hands the round to somebody else instead, the first operator's readings stay in the server's kept
row and, on a shared tablet, in their local archive; the new holder starts from what the round
holds. All of this was walked live on 2026-11-17 (backend issue.md B-02).

A `serverStatus` of `EXPIRED` overrides the stamps in both directions: the server said so, and
the device does not argue with it except through the completion time above.

## The server's clock, on this device (roadmap §7, backend B-17)

**Every deadline above is the server's time, and so is `completedAt`.** Since 2026-11-18 neither is
read from `Date.now()`. `services/clock/serverClock.ts` keeps one offset, `server − device`,
measured on every answer that carries the server's time — `POST /api/auth/login` (from backend V28),
`GET /api/bootstrap` and the inbox — as `serverTime − (sentAt + receivedAt) / 2`; a sample whose
round trip exceeds 30 s, or that has no plausible server time, is refused. The newest accepted sample
wins (after a clock change the old offset is the wrong one), and it is persisted in `syncMeta`
(`serverClock`) and read back before the first render, so it holds offline and across a restart.

`serverNow()` is the device clock plus the offset, **never earlier than the server time last
seen**: time does not run backwards, so a clock set back after the last sync — a flat battery, or
somebody hiding a late round — cannot take the app before it. `rawServerNow()` is the same without
that floor, for the one check that must *notice* a clock set back (the offline-session ceiling,
below). Before the first measurement the offset is 0 and there is no floor: exactly the old
behaviour.

| On the server's clock (`serverNow()`) | On the device's clock (`Date.now()`) |
|---|---|
| `completedAt` / `submittedAt` stamped at submit, and the fallback in `toBatchPayload` | durations: a recording's length, a timer, the request timeouts |
| every deadline helper in `utils/logSheetStatus.ts`, `canContinueReopenedLogSheet`, `isUndeliveredRound` | the retention **ages** in `cleanupLogSheets.ts` — `syncedAt` and `submittedAt` are device stamps |
| `mergeInboxIntoLocalSheets` («extended»), `expireStaleLocalDrafts` | `locallyEditedAt`, `sheetFormLocallyEditedAt`, an entry's `createdAt`/`updatedAt` — the server echoes the last two back as a concurrency base, and moving them would make it refuse the very clear they protect |
| `isSessionValid` (a token's `expiresAt` is server time — a fast clock caused a sign-out loop) | the backlog report's resend throttle |
| `pullBootstrapIfStale` (`lastBootstrapAt` is the server's `serverTime`) | the reference-list lease, which was already offset-free (`leaseUntil − serverTime` from the page) |

The purge takes a device `now` and converts it for its deadline guards (`serverNow(now)` for
«reopened», «undelivered», an expired draft's age from `dueAt`) while its retention ages stay on the
device clock — never compare a device stamp with a server time.

**The correction travels with the round.** `completionClockOffsetMs` is stamped with `completedAt`
and sent as `clientClockOffsetMs`; the server keeps it beside the round as evidence and recomputes
nothing from it. The server also refuses a `completedAt` more than 5 minutes in its own future and
stores its receipt time instead (backend B-17) — the backstop for a tablet that has not measured
since its clock went wrong. Settings shows the measured difference («اختلاف ساعت این دستگاه با
سرور»).

**What it does not settle:** a clock set back by less than the time since the last sync is still
believed (the floor stops it at the last server time seen, not at the truth).

## Wipe on revoke (backend V28)

**The one place this app deletes readings that exist nowhere else — on purpose, and never on its own
decision.** An administrator who revokes this device on `/devices` may also order it to delete
everything the app holds, on a page that showed how many rounds the tablet last reported it had not
delivered. `services/device/deviceWipe.ts` is the device half.

**How the order arrives.** In the answer to `POST /api/auth/challenge` — `{wipe: true,
wipeOrderedAt}`, given even with enrolment switched off (`enforced: false`) — which this device asks:
when the login page finds the server reachable (a revoked device lands there: its session answers
401); inside every sign-in (`deviceAuth.prepareProof`, which looks for an order **before** routing on
`enforced`, or `enforced: false` would walk past it into a plain login); and before it would ever throw
its key away (`startEnrollment` on `DEVICE_REVOKED`, `restartEnrollment`), because a discarded key can
no longer be told anything; **and, while a session is open, on its own** — `useDeviceStatusWatch`
(mounted in `AppLayout`) asks at start, on reconnection, on returning to the foreground and on a
five-minute tick, each time only if the last check is 30 minutes old (`deviceStatusWatch.ts`,
`syncMeta.deviceStatusCheckedAt`, device clock — a clock set back reads as due). That last one exists
because a revoke reaches a tablet through 401 only when its session is **tied to the device**, which
a session opened while enrolment was off is not. Without an enrolled identity nothing is asked. Only
`wipe === true` with a numeric `wipeOrderedAt` counts.

**A revoke without a wipe, found by the same check** (`checkDeviceStatus` answering `revoked` —
enrolment enforced, device revoked, no order): the operator is signed out with «مجوز این دستگاه لغو
شده است و از حساب خارج شدید…», every round kept, and the next sign-in shows the enrolment card. Never
over the asset form on the timer or a return to the app — like the offline lock it waits for the next
navigation. With enrolment **off**, a plain revoke stops no login, so the check deliberately does
nothing (the server answers `{enforced: false}` and says nothing about the device). The wipe itself
proceeds even over an open form: everything on the device was ordered destroyed, typed values
included.

**How it is carried out.**

1. The order is written to `localStorage` (`mfdcs.deviceWipe`, stage `wiping`), other open copies of
   the app are told (`BroadcastChannel('mfdcs-device-wipe')`, they reload), and the app reloads.
2. `main.tsx` runs `resumeDeviceWipe()` **before `openDatabase()` and before anything renders** — so
   no screen, sync tick or live query holds the database or writes into it halfway. It moves the
   device key aside (identity row `wipe-ack`), reads the server address out of the old database, and
   deletes `offline-pwa-db` whole — rounds, readings, the archive of other users' rounds, photos,
   audio, video, signatures, NFC fault reports, reference lists, the inbox snapshot, the session —
   then every `localStorage` and `sessionStorage` key but the marker. The marker becomes
   `confirming`. A database another copy will not let go of within 15 s stops the start with a
   plain-DOM message («… در پنجرهٔ دیگری باز است …»), the marker still `wiping`, and the next start
   finishes. Killed halfway, the next start finishes too.
3. The fresh database is opened and given the server address back, and the login page says what
   happened («به دستور مدیر سامانه، همهٔ داده‌های این برنامه … پاک شد»).
4. `confirmPendingWipe()` signs `mfdcs-wipe\n<deviceId>\n<wipeOrderedAt>` with the set-aside key and
   posts it to `/api/devices/enrollment-requests/wipe-confirm`; at every start and whenever the login
   page finds the server, until it lands. The key and the marker are let go when the server records
   it **or** refuses it for good (any 4xx but 408 and 429); a network failure, a 5xx, a 408 or a 429
   keeps them for the next try.

**One order is carried out once.** An order the marker says was already carried out only has its
confirmation retried — by then the tablet may have been enrolled again and hold new work. And since
the live key was moved aside, the tablet is unenrolled at once: a new enrolment makes a new key while
the old one still owes its confirmation, and nothing is asked with an identity that is not enrolled.

**Without `localStorage`** (none survives a reload) the deletion runs at once instead, with the
database closed by the deletion itself; the confirmation is then not sent.

**What it cannot reach:** a tablet that never connects to the server again, and a tablet that was
never enrolled (no device row to order). **With enrolment switched off on the server** a session
opened while it was off is not tied to the device, so the revoke does not end it and no 401 sends the
tablet to the login page; the signed-in check above finds the order instead — **within 30 minutes of
the tablet being online**. Walked live on 2026-11-18 with the switch off: the revoke left the
session running, and the tablet's next check delivered, carried out and confirmed the wipe in about a
second. A second walk, with the session opened while off and the switch then turned on, confirmed
the plain-revoke sign-out is held back while the form is open and lands on the next navigation, with
both local rounds kept. Walked live on 2026-11-18: enrolled, a failed round, a
pending photo and an NFC fault report planted, revoked with wipe in the panel; the tablet's next
request answered 401, the login page asked the challenge, the order was delivered and confirmed a
second later, and every store but the settings row was empty, with no key left.

## The offline-session ceiling (backend V28)

**Offline, a session never expires on this device** — `isSessionValid` keeps it while the server is
unreachable, so an operator in a dead zone is not thrown out mid-round. From backend V28 the plant
can bound that (Settings in the panel, «قفل نشست آفلاین روی تبلت», off by default, 8–720 hours),
delivered on bootstrap as `offlineSession` and stored as `settings.offlineSessionLimit`
(`normalizeOfflineSessionLimit`: absent keeps what the device has — a device never told never locks;
a switch that is not exactly `true` is off; hours clamped, nonsense is 72).

`services/auth/offlineSession.ts` records the **last authenticated answer** — every 2xx to a request
that carried the token, and the sign-in itself — on the server's clock (`syncMeta`
`sessionLastContactAt`, written at most once a minute; cleared at sign-out and on a 401). The session
**locks** once `rawServerNow()` is `hours` past it, or reads more than 5 minutes **before** it (a clock
set back). A session from an older build with nothing recorded starts its count at the first check.

`useOfflineSessionGuard` (mounted in `AppLayout`) checks at start, on every navigation, every 60 s and
when the app returns to the foreground. **The timer and the return-to-foreground checks never
interrupt the asset form** (`/logsheets/:localId`), whose typed-but-unsaved values exist only in
memory: there the lock waits for the next navigation or start. A lock is the ordinary sign-out
(`signOut({ offlineLocked })`) — the session, the inbox snapshot and the reference lists go, **every
round, reading and unsent submission stays** and is sent after the next sign-in, which needs the
network. The login page says why («برنامه قفل شد: …»). Within 12 hours of the lock — or a quarter of
the ceiling, if less — `OfflineSessionNotice` says when it will happen. Walked live on 2026-11-18 with
the backend stopped: 62 h without contact showed the warning, 73 h locked with the unsent round kept,
and a clock 2 h behind the last contact locked with the clock message.

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

## How long a round stays on this device

This section is the whole answer to «how long does X stay on this tablet», for every kind of thing
the app stores and every state it can be in. Nothing is deleted anywhere else; if a case is not in
these tables, it is kept.

`cleanupLocalLogSheets` (`cleanupLogSheets.ts`) deletes local rounds the device no longer needs —
from `logSheets` only, never anything on the server. **How long each kind stays is the server's
decision** (backend roadmap §41, V24): three settings in the panel's «تنظیمات», delivered on
bootstrap as `deviceRetention`, stored in `settings.deviceRetention`, and turned into windows by
`resolveRetentionWindows` (`deviceRetention.ts`). The decision for one row is
`isEligibleForLocalPurge`, which is pure.

### When the purge runs — and when it does not

| Trigger | What runs |
|---|---|
| The end of every sync pass that reached the server | the round purge (`purgeLocalLogSheets`, over the one read of the table the pass makes), then the attachment queue, which ends by dropping the bytes of files uploaded more than 7 days ago (`purgeSyncedAttachmentBlobs`) |
| The app comes online (or starts online) **with a session** | the round purge (`useSyncManager` → `cleanupLocalLogSheets`) |
| Start-up with a session, and sign-in — **online or not** | reference lists whose lease ended (`expireLookups`) — the only expiry that runs offline |
| Opening a lookup field | that one list, if its lease ended |

**So offline, and without a session, nothing about rounds or files is ever deleted by time.** A
window that passed while the tablet was offline is acted on at its next sync. The settings arrive
on bootstrap — always at sign-in; otherwise when the app opens, comes back online or pulls the inbox,
and only if the last bootstrap is an hour old (there is no timer of its own) — and an offline tablet
runs on the last values it saw.

**Which clock.** A retention **age** is measured on this device's clock against this device's own
stamps (`syncedAt`, `submittedAt`, `uploadedAt` are written with `Date.now()`), so a wrong clock
shifts it but cannot mix two clocks. Anything compared with a **server** time — the deadline guards
(«reopened», «undelivered») and an expired draft's age, which counts from `dueAt` — is converted to
the server's clock first (`serverNow(now)`, see «The server's clock, on this device»).

**Which settings.** Below, «synced window» is `syncedRetentionHours` (1–720, default **24**), «the
switch» is `unsyncedPurgeEnabled` (default **off**) and «unsynced window» is
`unsyncedRetentionHours` (72–8760, default **168**). A tablet that has never received the block runs
on the constants it shipped with (24 h / 7 days / 24 h — last column).

### Rounds (`logSheets`), state by state

| Local round | With the server's settings | Never received any (an older server) |
|---|---|---|
| **Draft, being worked on** (deadline not passed, not cancelled or taken away) | never | never |
| **Draft whose deadline passed, with edits the server has not kept** — undelivered | **never, whatever the settings** (issue P-05) | never |
| Draft whose deadline passed, **with no edits** of its own, or whose edits the server kept as late progress (`lateProgressKeptMarker`) | never — or, with the switch on, the unsynced window after `dueAt` | 24 h after `dueAt` |
| Draft **cancelled** by a supervisor, or **taken away** (released, reassigned, taken over — `REVOKED`) | never **while its deadline stands** — it is still a draft. Once the deadline has passed the device marks it expired (`expireStaleLocalDrafts`) and the two rows above apply: kept for ever if it holds unkept edits | the same, with 24 h for the case without edits |
| **Submitted, waiting to sync** (`pending` / `syncing`) | never | never |
| **Synced** — accepted (`SUBMITTED`, `DUPLICATE`) | the synced window after `syncedAt` → `submittedAt` → `updatedAt` → `createdAt` | 24 h |
| Synced, then **reopened** by a supervisor (`isReopenedAfterSync`) | never while the new deadline stands; then the synced window | the same |
| **Refused but held by the server** — `SUPERSEDED`, `CANCELLED`, or `EXPIRED` answered `kept: true` (late work, backend V25) | never — or, with the switch on, the unsynced window after `submittedAt` → `updatedAt` → `createdAt` | 7 days |
| **Refused and held nowhere else** — `VALIDATION_ERROR` (waiting for the operator's correction), `ERROR`, too large to send, an `EXPIRED` an older server did not keep, any answer with `kept: false` | **never, whatever the settings** (issue P-05) | never |

«Undelivered» is one definition, `isUndeliveredRound` (`undelivered.ts`) — the same one the
dashboard's «ارسال‌نشده» card and the report to the panel count — and the purge asks it **before**
any window, so no setting, legacy constant or clock can delete the only copy of a reading. Such a
round leaves the tablet only by being delivered, or by a wipe an administrator ordered (below).

**Archived snapshots** (`logSheetUserArchives` — another operator's round, kept when a shared tablet
changed hands) are **never removed by time**. One goes when its owner's live copy of that round is
delivered (synced) — on that owner's next sync or sign-in on this tablet — or when the owner restores
it into the live round. Until the owner comes back, it stays.

### Everything else the app keeps

| What | When it goes |
|---|---|
| **A file waiting to upload** (`pending`, or `failed` and still retried) | never by time; it carries its own server sheet id, so it is delivered even after its round's row is purged |
| A file **uploaded** (`synced`) | its **bytes** are dropped 7 days after upload, at the end of a sync pass; the row stays, so the form still shows it and fetches it from the server when online. The row goes with its round |
| A file **parked** (refused for good, not retried) | with its round, when that round is purged — **except** one parked by a 403 (a voided round's evidence the server would not take): kept even then, being the only copy |
| A file the operator removed | at once if it never reached the server; otherwise kept as «to delete» until the server confirms the delete |
| **NFC fault reports** | **never** — sent ones stay too; only a wipe or clearing the app's data removes them |
| **Reference lists** (lookup, backend §31) | when the lease runs out — per list, `device_lease_hours` (default 24) counted from the last sync that refreshed it, checked at every start and sign-in **even offline**; when the device clock reads earlier than the server time it last saw for that list; when no assigned round needs the list any more (next sync); when the server answers 403/404 for it; and at sign-out, the offline-session lock and a wipe — personal data |
| Plant reference data from round bundles (assets, classes, field definitions, locations, templates, units) | never removed; each bundle overwrites what it carries |
| The inbox snapshot | replaced by every inbox pull; cleared at sign-out, the offline-session lock, a user switch and a wipe |
| The session (`authSession`) | online: when the server says it ended (401), when its expiry passes on the server's clock, or when the device-status check finds this device revoked with enrolment on; offline: kept — until the offline-session lock, if the plant switched it on; sign-out and a wipe |
| The last server contact (`sessionLastContactAt`) | at sign-out, the lock, a 401 and a wipe |
| The measured server clock (`serverClock`) | never; each new measurement replaces it. A wipe removes it |
| Settings (server address, sync interval, orientation, the server-owned policies) | never — a wipe keeps only the server address |
| The device key (`mfdcs-device-identity`) | when its device is revoked and this device asks to enrol again («درخواست ثبت تازه»), or once a wipe's confirmation has reached the server; never at sign-out |

### What removes everything at once

| Event | What goes | What stays |
|---|---|---|
| Sign-out | the session, the bound user id, the inbox snapshot, reference lists, the last server contact | every round, file, report, archive and setting — a shared tablet's next operator must not destroy the last one's unsent work |
| **The offline-session lock** (backend V28) | the same as sign-out | the same as sign-out |
| **A revoke found by the device-status check** (backend V28, enrolment on) | the same as sign-out | the same as sign-out — and the device key, which a new enrolment replaces |
| **A wipe ordered by the server** (backend V28) | everything above, **unsent rounds included** | the server address; the device key only until the confirmation lands |
| Clearing the app's data, uninstalling, a factory reset | everything, the key included | nothing |
| A database from a **newer** build (a rollback) | if it holds anything unsent: nothing — the app refuses to start and says why; otherwise the whole database is deleted and recreated, which loses only what the server already has (synced rounds, reference data) and the settings row | the device key (its own database) |

### Three examples, on the default settings

- A round synced at 10:00 Monday is in History until the first sync after 10:00 Tuesday. Its photos'
  bytes went a week after their upload at the latest — or with the round, whichever comes first.
- A round refused as `VALIDATION_ERROR` stays until the operator corrects and sends it, however long
  that takes and whatever the switch says. Refused as `SUPERSEDED` (kept on the server), it stays for
  ever with the switch off; with the switch on and 168 h, until the first sync a week after it was
  submitted.
- A draft whose deadline passed with three readings in it stays for ever (undelivered) — unless the
  server keeps those readings as late progress, after which it is an expired draft whose readings the
  server holds: kept for ever with the switch off, a week after `dueAt` with it on.

**Before V24 these windows were constants** — 24 h synced, **7 days refused, 24 h past the
deadline** — and the last two deleted rounds whose readings had never reached the server
([issue P-01](issue.md#p-01)). The server default now keeps them.

**And the switch on never deletes the only copy ([issue P-05](issue.md#p-05), 2026-11-18).** The
first version of §41 purged every failed row and expired draft alike once `unsyncedRetentionHours`
had passed. `isEligibleForLocalPurge` now asks `isUndeliveredRound` first — the same question the
«ارسال‌نشده» count asks — and keeps everything it covers: a `VALIDATION_ERROR` waiting for the
operator's correction, an `ERROR`, an `EXPIRED` an older server did not keep, a refusal answered
`kept: false`, a draft with unkept edits. Such a round leaves the tablet only by being delivered —
or by a **wipe an administrator ordered** (backend V28, «Wipe on revoke» above). Clearing one by hand,
or a ceiling that removes even the only copy after N days, is **backend roadmap §42 — weighed there,
undecided**. Note for whoever builds either: this purge runs only online with a session
(`useSyncManager`, and after a sync pass), so a time limit means nothing on a tablet opened offline
until it also runs at app start.

Four rules, all in `deviceRetention.ts`, that make sure a value nobody chose never deletes work:

1. **Never received → the shipped constants.** `settings.deviceRetention` is optional and has no
   entry in `DEFAULT_SETTINGS`; its absence is the signal. A tablet talking to an older server
   therefore behaves exactly as before. Do not add a default object: it would be
   indistinguishable from a value the server chose.
2. **Received but unreadable → server defaults, purge off.** A block that is not an object, an
   hour that is not a positive finite number (zero included — it would mean «now»), a switch that
   is anything but exactly `true`. Each field is read on its own, so one bad value costs nothing
   else.
3. **Clamped twice** — when `pullBootstrap` stores the block and again when the purge reads it, so
   a record corrupted in IndexedDB is held to the same bounds as one corrupted on the wire.
4. **A settings row that cannot be read purges nothing that pass.** The pass runs again after the
   next sync; guessing a window could delete what an administrator chose to keep.

A server that sends no block (or `null`) leaves the stored values alone, like `attachmentLimits`
and `mobilePolicy`; an offline tablet keeps the last values it saw. Regression tests:
[`deviceRetention.test.ts`](../src/services/sync/deviceRetention.test.ts),
[`cleanupRetention.test.ts`](../src/services/sync/cleanupRetention.test.ts),
[`retentionRoundTrip.test.ts`](../src/services/sync/retentionRoundTrip.test.ts) and the
«device retention» block of [`bootstrapLimits.test.ts`](../src/services/sync/bootstrapLimits.test.ts).

---

## Rounds the server has received in no form — «ارسال‌نشده» (backend V25)

`services/sync/undelivered.ts` is the **one** definition, read by the dashboard card
«ارسال‌نشده», the device-check page and the report to the panel:

| Counted | Not counted |
|---|---|
| A submitted round refused with nothing kept: `failed` with no `serverKeptAt` and an outcome other than `SUPERSEDED` / `CANCELLED` (`EXPIRED` from an older server, `VALIDATION_ERROR`, `ERROR`, too large to send, or a row an older app failed locally) — **or any outcome answered `kept: false`** (`serverKeepRefusedAt`, backend V26) | `synced`; still queued (`pending` / `syncing` — that is «در انتظار ارسال»); refused but kept (`serverKeptAt`, or `SUPERSEDED` / `CANCELLED` without `kept: false`, kept since backend V14) |
| A draft with edits of its own that can no longer travel as progress — expired, cancelled, revoked — unless the server kept those edits (`lateProgressKeptMarker` ≥ the newest marker) | An open draft (ordinary progress); a draft with no edits; an archived snapshot (its own store) |

The dashboard counts over the viewer's own rows, like its other cards; the device-check page and the
report count the **whole device**, because they answer "what would be lost if this tablet were
wiped".

**The report** (`services/sync/backlogReport.ts`) is `POST /api/sync/backlog` with the count and
the oldest, sent after a sync pass **only when** the number changed, an hour has passed, or the
signed-in session is a different one (the server keeps it on the session's row — found live: a
second operator signing in with the count unchanged was otherwise never reported). The last report
is `syncMeta.lastBacklogReport`. Best-effort: its own try/catch, and a 403/404 from an older server
is swallowed. It is what lets a supervisor see a tablet holding work nobody has seen — and,
since issue P-05, exactly the rounds the local purge will never touch, whatever the switch says.

---

## Pull

### `pullBootstrap`

Master data plus server-owned settings (the attachment ceilings, the scanning policies and, since
backend V24, `deviceRetention` — see «How long a round stays on this device» above). All three
blocks land in one settings write. Staleness-gated:

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

### Reference lists (backend roadmap §31 Phase 2)

Right after the inbox merge, `syncRequiredLookups(requiredFromBundles(assigned))` brings the
device's lists in line with what the **assigned** rounds declared in `context.requiredLookups` —
which is exactly the server's grant. It never throws: a list problem must not stop the inbox, and a
lookup field always has code-only entry to fall back on.

| Situation | What it does |
|---|---|
| A list no assigned round needs | dropped (set difference) |
| Never fetched, a pass unfinished, a revision behind the round's, or past half its lease | fetched page by page (500) from the stored `(updatedAt, id)` cursor — so an interrupted pass resumes and a held list fetches only what changed. The revision recorded is the **first** page's (backend AGENTS.md #217) |
| Current and within half its lease | nothing — each page is a row in the server's download log |
| 403 / 404 | the grant is gone: dropped |
| Network failure | kept as it is; tried again at the next pull |

A copy is searched only while **usable** — a full pass reached the end, the lease runs, and the
device clock is not behind the last server time seen (`lookupStore.isUsable`). Otherwise the field
says why («not on this device», «still syncing», «lease ended») and takes a code.

Because the inbox is not pulled on the push tick, a list can lag behind the server while the
operator works. The field's **«به‌روزرسانی فهرست»** button (`refreshLookup`) fetches that one list
now: from its cursor, renewing its lease, dropped on 403 / 404, no other list touched. A field whose
definition sets `lookupAcceptsUnlistedCode` also offers «use this code» when a search finds nothing.

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

**The round's own answers are part of all of this.** Archiving, resetting a reassigned draft,
archiving before a server overwrite and keeping the archived card visible all used to ask only
about answered *assets*; a round answered only at round level (every asset-less round) was then
cleared on reassignment with no archive at all. `sheetHasLocalWork` — an answered asset **or** an
answered round question — is the one definition now. In a restore the round appears as one more
unit, «پرسش‌های این کار», under the reserved id `ROUND_RESTORE_ID`, offered first, with the same
conflict and attachment rules as an asset; restoring it stamps `sheetFormLocallyEditedAt` and queues
a progress report, exactly as the questions card's own save does.

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

#### Decided inside the write

The ordinary refresh of a round being walked reads the stored row, then awaits — the context
merge, the session user — and only then writes. An operator can save an asset or the round's
questions in that gap, and a write built from the earlier read put back the values the save had
just replaced **and cleared its marker**, so the save vanished without ever being pushed. The
ordinary branch now writes through `updateLogSheetFrom(localId, current => …)`: the row is re-read
**inside one `rw` transaction**, and `mergeValuesFromRow` — the pure half of the merge that decides
entries, round answers and signature baselines — runs against it there. A save is either before
the transaction, and seen by the decision, or after it, and untouched. The builder must be
synchronous: an IndexedDB transaction commits as soon as nothing is pending on it. The
reset-draft and mark-synced branches hand the row to the server's version on purpose (with an
archive first when work would be lost) and keep their single read.

#### Signature verdicts (backend roadmap §32)

The bundle carries `signatureStates` — the server's verdict (`VALID`, `STALE`, `NOT_BOUND`) for
every signature on the round, keyed by owner and field — and the merge stores it with
`signatureBaselines`: for each `VALID` signature, this device's fingerprint of the answers it
covers **as this merge delivered them**. The field then shows «امضا پیش از تغییر …» when the
answers on screen no longer match that baseline, before anything is saved; a drawing not yet
delivered is judged against the `localFingerprint` taken when it was drawn. A device fingerprint
is only ever compared with another device fingerprint, never with the server's hash.

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

### An id somebody else already used (issue P-06, backend B-10)

The id is minted here and reaches the server inside the round's answers **before** the bytes do,
and anyone who may read the round may read it — so a colleague could upload their own file under it
first. The server now answers that `409` with `code: ATTACHMENT_ID_TAKEN` (`ApiError.code`), and
[`attachmentIdTaken.ts`](../src/services/sync/attachmentIdTaken.ts) re-mints:

1. **Only while the round can still carry a changed answer to the server** — a draft (its next
   progress or late-progress push carries it) or a completion not yet sent (its submit carries
   it). A delivered or refused round's answers are final on the server, so a re-mint there would
   upload a file nothing names: the row is **parked** instead, bytes kept, with
   `ATTACHMENT_ID_TAKEN_MESSAGE` and status 409 (never revived by sign-in).
2. **In one Dexie transaction**: the attachment row moves to a fresh UUID (`idRemintedFrom` = the
   old id), and the reference in the entry's `formData` — or the round's own `sheetFormData` for
   media with no asset — is rewritten in place, order kept, and marked edited (`locallyEditedAt` /
   `sheetFormLocallyEditedAt`) so the next push carries it and later merges keep it. A crash can
   never leave an answer naming an id no row holds.
3. **Uploaded again at once** — the one retry. `idRemintedFrom` is also the rule: a second
   collision parks the row.

A plain `409` (the field is full) is unchanged: retried, never re-minted. Tests:
`attachmentIdTaken.test.ts`.

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

**The file's own owner is the fact; the sheet is context.** `LocalAttachment.createdByUserId` is
stamped at capture, and it has to be, because the sheet cannot answer the question after a
reassignment — see *A round that changes hands* below.

`isAttachmentUploadableByUser` is the gate, on uploads and on server-side deletions alike:

| Situation | Sent? |
|---|---|
| The sheet is this operator's work, and they captured the file | Yes |
| Assigned to them, nothing saved locally yet | Yes |
| **A colleague captured the file**, whatever the sheet now says | No — checked first, and it vetoes the sheet |
| The file carries no owner (captured before the field existed) | Yes — falls back rather than stranding it; the `version(3)` backfill keeps this rare |
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

### A round that changes hands

The failure this cost, reported from the plant:

> Operator A takes a round, goes offline, photographs the equipment and hits final submit — all
> without a link. Still offline, they sign out. A supervisor reassigns the round to operator B,
> who signs in on the **same tablet**. B opens the fill page and sees A's photographs as if they
> had taken them. And when the round goes back to A, A's own media appears to be gone.

**Why.** One local row per server sheet, reused across operators: reassignment takes the
`reset-draft` path, which empties the readings but leaves `localId` alone and never touches
`db.attachments`. So A's rows were still "this field's attachments" for B — counted against B's
ceiling, and **adopted** into B's own reading by `AttachmentFieldInput`'s orphan repair, which
had no notion of whose orphan it was. B would then submit them as their own evidence, and
deleting one would queue a server-side delete of A's.

Meanwhile A's work is archived under a synthetic `archive:<serverId>:<userId>` route id, which is
not a stored `logSheetLocalId` — so looking it up as one found nothing and A's own media appeared
to have vanished.

**The fix is at the data level, not a special case in `reset-draft`.** With an owner on the row:

- `getAttachmentsForEntry` is scoped to the signed-in operator, so the counter, the list and the
  adoption repair all see only their own — adoption still rescues an operator's own duplicated
  capture, which is the reason it exists;
- an archived view is resolved through the snapshot's own key (`logSheetServerId` + that
  snapshot's user), so A sees their media again;
- the upload and delete queues judge the row, not the sheet.

Nothing is deleted and no row moves: a colleague's media stays on the device, owned by them,
until their own sync or the ordinary cleanup pass. Regression tests:
[`attachmentHandover.test.ts`](../src/services/sync/attachmentHandover.test.ts).

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

`cleanupLogSheets` holds a reopened row back from the synced purge (24 hours by default, the
server's `device.synced_retention_hours`) while its new deadline stands — it is live work, and it
is also the only place `filledVia` survives.

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
