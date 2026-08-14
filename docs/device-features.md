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

Web NFC is **Chrome on Android only**. Not iOS, not desktop. On a device without it the app
falls back to manual entry — with an NFC fault report, so the bypass is recorded rather than
silent.

## What a valid tag contains

| | |
|---|---|
| **Record 1** | `text/plain` holding the sub-function's `tag` — the logical identity |
| **Chip serial** | The hardware UID, read from the chip itself, not written by anyone |

The chip is bolted to the **position**, not to the equipment. Replacing a pump does not mean
re-tagging: the new asset inherits the same sub-function and therefore the same tag.

## Strict serial mode

`nfcStrictSerialMatch` — **on by default**, admin-only to change.

With it on, a scan must match **both** Record 1 **and** the recorded `nfc_serial`. Record 1 is
writable by anyone with a phone; the hardware serial is not. Checking only the logical tag
means a cloned chip passes.

An asset's serial is recorded the first time an admin scans it from the NFC inspect page.

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

## Capture and compression

Images are compressed on the device before storage. A modern phone camera produces 5–10 MB per
photo; a round with a dozen photos would be 100 MB in IndexedDB and an unusable upload over
plant Wi-Fi.

Video is captured with strict size control for the same reason, more urgently.

## Limits come from the server

Maximum size and maximum count per field arrive through `GET /api/bootstrap` and are stored in
`settings.attachmentLimits`.

**The device enforces the same ceiling the server does**, so an operator learns a file is too
big *before* recording it rather than after walking back. The settings screen shows these
read-only — the device is not their owner.

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

| Feature | Chrome Android | Safari iOS | Desktop | Fallback |
|---|---|---|---|---|
| Web NFC | ✅ | ❌ | ❌ | Manual entry + fault report |
| Camera / mic | ✅ | ✅ | ✅ (webcam) | Field left empty |
| Geolocation | ✅ | ✅ | ✅ (coarse) | Clear error, field left empty |
| Orientation lock | ✅ **installed only** | ❌ | ❌ | Free rotation, stated in Settings |
| IndexedDB | ✅ | ✅ | ✅ | none — required |
| Service worker | ✅ | ✅ | ✅ | none — required |

## Related

- **[storage.md](storage.md)** — where captures are kept
- **[sync.md](sync.md)** — how they reach the server
- **[../AGENTS.md](../AGENTS.md)** — the traps
