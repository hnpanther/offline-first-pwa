# Device Features

The browser APIs this app depends on: NFC, camera and microphone, GPS, and screen orientation.
Each is unevenly supported, and each degrades in a way that was chosen deliberately.

**Code:** [`src/services/nfc/`](../src/services/nfc/), [`src/services/device/`](../src/services/device/),
[`src/components/forms/`](../src/components/forms/)

---

# NFC

**Code:** [`src/services/nfc/index.ts`](../src/services/nfc/index.ts),
[`matchLogSheetEntry.ts`](../src/services/nfc/matchLogSheetEntry.ts)

## Availability

Two implementations answer one question, `isNFCSupported()`:

| Where | Reader |
|---|---|
| Chrome on Android | **Web NFC** (`window.NDEFReader`) |
| The packaged app | a **native plugin** over `NfcAdapter` |
| Everywhere else | nothing — manual entry |

Web NFC is a Chrome API: not iOS, not desktop, and — the one that catches people — **not Android's
WebView**. Inside the packaged app `NDEFReader` is simply absent, so without the plugin scanning
would disappear from the app with no error anywhere. See [apk.md §7](apk.md#7-nfc) for the plugin
and the payload contract it keeps.

On a device with neither, the app falls back to manual entry — with an NFC fault report, so the
bypass is recorded rather than silent.

Both routes decode a tag through the **same** `decodeRecordData`. That is not tidiness: two
decoders would drift the first time either was fixed, and a tag would then read differently
depending on whether the operator was in Chrome or in the app — the worst way for this to fail,
and the hardest to notice.

## What a valid tag contains

| | |
|---|---|
| **Record 1** | `text/plain` holding the sub-function's `tag` — the logical identity |
| **Chip serial** | The hardware UID, read from the chip itself, not written by anyone |

The chip is bolted to the **position**, not to the equipment. Replacing a pump does not mean
re-tagging: the new asset inherits the same sub-function and therefore the same tag.

## Strict serial mode

`nfcStrictSerialMatch` — **on by default, and owned by the server.**

With it on, a scan must match **both** Record 1 **and** the recorded `nfc_serial`. Record 1 is
writable by anyone with a phone; the hardware serial is not. Checking only the logical tag
means a cloned chip passes.

An asset's serial is recorded the first time an admin scans it from the NFC inspect page.

**The device cannot change it.** It arrives in the bootstrap payload's `mobilePolicy` from the
backend's `nfc.strict_serial_match` setting; the value in `settings` is a mirror kept so scanning
still works offline. It was a switch on this screen once, which made the integrity of every
reading depend on a control an operator could reach — and let two tablets in one plant disagree
about what a valid scan is.

An administrator changes it in the **web panel's Settings page**, with no restart, for the one
real case: a site whose serials are not recorded yet, where strict mode rejects every scan.

## Typing a tag instead of scanning it

`canEnterTagManually` — **a permission, not a setting.** The manual-entry box appears for whoever
holds `GET:/log-sheets/{id}/fill` (supervisor / senior operator) and for nobody else.

The device switch that used to grant it (`allowManualEntry`) is gone. It returned true for every
caller, so anyone who could open the Settings screen could hand a whole shift the ability to type
a tag instead of scanning one. Being a permission also means a **duplicated role inherits it**,
which a role-name check never did.

Distinct from the fault-report fallback below, which unlocks manual entry for **one asset** after
a report is filed.

## Scan failures are deliberately opaque

Three different failures produce **one** message
(`t.logSheet.nfcVerificationFailed` — «اطلاعات این تگ صحیح نیست…»):

- Record 1 could not be read
- The serial does not match
- The asset has no serial recorded

Naming which check failed hands whoever is holding the tag a map of how verification works, and
the operator's next step — tell an administrator — is identical in all three cases.

**One failure stays specific:** a *valid* tag that is simply not on this sheet. That is a
routing mistake the operator can fix themselves, and it reveals nothing.

Keep this distinction if you add outcomes to `matchLogSheetEntryByTag`.

## When a chip is broken

The operator files an **NFC fault report**, which unlocks manual entry for that asset. The
report is what turns "the scan was bypassed" from a silent hole in the data into a maintenance
ticket. `entry_source` records `PWA_NFC` or `PWA_MANUAL`, and the data-quality report is built
on the distinction.

---

# Camera, microphone and video

**Code:** [`src/services/storage/attachments.ts`](../src/services/storage/attachments.ts),
[`src/services/sync/attachmentSync.ts`](../src/services/sync/attachmentSync.ts)

Three field types: `image`, `audio`, `video`.

In a browser these are `getUserMedia`, and the browser prompts. **In the packaged app the prompt
only happens if the permission is declared in `AndroidManifest.xml`** — Capacitor maps a
`getUserMedia` request onto the matching Android permission and asks at the moment of use, but an
undeclared permission is refused outright: no prompt, no error the page can see. That is exactly
how camera and microphone came to do nothing at all in the first APK. The declarations, and why
each `<uses-feature>` is `required="false"`, are in [apk.md §8](apk.md#8-camera-microphone-and-location).

## Capture and compression

Images are compressed on the device before storage. A modern phone camera produces 5–10 MB per
photo; a round with a dozen photos would be 100 MB in IndexedDB and an unusable upload over
plant Wi-Fi.

Video is captured with strict size control for the same reason, more urgently.

## Annotating a photo before it is stored

**Code:** [`src/utils/imageAnnotation.ts`](../src/utils/imageAnnotation.ts),
[`src/components/forms/ImageAnnotationDialog.tsx`](../src/components/forms/ImageAnnotationDialog.tsx)

Server-owned switch (`imageAnnotationEnabled`, on by default, admin-editable in the web panel).
With it on, a captured photo goes to a review step — pen, arrow, box, text, colours, widths,
undo/redo/clear — and is stored only when the operator confirms. Off, the capture path is exactly
what it was before: compress, store.

Three decisions carry the whole feature:

1. **It runs on the compressed capture, never the camera's raw file.** The compressed bitmap is
   what gets stored either way, so a mark drawn on it lands in the saved file exactly where the
   operator put it. On the raw file, EXIF orientation can differ between the preview and a later
   decode, and every mark would be rotated off its target.
2. **Marks are data, re-rendered on every change — not paint.** Undo, redo and clear are then
   array operations rather than full-canvas bitmap snapshots of several megabytes each.
3. **Coordinates are normalised to 0..1 of the image.** The canvas is displayed at whatever width
   the screen allows and baked at the image's real size; a stroke recorded in screen pixels would
   land elsewhere in the saved file, and would move again if the tablet rotated mid-annotation.

The result is baked into the image before storage, so nothing downstream changes: one blob, the
same upload queue, the same `width`/`height`, and a reviewer in the web panel opens the annotated
file itself rather than an overlay something has to re-render.

Confirming with no marks returns the original blob untouched — no second encode, no extra
generation of lossy compression.

## Limits come from the server

Maximum size and maximum count per field arrive through `GET /api/bootstrap` and are stored in
`settings.attachmentLimits`.

**The device enforces the same ceiling the server does**, so an operator learns a file is too
big *before* recording it rather than after walking back. The settings screen shows these
read-only — the device is not their owner.

## A ceiling ends the recording exactly as the operator would

There are two ceilings on a recording — a **duration** and a **byte count** — and reaching either
does the whole of what pressing stop does, not part of it:

| | |
|---|---|
| The blob is closed | at the ceiling |
| The microphone / camera is released | at the ceiling — the browser's recording indicator goes out |
| The clip is saved | through the *same* handler a manual stop uses |
| The counter stops | clamped to the ceiling |
| The operator is told | which ceiling, because the two ask for different things next |

`startAudioRecording` / `startVideoRecording` return a handle whose **`finished` promise resolves
for every ending**, and `AttachmentFieldInput` awaits it and runs its ordinary save. That is why
the save path is shared rather than duplicated: anything added to saving later — a storage check,
a compression step — applies to an automatic stop for free.

### Why the duration is measured at the stop, not at the read

`durationMs` is `stoppedAt − startedAt`, stamped in `onstop`. This is the single most important
line in the file, and it used to be `Date.now() − startedAt` evaluated inside `stop()`:

> The ceiling cut the clip correctly at two minutes. The operator, seeing a counter still
> climbing, pressed stop five minutes later. The clip was two minutes long and was reported as
> five. The server refuses a duration past its ceiling, and the upload queue parks a 4xx as
> permanent — **so a perfectly valid clip was destroyed by the number attached to it.**

It is additionally clamped to the ceiling. That is not a fudge: media only grows when
`ondataavailable` delivers a chunk, and the overdue check runs on every one of those, so the blob
cannot exceed the ceiling by more than a single timeslice **by construction**. Wall-clock time
beyond that is the process having been suspended with no media produced, and reporting suspension
as recorded content is what destroys the clip.

### Two mechanisms for one ceiling

| Mechanism | Fires | Covers |
|---|---|---|
| `setTimeout(maxDurationMs)` | exactly at the ceiling | the normal case |
| an elapsed check inside `ondataavailable` | ~once a second, from the media stream | **a throttled background timer** — with the tablet's screen off a `setTimeout` can be delayed by minutes, and then the blob itself overruns, which no amount of honest reporting can fix |

### `onstop` is installed once, at construction

Not inside `stop()`. That one detail is what makes every row of the table above true, and its
absence is what made all of them false: with no handler at ceiling time the stream was never
released, nothing saved, and the special-case «already stopped» branch invented the wrong
duration. Regression: [`recordingLimits.test.ts`](../src/utils/recordingLimits.test.ts) — 14 of
its cases fail against the old shape.

## The truthiness trap

An attachment field's value is an **object**, and an object is truthy even when it holds nothing
usable. Required-ness must be checked by inspecting the contents, never with a bare `required`
or a truthiness test. The same trap applies to the `location` field.

## Storage and upload

Covered in [storage.md](storage.md#attachments-why-the-id-is-minted-on-the-device) and
[sync.md](sync.md#attachment-upload). The two points that matter:

- The attachment id is a **UUID minted on the device**, so a capture can be named and stored
  with no network.
- Attachments upload on a **separate queue** from sheets, so a large video never blocks a small
  set of readings.

---

# GPS — the `location` field

**Code:** [`src/services/device/geolocation.ts`](../src/services/device/geolocation.ts),
[`src/components/forms/LocationFieldInput.tsx`](../src/components/forms/LocationFieldInput.tsx)

## The PWA captures; the web panel types

| | How it is answered | Why |
|---|---|---|
| **PWA** | «ثبت موقعیت فعلی» reads the device position | There *is* a device position to read, so a typed coordinate would be an unverifiable claim about where somebody stood |
| **Web panel** | Two numeric inputs | There is no device — this is a supervisor correcting a reading or entering one from a survey |

`LocationFieldInput` is capture-only on purpose. There are no latitude/longitude boxes here.

## Capture options, and why

```ts
{ enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 }
```

- **`enableHighAccuracy`** — a coarse network fix cannot tell one pump from the next. The cost
  is a slower, more power-hungry read, which is the right trade for a reading taken once per
  round.
- **`maximumAge: 0`** — refuses a cached fix. The point is where the operator is standing *now*,
  not where the phone was when it last looked.

**GPS needs no network**, which is the whole reason this is captured here rather than typed in
later.

## Accuracy travels with the reading

```ts
...(Number.isFinite(accuracy) ? { accuracy: Math.round(accuracy * 10) / 10 } : {})
```

In a plant a phone fix can be tens of metres out — the difference between "at the pump" and
"at the next pump". A coordinate with no accuracy figure cannot be judged. It is included only
when the device actually reports it; a fabricated `0` would read as perfect.

## The stored shape

```ts
{ type: 'location', lat, lng, accuracy?, capturedAt }
```

Identical to what the web panel's two inputs are paired into server-side, so no reader ever has
to cope with two shapes.

## Errors are separated because only one is actionable

| Kind | Message |
|---|---|
| `denied` | Turn on location permission — **the only one the operator can fix** |
| `unavailable` | Try again outdoors with GPS on |
| `timeout` | Took too long, try again outdoors |
| `unsupported` | This device or browser cannot |

---

# Screen orientation

**Code:** [`src/services/device/screenOrientation.ts`](../src/services/device/screenOrientation.ts),
[`src/hooks/useScreenOrientation.ts`](../src/hooks/useScreenOrientation.ts)

Auto / Portrait / Landscape, in Settings, **admin-only** — an operator flipping the orientation
of a wall-mounted tablet mid-round is not a decision that belongs to them. (`/settings` is
behind `AdminRoute` and the control is disabled for non-admins.)

## A device preference that never syncs

The right answer depends on how *that* tablet is mounted on *that* trolley. A shared account
signing in on a wall-mounted tablet and a hand-held phone must not drag one device's choice onto
the other. It lives in local `settings` and is never sent to the server.

## Re-applied on every launch, and on resume

A lock does not survive the app closing, so `useScreenOrientation` re-applies it from `App`.

It also re-applies on `visibilitychange`: **Android drops the lock when a PWA is backgrounded
and restored from the task switcher**, and that is the ordinary way an operator uses the app all
shift. Without this the setting appears to work once and then stop.

## Loose axis, not `-primary`

```ts
type OrientationLockType = 'portrait' | 'landscape'
```

The `-primary` variants pin one specific way up, so a tablet rotated 180° in its cradle would
show an upside-down app. The looser value keeps the axis and lets the device pick the way up.

## Failures are reported, never thrown

The app always degrades to free rotation. But swallowing the *reason* was a mistake — an
administrator who picks Landscape and watches the tablet keep rotating cannot otherwise tell a
browser that refuses from a setting that did not save.

`applyScreenOrientation` returns an outcome:

| Outcome | Meaning |
|---|---|
| `{ applied: true }` | Locked |
| `auto` | Free rotation was chosen |
| `unsupported` | No `screen.orientation.lock` at all (iOS Safari, older browsers) |
| **`notInstalled`** | **The lock was refused and the app is in a browser tab** |
| `refused` | Installed and still refused; carries the platform's own error text |

**`notInstalled` is the one that matters.** Chrome refuses to lock a page in a normal tab
regardless of the manifest, and "open the app from its installed icon" is something a person can
actually act on. Note that "Add to Home screen" can produce a shortcut that still opens a tab —
which looks installed to whoever did it, and is not.

---

# Support matrix

| Feature | Chrome Android | Android app (APK) | Safari iOS | Desktop | Fallback |
|---|---|---|---|---|---|
| NFC | ✅ Web NFC | ✅ native plugin | ❌ | ❌ | Manual entry + fault report |
| Camera / mic | ✅ | ✅ *declared permissions* | ✅ | ✅ (webcam) | Field left empty |
| Geolocation | ✅ | ✅ *declared permissions* | ✅ | ✅ (coarse) | Clear error, field left empty |
| Orientation lock | ✅ **installed only** | ✅ | ❌ | ❌ | Free rotation, stated in Settings |
| IndexedDB | ✅ | ✅ | ✅ | ✅ | none — required |
| Service worker | ✅ | ✅ *assets are bundled* | ✅ | ✅ | none — required |

## Related

- **[apk.md](apk.md)** — the packaged app: the NFC plugin, the manifest permissions, CA trust
- **[storage.md](storage.md)** — where captures are kept
- **[sync.md](sync.md)** — how they reach the server
- **[../AGENTS.md](../AGENTS.md)** — the traps
