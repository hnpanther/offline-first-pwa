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

## One scan, one tag

`stopNFCScan()` stops **whichever** reader is running. It used to stop Web NFC only, so in the APK
the native reader stayed on after the first scan. A Hytera PNC460 reports a tag again while it is
still near the antenna, so the next «اسکن NFC» opened the previous asset with no tag in reach.
Samsung tablets report once per tap and never showed it.

`useNFC` also clears the stored tag when a scan starts and ignores tags that arrive while no scan
was requested. Details in [apk.md §7](apk.md#7-nfc).

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
ticket. `entry_source` records `PWA_NFC`, `PWA_QR` or `PWA_MANUAL`, and the data-quality report
is built on the distinction.

---

# QR — the other way to identify an asset

**Code:** [`src/services/scan/qrScanner.ts`](../src/services/scan/qrScanner.ts),
[`src/components/logsheet/QrScanDialog.tsx`](../src/components/logsheet/QrScanDialog.tsx)

## Which rounds offer it

`logSheet.scanMode`, frozen by the server when the round was raised and arriving inside
`bundle.sheet` with no contract change: `NFC` (the default and what every round was before this
existed), `QR`, `NFC_OR_QR`, or `NONE`. The fill page offers the button(s) that round allows and
no others; on `NONE` there is no scan bar at all and tapping an asset row opens its form.

Absent means `NFC` — a bundle from an older server carries no such field, and reading it as
anything else would change how a historic round is walked.

## The payload is the tag id, verbatim

A QR code carries exactly what Record 1 of the tag would have carried, so
`matchLogSheetEntryByTag` is reused **unchanged** and there is no second identifier space to keep
in step. The scanner trims the decoded string and does nothing else to it: no URL unwrapping, no
prefix stripping. A transformation invented here would mean a sticker printed from the panel and
one printed from a label machine resolving differently, and the one that failed would be the one
already in the plant.

## There is no strict mode for QR, and that is correct

`nfcStrictSerialMatch` compares the chip's hardware UID with the one recorded on the asset. **A
QR code has no hardware UID** — it is a printed string, clonable by photocopier. The check is
therefore not applied to a QR read rather than failing it: applying it would reject every QR
read on a plant that has strict mode on, which is how the two modes would silently become
incompatible. A site that needs clone-resistance chooses `NFC` for that round.

This is why `filledVia` keeps `'qr'` apart from `'nfc'` all the way to the server: the two carry
different evidence, and a column that merged them would have every report overstate what half
its rows prove.

## One decoder, compiled into the app

| | | |
|---|---|---|
| **Decoder** | `zxing-wasm` 3.1.6 — `zxing-cpp`'s reader compiled to WebAssembly | QR **and** every linear symbology below, in one pass |
| **Cost** | `zxing_reader.wasm`, **925 KB**, precached once, plus a 36 KB / 13 KB gzipped glue chunk loaded on the first scan | nothing per frame beyond the decode itself |
| **Needs** | nothing. No Play Services, no module download, no network, ever | — |

Formats asked for on every frame (`FAST_FORMATS`): `QRCode`; and for a linear field `Code128`,
`Code39`, `Code93`, `Codabar`, `EAN13`, `EAN8`, `ITF`, `UPCA`, `UPCE` — the same nine the platform
decoder used to be asked for, name for name, so no label that used to scan has quietly stopped
being looked for. Data Matrix, Aztec, PDF417 and MaxiCode are deliberately **not** requested: they
are not on this plant's labels, and every enabled symbology is work on every frame.

### The bug that set the rule

On Android the camera opened, the operator aimed at a sticker the phone's own camera app read
instantly, and **nothing ever happened** — no error, no message, no result.

The decoder was `window.BarcodeDetector`, and on Android that API is backed by a Google Play
Services module which is **downloaded on demand**. These handhelds have no network, ever, so the
module was never there. The way that surfaces is the worst one available: the constructor exists,
`getSupportedFormats()` answers with a real list, `detect()` resolves without throwing, and returns
an empty array for every frame for ever. Measured on the device: **434 frames, no errors, no
reads.**

Three rounds of defence were built against it and **none of them could ever have worked**, because
each waited for a signal that does not come:

| Defence | Why it could not fire |
|---|---|
| `getSupportedFormats()` must list a usable format | it listed them |
| a trial `detect()` must complete | it completed |
| fail over to `jsqr` on the first frame error | there were no errors |
| after 2 s of silence, re-read off a canvas and through `jsqr` | the canvas read used the *same* dead module, and `jsqr` reads QR only |

A decoder that answers «no code here» 434 times is indistinguishable from an operator with bad
aim. So the decoder stopped being something the platform provides. It is compiled into the app, and
«offline» is no longer a condition scanning can fail under.

**`BarcodeDetector` is now consulted nowhere in the scan path.** The device-check page still reports
what it claims, last and labelled «استفاده نمی‌شود», only so that a tablet whose history includes
this failure can still be recognised.

### What replacing it bought

- **Linear barcodes work at all.** The old fallback was `jsqr`, which reads QR and no linear
  symbology whatsoever — so on these devices a field set to `BARCODE` could *never* be scanned: the
  platform decoder was blind and the fallback did not implement the format. That limitation is gone,
  and `jsqr` is no longer a dependency.
- **About 250 lines of gates, failover, rescue and probing deleted**, along with the pure function
  (`usableNativeFormats`) and the `failover` branch that existed only to decide whether to trust
  the platform.
- **One behaviour to support**, reproducible at a desk, instead of a property of which Play Services
  modules a given tablet happened to have pulled down.

### The `.wasm` must be precached — the line this all depends on

`vite.config.ts` carries `wasm` in the workbox `globPatterns`. **Remove it and scanning works at
the desk and dies the moment a tablet leaves Wi-Fi** — every chunk, font and icon precached, and
the one file the decoder cannot run without silently absent. That is the bug this decoder replaced,
reintroduced one glob at a time. The build is the check: `zxing_reader-<hash>.wasm` must appear in
`dist/sw.js`'s precache manifest, which went from 34 entries to 35.

`maximumFileSizeToCacheInBytes` is raised to 3 MiB for the same reason. Workbox's default is 2 MiB
and a file over it is dropped from the precache **silently**; 925 KB is comfortable today, but this
is by far the largest asset here and a future ZXing release could cross that line with no warning
and no symptom until a tablet is offline.

### How the file is loaded, and why not by URL

`zxing-wasm` resolves its WebAssembly through a jsDelivr URL baked in at **its** build time, so the
default behaviour of a fresh install is a CDN fetch on the first scan — on this fleet a guaranteed
failure whose only symptom is a scan dialog that never starts. `zxingModule.ts` instead imports the
file as an asset (`?url`, which makes Vite emit it with a content hash), `fetch`es it, and hands the
bytes over as Emscripten's `wasmBinary`. That buys two things a `locateFile` URL does not:

- **no dependency on the `Content-Type`.** A URL leads to `WebAssembly.instantiateStreaming`, which
  refuses anything not served as `application/wasm`. nginx has it (and now gzips it), and
  Capacitor's asset loader maps the extension explicitly (`WebViewLocalServer.java`), so both
  deliveries happen to be fine — but the APK does not go through nginx at all, and that header is
  not ours to guarantee there.
- **a failure that names itself.** A `fetch` we issue can be checked, so a missing or unprecached
  file raises `DecoderUnavailableError` naming the URL, and the device-check page prints it.

`locateFile` is **also** pointed at the local asset, purely so that if `wasmBinary` ever stopped
being honoured the fallback would be the precached file rather than a CDN.

The load is started **beside** `getUserMedia`, not after it: the camera takes a few hundred
milliseconds to come up, which is long enough to hide the fetch and the instantiation entirely.

### Two passes over a frame, and the cheap one runs first

ZXing's defaults optimise for accuracy — `tryHarder`, `tryRotate` and `tryInvert` all on. That is
right for a label somebody is struggling with and wrong for the first second, when it only costs
frames. So:

- **every frame**: the accepted formats only, with `tryHarder` / `tryRotate` / `tryInvert` **off**,
  `maxNumberOfSymbols: 1`, and `tryDownscale` left on (ZXing's own image pyramid is how a label
  photographed too close still resolves, and it is cheap next to the other three).
- **after `THOROUGH_AFTER_MS` (1.5 s), every third frame**: all three on, plus the formats a small
  nameplate carries — `MicroQRCode` and `RMQRCode`, which are separate bits from `QRCode` in
  `zxing-cpp` and so are simply not looked for unless named, and `ITF14`, `DataBar`, `DataBarExp`.

Every third frame and not every one: the cheap pass is what reads an ordinary label, and starving it
would make a scan that was about to succeed slower rather than likelier. One `getImageData` per
frame is shared by every pass — on a 1280×720 frame it is the single most expensive call in the
loop.

`textMode: 'Plain'` is load-bearing and invisible. ZXing's own default is `'HRI'`, which rewrites
GS1 content with bracketed application identifiers; a payload that happens to look like that would
come back reformatted and match nothing stored. There is a test for exactly that.

### A frame-decode error has two outcomes, not three

`decideOnDecodeError(consecutiveErrors)` returns `retry` / `giveUp`:

- **`retry`** — a bounded number of times. A frame can fail while the camera reconfigures, and
  ending the session on that would make the scanner flaky, which is its own bug report.
- **`giveUp`** — after `HARD_FAILURE_LIMIT` (12) consecutive failures, reject with the real error.
  This branch did not exist originally, which is why the loop ran for ever.

A decode that merely finds no code **resets** the counter: the decoder worked. `failover` is gone
and should not come back — it existed to escape the platform decoder, and there is no platform
decoder to escape. One decoder that is part of the app either works here or is broken for a reason
worth reporting; a second code path would only hide that again.

### The camera is asked for a frame worth decoding

`facingMode: 'environment'`, plus `width/height: { ideal: 1280 × 720 }` and a best-effort
`focusMode: 'continuous'`. The Android default is often 640×480 fixed-focus, and a blurry or
too-small frame of a dense label decodes as nothing at all — indistinguishable from the same
silence. All of it `ideal` rather than `exact`, so a camera that cannot manage it still opens. One
canvas is reused for the whole session, because allocating a video-sized buffer sixty times a second
is felt as the camera stuttering.

`qrScanSupport()` answers a deliberately narrow question: **is there a camera**. It returns
`available` / `noCamera` / `noDecoder`, the last meaning no camera API at all. It no longer has to
hedge about the decoder — the decoder ships with the app, so the camera is the only open question on
any device, which is the whole point of the change.

`startQrScan` still prefers a Capacitor plugin named `Qr` if a build registers one, exactly as
`nativeNfc` does. **None is written, and there is no longer a reason to write one**: its only
argument was giving the APK linear barcodes without the WebView's binding, and that is now true
without it. A bundled ML Kit would be faster still, but it would be APK-only — the browser build
would then need a second decoder — and one code path across both deliveries is worth more than the
milliseconds.

### A code of the wrong kind is named, not ignored

A field set to accept only a linear barcode used to get a detector blind to QR, so a QR sticker in
front of it produced a live camera and nothing else — under an instruction that said «QR یا
بارکد». A code of the other kind is named instead: «یک QR Code دیده شد، اما اینجا فقط بارکد خطی
پذیرفته می‌شود…», pointing at the panel where the field's accepted kinds are set, and the
instruction line names exactly what will be read (`scanDialogText.ts`).

**The version of this that broke scanning, and the rule it left.** The first cut searched all ten
symbologies on every frame and acted on whichever code came first; scanning then stopped working in
the field — a second code on a label, or a spurious linear read off printed text, set the wanted
code aside on every frame, and each frame was slower. A first repair still re-judged each read by
its format name (`format === 'qr_code'`), which rejects a correct QR on a platform that spells the
format differently. So the per-frame read asks for the **accepted formats only** and takes its first
payload without re-checking the kind (`Detection.accepted` comes from *which pass* read it), and the
wrong-kind probe does not exist for the first three seconds (`WRONG_KIND_PROBE_AFTER_MS`); after
that it runs on one frame in eight (`WRONG_KIND_PROBE_EVERY`), re-using the same `getImageData`,
purely to name a code. **Never widen or re-judge the per-frame path again to get a message.**

Where a kind *is* judged by what was read, it is judged by the **symbology** and not the format:
`familyOfFormat` compares against `QRCode`, the root every QR variant reports, so Model 1, Model 2,
Micro QR and rMQR are covered by one comparison rather than a list a new variant falls out of.

### The session reports on itself

`QrScanSession.stats()` carries the decoder in use, the number of frames handed to it, the last
error, and a detail line (ZXing's version, the frame size, and how many thorough and probe passes
have run). After four seconds with no result `QrScanDialog` shows it, because the one state an
operator cannot diagnose is "the camera is on and nothing is happening":

- **frames 0** → the camera, not the decoder.
- **frames rising, no error** → aim, light, distance or a dirty label.
- **an error** → the decoder itself, named.

### What the tests actually prove, and what they do not

Every previous scanner bug passed a green suite: the platform decoder was mocked, or tested only
through the pure functions that decided whether to use it, and «does a camera pointed at this label
produce this string» was answered only by somebody standing in a plant.

`zxingDecode.test.ts` closes that. ZXing's **writer** draws a QR code and five linear barcodes and
the **reader the app ships** reads them back — using `readerOptions()` itself rather than a copy, so
the suite cannot keep passing while the settings the operator's camera uses drift. It also pins that
the accepted kinds are enforced (a QR is *not* read by a barcode-only field, and the reverse) and
that `textMode` does not reformat a GS1-shaped payload. Eleven tests, about 100 ms.

Its `locateFile` points at `http://127.0.0.1:1/`, so **every test in it is also a check that no
fetch happens**: if the decoder reached for that URL, instantiation would fail and all eleven would
go red. That has to be an unreachable address rather than a stub that throws — see AGENTS.md #182.

It does **not** cover loading: a `?url` import and a `fetch` of it mean nothing under Node, so that
half is verified by the build (the precache manifest) and on a device. And it does not cover blur,
glare, angle or distance — a generated symbol is a perfect one. It says the decoder decodes; it does
not say a label in a plant is legible.

## The camera is stopped by the dialog that started it

`QrScanDialog` owns the session and stops it on close, on a successful read, and on unmount. A
track that outlives its dialog keeps the sensor powered and the indicator light on; on a tablet
that stays on one screen for a whole shift that is both a battery cost and something an operator
reasonably reads as the app watching them.

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

**A photo is not `getUserMedia`.** It is `<input type="file" capture="environment">`, which hands off
to the device's camera app. Chrome does that by itself. In the APK it also needs a `<queries>` entry
for `IMAGE_CAPTURE` in the manifest: without one, Android 11+ hides the camera app from this app and
Capacitor silently opens the **file manager** instead. That is what the Hytera PNC460 did, while
Chrome on the same tablet opened the camera fine.

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

## Playing back what was captured

Every photo, voice note and clip on screen gets **one** object URL from `utils/mediaUrls.ts`
(`MediaUrlCache`). The URL is kept while the attachment stays in the field and revoked when it is
deleted or the field closes. The same URL survives re-renders, so a clip being played back is not
reloaded when the operator types elsewhere in the form or while another recording counts up.

When the bytes have been reclaimed after sync (7 days), a photo is downloaded again, **once**, and
only when the device is online. A voice note or clip is not downloaded: its player stays empty
rather than pulling megabytes over the plant network just because a field was opened. The file is
still on the server.

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

# Device enrolment

**Code:** [`src/services/device/deviceIdentity.ts`](../src/services/device/deviceIdentity.ts),
[`src/services/device/deviceAuth.ts`](../src/services/device/deviceAuth.ts),
[`src/components/auth/DeviceEnrollmentCard.tsx`](../src/components/auth/DeviceEnrollmentCard.tsx)

Off by default on the server (`auth.device_enrollment.enabled`). The server side, the threat model
and what it does not cover are the backend's `docs/security.md` §3c; this is the device's half.

## What changes on the tablet

**With enrolment off, nothing.** A tablet that has never been enrolled sends the one login request
it always sent. A tablet that *has* been enrolled first asks `/api/auth/challenge`; a server with
enrolment off answers `{enforced: false}`, an older server answers 404, and either way the login
goes out exactly as before.

**With it on**, an unenrolled tablet's login is refused before the password is evaluated, and the
login page shows «ثبت این دستگاه» **under** the form — the form keeps the username and password, so
once the device is approved the operator presses «ورود» once more:

1. «درخواست ثبت» creates the key and sends its public half; the tablet shows a **request number**.
2. The operator reads it to an approver, who issues an eight-digit code from the panel.
3. The code is typed (Persian/Arabic digits, spaces and dashes are normalised exactly as the
   server does), signed together with the request number, and sent. Approved.

From then on every login fetches a nonce and signs `mfdcs-login\n<nonce>\n<username>`.

## The key

`crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, false, ['sign', 'verify'])` —
**`extractable: false`**: the private key can sign and can never be read out, not even by this
app's own JavaScript. Signatures are IEEE P1363 (64 bytes), which is what the server verifies
(backend AGENTS.md #173). WebCrypto exists only in a secure context: production is HTTPS and the
APK is `https://localhost`; a developer on `http://<lan-ip>:5173` gets «ثبت دستگاه فقط روی اتصال
امن…» instead of an obscure failure.

It is stored in **its own IndexedDB database**, `mfdcs-device-identity`, not in `offline-pwa-db` —
see AGENTS.md, "The device key lives in its own database". It is lost by clearing the app's data,
reinstalling or a factory reset, and then a new enrolment is the right answer: a wiped device
cannot prove it is the old one.

## What each server answer does

| Situation | The tablet |
|---|---|
| enrolment off, or an older server | logs in exactly as before |
| not enrolled | the card: «درخواست ثبت» |
| request made, no code yet | the card resumes with the stored request number; «بررسی دوباره» re-asks the server, which answers an already-approved key with *approved* — the case of a response lost on the way back |
| wrong code | the server's sentence and how many tries remain; five wrong destroys the code |
| request expired or unknown | back to «درخواست ثبت» |
| device revoked or unknown | **stopped before the password is sent**; «درخواست ثبت تازه» discards the dead key and starts over — a new approval is still required |
| enrolment switched on between the challenge and the login | one automatic retry with a proof, so an enrolled tablet never sees the card for that |

A revoked device's running session ends through the existing "session ended" path: the next
request gets 401 and the operator lands on the login page with the usual notice. Nothing about
unsynced work changes — it stays on the device, as for any ended session.

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
