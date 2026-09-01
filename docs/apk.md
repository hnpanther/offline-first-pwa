# The Android app

The same PWA, packaged as an APK with [Capacitor](https://capacitorjs.com). One codebase, one
`dist/`, two ways of reaching an operator: a browser pointed at nginx, or an app installed on a
tablet.

This file covers what the packaging adds, why each piece is there, and — the part you will come
back for — **exactly what to rebuild when something changes**.

---

## 1. Why an app at all

The PWA installs from Chrome and works offline. For most sites that is enough. Two things are
not reachable from a browser on a plant network:

- **Reading NFC tags on a device that is not running Chrome.** Web NFC is a Chrome API. It is not
  in Firefox, not in Samsung Internet, and — the reason this matters — not in Android's WebView.
- **Getting installed at all, on a tablet with no internet.** Chrome's "install app" path is
  reliable; Google's WebAPK minting is not, because it happens on Google's servers at install
  time. A tablet in a plant with no route to the outside cannot install a PWA properly, and the
  result silently degrades to a bookmark.

An APK is a file. It can be copied onto a tablet from a USB stick, and it carries everything with
it.

### What the app is *not*

It is **not** a second frontend. `android/` contains no application logic: the web assets are
copied in by `npx cap sync`, and the only hand-written code is one NFC plugin (§7), the manifest,
and the network configuration. Anything that changes behaviour changes it for both the browser and
the app, because there is only one of it.

---

## 2. What you need installed

| | |
|---|---|
| **Android SDK command-line tools** | `C:\Android\Sdk\cmdline-tools\latest\bin` — Android Studio is **not** required |
| **Platform + build tools** | `platforms;android-36`, `build-tools;35.0.0` (install with `sdkmanager`) |
| **JDK** | 21 or 25 to compile — but the one that runs Gradle itself must be 21, see §2.2 |
| **Node** | as for the PWA |
| **`npm install` up to date** | `node_modules` must actually contain `@capacitor/cli` — see below |

None of this needs Android Studio. A machine with nothing but Node and a JDK gets there with the
steps below.

### 2.1 Android SDK command-line tools, from zero

1. Download **"Command line tools only"** for Windows from
   <https://developer.android.com/studio#command-line-tools-only> — a
   `commandlinetools-win-*_latest.zip`, a few hundred MB. Android Studio is not needed for
   anything in this project.
2. The zip extracts to a folder named `cmdline-tools`. `sdkmanager` insists on one extra layer of
   nesting: rename that extracted folder to `latest` and place it inside a `cmdline-tools` folder
   of its own, so the final path is exactly:

   ```
   C:\Android\Sdk\cmdline-tools\latest\bin\sdkmanager.bat
   ```

   Get this wrong (e.g. `C:\Android\Sdk\cmdline-tools\bin\sdkmanager.bat`, one level too shallow)
   and `sdkmanager` still runs but cannot find or install packages, with an error that does not
   point at the folder layout.
3. Install exactly what this project's Gradle config asks for
   (`android/variables.gradle`: `compileSdkVersion 36`) — installing the wrong platform/build-tools
   version builds nothing:

   ```bash
   & "C:\Android\Sdk\cmdline-tools\latest\bin\sdkmanager.bat" "platform-tools" "platforms;android-36" "build-tools;35.0.0"
   ```

4. Accept the licenses (interactive — type `y` for each prompt):

   ```bash
   & "C:\Android\Sdk\cmdline-tools\latest\bin\sdkmanager.bat" --licenses
   ```

5. Point Gradle at the SDK with `android/local.properties`. **It is committed**, already holding
   the default this page installs to, so if you followed the path above there is nothing to do:

   ```
   sdk.dir=C\:/Android/Sdk
   ```

   Forward slashes, and the drive colon escaped as `\:`. It is a Java `.properties` file, where
   `\` starts an escape — a Windows path with backslashes fails with *"The filename, directory
   name, or volume label syntax is incorrect"*, which does not sound like a quoting problem at all.
   The file's own comments carry this, plus the macOS and Linux forms.

   **If your SDK is elsewhere, keep the edit out of git** — it is your machine's path, not the
   project's, and committing it breaks the build for everyone else:

   ```bash
   git update-index --skip-worktree android/local.properties
   ```

   The Capacitor template gitignores this file, and for a project with many contributors that is
   the right default. It is committed here because this is one site building against one
   documented SDK location, and a fresh clone that cannot build until somebody discovers an
   undocumented file is the worse trade.

### 2.2 The JDK that runs Gradle must not be 25

The table above says JDK 21 or 25 both work — that is true for **compiling this project's Java**,
but not for the JDK that launches the **Gradle daemon itself**. Gradle 8.14.3 (the wrapper version
this project pins) cannot start its own daemon on JDK 25 yet:

```
BUG! exception in phase 'semantic analysis' in source unit '_BuildScript_'
Unsupported class file major version 69
```

("69" is JDK 25's class file version — nothing to do with `android/settings.gradle`, even though
that is the file the error points at.) If your machine's default `JAVA_HOME` is JDK 25 — common
if it was installed most recently — point the build at JDK 21 for this one command instead of
downgrading anything system-wide:

```bash
$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-21.0.8.9-hotspot"
npm run build:apk
```

Or set `JAVA_HOME` to a JDK 21 install permanently (System Properties → Environment Variables) if
you build APKs regularly — a build tool silently picking whichever JDK is newest is exactly the
kind of thing that works on one machine and fails on the next.

### 2.3 `npm install`, or `npx cap sync android` fails with a non-answer

```
npm error could not determine executable to run
```

That is `npx` unable to find the `cap` binary — `@capacitor/cli` is listed in `package.json` and
`package-lock.json` but is missing from `node_modules`. This happens whenever `node_modules` has
drifted from the lockfile (a fresh clone that only ran `npm ci` for a subset, an interrupted
install, `@capacitor/*` added to `package.json` without a follow-up install). The fix is the
install `build:apk` assumes already happened:

```bash
npm install
```

`npm run build:apk` does **not** run this for you — it is a build script, not a setup script — so
after cloning the repo, or after any dependency change, run `npm install` once before the first
`npm run build:apk`.

---

## 3. Building it

First time on a machine, in order: §2.1 (SDK + `local.properties`), then a plain `npm install` —
`build:apk` does not install dependencies for you, only builds with whatever is already in
`node_modules` (§2.3). After that:

```bash
npm run build:apk
```

That is four steps, and each is available on its own:

| Script | Does |
|---|---|
| `npm run ca:apk` | Copies `certs/rootCA.crt` into the Android project (§5) |
| `npm run build:mobile` | `tsc` + `vite build --mode mobile` → `dist/` |
| `npm run sync:apk` | The two above, then `npx cap sync android` — copies `dist/` into the app |
| `npm run build:apk` | `sync:apk`, then the Gradle wrapper via `scripts/build-apk.mjs` |
| `npm run icons:apk` | Regenerates launcher icons and splash from the project SVGs (§6) |

The APK lands at:

```
android/app/build/outputs/apk/debug/app-debug.apk
```

The last step goes through a Node script rather than a shell one-liner for two reasons, both
learned here: the wrapper differs by platform (`gradlew.bat` / `gradlew`) and npm does not hand
the script the shell you are typing in, and — the one that matters — **the script exits with
Gradle's status**. The one-liner it replaced printed `'gradlew.bat' is not recognized` and still
exited 0, so the build reported success while producing no APK at all. On Windows the wrapper has
to go through `cmd.exe`: Node 20 refuses to spawn a `.bat` directly (CVE-2024-27980) and fails
with a bare `EINVAL` that says nothing about why.

Copy it to the tablet and open it. Android will ask to allow installing from that source once.

### Why this is not a release build

**Debug, not release** — and after the hardening below, that names the *signing key* and almost
nothing else. It is worth being precise about what the two build types still differ in, because
the word "debug" suggests far more than is true here:

| | `assembleDebug` (what ships) | `assembleRelease` |
|---|---|---|
| **Signing** | the local debug key, automatically | **nothing configured** — an unsigned APK |
| `debuggable` | **false** — overridden, see below | false |
| Resource path shortening | **on** — arrives with `debuggable false` | on |
| `minifyEnabled` | false | false (explicitly, in this project) |
| PNG crunching | off | on (marginal size difference) |
| `BuildConfig.DEBUG` | true | false |

That last row changes nothing here: **neither Capacitor nor this project's Java reads
`BuildConfig.DEBUG`.** Capacitor keys its own behaviour to `ApplicationInfo.FLAG_DEBUGGABLE`
(`CapConfig`: `isDebug`), which the hardening already sets false. So the only difference that
would be felt is the first one.

And on that one, the debug build is the *practical* choice rather than the compromise:
`buildTypes.release` has no `signingConfig`, so `assembleRelease` writes
`app-release-unsigned.apk`, reports **BUILD SUCCESSFUL**, and produces a file every device refuses
with a message that never mentions signing. `scripts/build-apk.mjs` therefore **refuses any task
matching `release`** outright, rather than letting Gradle succeed into something unusable.

#### What the debug key actually is

Worth knowing precisely, because it is the thing the whole arrangement rests on:

```
signer     C=US, O=Android, CN=Android Debug
file       ~/.android/debug.keystore          (per machine, per user profile)
password   android                            — the documented, universal constant
alias      androiddebugkey
validity   30 years
```

Cryptographically it is an ordinary 2048-bit RSA key and its signature is as valid as any other.
Three properties are what make it a *debug* key, and all three are about custody, not strength:

1. **The password is public.** `android` is the same on every machine on earth, so the file alone
   is the entire secret.
2. **It is per machine.** A colleague building on their laptop signs with *their* key, producing an
   APK that cannot update tablets carrying yours — with nothing anywhere to say why.
3. **It regenerates itself silently.** Delete the file and Gradle makes a new one; the build
   succeeds and the APK is fine, but its signature has changed. A release keystore fails the build
   instead, which is the whole difference.

Property 3 is the one that costs data: Android identifies an app by (package name, signing
certificate), so a changed signature means every tablet must **uninstall before it can install**,
and uninstalling deletes IndexedDB (§10).

#### Why that is acceptable here, and when it stops being

It is acceptable because this fleet is updated by **uninstall and reinstall** (§10). A fresh
install compares no signatures, so which key signed the APK — or which machine built it — does not
arise. The debug key's worst property is neutralised by the update procedure rather than by
managing it.

**The trigger for changing this is one thing only: wanting to update a tablet *in place*.** Not
security (the hardening above is independent of the key), not tidiness, not the word "debug". If
uninstall-and-reinstall stays the procedure, a release keystore buys nothing at all.

Reasons that trigger arrives:

- The fleet grows past what can be swept by hand in one sitting.
- Wiping a tablet's database on every update stops being acceptable — the pre-wipe sync check
  (§10) is the fragile step, and it fails destructively.
- Someone needs to hand out builds without physically holding every device.

#### Migrating to a signed release build

**Do it before the fleet carries real work.** Switching keys is itself a signature change, so it
costs one uninstall-and-reinstall round on every tablet — free today, expensive later. Same
asymmetry as §5's CA.

**1. Create the keystore, once, deliberately.**

```bash
keytool -genkeypair -v -storetype PKCS12 \
  -keystore mfdcs-release.jks -alias mfdcs \
  -keyalg RSA -keysize 4096 -validity 10950
```

`10950` days is 30 years, and it must outlive the fleet: **an expired signing key means no more
updates, ever.** Keep the file *outside the repo*, backed up in at least two places, with the
password in the organisation's password manager. Never commit either — and note that from this
point the file is irreplaceable, because Android has no key rotation that works without the
original key.

**2. Point Gradle at it through a gitignored file.**

`android/keystore.properties` — add it to `android/.gitignore` alongside `local.properties`:

```properties
storeFile=C:/keys/mfdcs-release.jks
storePassword=…
keyAlias=mfdcs
keyPassword=…
```

`android/app/build.gradle`:

```gradle
def keystoreProperties = new Properties()
def keystorePropertiesFile = rootProject.file('keystore.properties')
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(new FileInputStream(keystorePropertiesFile))
}

android {
    signingConfigs {
        release {
            storeFile file(keystoreProperties['storeFile'])
            storePassword keystoreProperties['storePassword']
            keyAlias keystoreProperties['keyAlias']
            keyPassword keystoreProperties['keyPassword']
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
            minifyEnabled false     // see the warning below before changing this
            proguardFiles getDefaultProguardFile('proguard-android.txt'), 'proguard-rules.pro'
        }
    }
}
```

**3. Give `versionCode` a monotonic source.** This stops being optional the moment updates happen
in place: a tablet refuses an APK whose `versionCode` is lower than the installed one, as a
downgrade. See the subsection below for where the value lives and the options for generating it.

**4. Remove the release guard** in `scripts/build-apk.mjs` (the `if (/release/i.test(task))`
block), and point `build:apk` at `assembleRelease`.

**5. Rewrite §10's update procedure and the README's APK section.** The uninstall step, the
pre-wipe sync check and the "debug key is fine because we never update in place" reasoning all
become wrong at once — they are one decision, not three.

> **Do not turn on `minifyEnabled` in the same change, or casually afterwards.**
> `proguard-rules.pro` in this project is **empty**, and Capacitor finds plugins by reflection:
> `registerPlugin(NfcPlugin.class)` plus `@PluginMethod` annotations. Without keep rules ProGuard
> renames or strips them, `window.Capacitor.Plugins.Nfc` comes back undefined, `isNFCSupported()`
> answers false, and **tag scanning disappears from the app with nothing logged** — the same silent
> shape as §7's registration trap, from a third cause. The APK is 3.9 MB; there is nothing to win
> here.

### Every build calls itself version 1

`android/app/build.gradle` has `versionCode 1` and `versionName "1.0"` written in, and nothing
moves them. Every APK this project has ever produced claims to be the same version as every other
one.

Installing still works — Android accepts an APK over an equal `versionCode`, so a tablet updates
normally from a USB stick. What is lost is the ability to answer *"which build is this tablet
on?"* from the tablet. Settings → Apps shows `1.0` on a device flashed this morning and `1.0` on
one nobody has touched since the first build, so a fleet that is half-updated looks identical to
one that is fully updated, and the only way to tell is to trust whoever did the copying.

That is survivable while the fleet is small and updated in one sitting, and it stops being
survivable the moment a tablet is missed. The browser side does not have this problem — the
service worker updates the fleet on its own within minutes of a deploy (see
[deployment.md](deployment.md#publishing-a-new-build)) — so the two deliveries drift in exactly
the way §10 warns about, with only the APK side unable to report where it stands.

Deliberately left alone rather than wired to a counter: a `versionCode` that changes has to change
*monotonically* and be recorded, or a tablet refuses a genuine update as a downgrade — a worse
failure than the one it fixes, and one that strands a device holding unsynced readings. It wants a
decision about where the number comes from (a counter in the repo, the commit count, the date),
not a quick increment. Whoever takes it should treat it as the sibling of the keystore decision
above.

> Under the **uninstall-and-reinstall** update procedure (§10), the monotonic requirement does not
> apply at all — a fresh install accepts any `versionCode`. What remains is only the inability to
> see which build a tablet holds, which is a `versionName` problem, not a `versionCode` one.

#### Where to change them, and what to put there

Both live in one place — `android/app/build.gradle`, in `defaultConfig`:

```gradle
defaultConfig {
    applicationId "com.hnp.mfdcs"
    …
    versionCode 1        // Android's update/downgrade comparison. Integer, max 2_100_000_000
    versionName "1.0"    // the human-readable string, shown in Settings → Apps
}
```

**`versionName` is the one worth changing first**, because it is what answers *"which build is on
this tablet?"* and it has **no constraints at all** — any string, and Android never compares it.
Changing it is safe under either update procedure. Something that maps a device back to a commit:

```gradle
versionName "1.0.0+dcddad3"     // package.json version + short git sha
```

Read a tablet's value from Settings → Apps → MFDCS, and it identifies the exact source it was
built from. Set by hand at release time, or generated — `scripts/build-apk.mjs` already runs before
Gradle and is the natural place to write an `android/version.properties` for `build.gradle` to
read. Gitignore that file if you generate it, or every build produces a meaningless diff.

**`versionCode` only matters if updates ever happen in place** (the release migration above).
Options, all of which must be monotonic:

| Source | Shape | Watch out for |
|---|---|---|
| `git rev-list --count HEAD` | a low integer, ~`90` today | A rebase or squash of shipped history makes it *decrease* — the update is then refused |
| Date, `yyMMddHH` | `26090118` | Two builds in the same hour collide |
| `Math.floor(Date.now() / 60000) - EPOCH` | ~`350000` | Nothing. Not human-readable, which does not matter — that is `versionName`'s job |

The third is the one to pick if this ever becomes live: `versionCode` is never read by a person,
so its only real requirement is that it cannot go backwards.

### What the build hardens, and what that turns off

`assembleDebug` names the *signing key*, not the audience. This APK runs a whole shift in a plant,
on a shared tablet, holding the only copy of an operator's readings until they sync — so two of
the debug build type's defaults are wrong here and are overridden.

| Setting | Where | Why |
|---|---|---|
| `debuggable false` | `app/build.gradle`, `buildTypes.debug` | The default `true` hands anyone with a USB cable a debugger attached to the session JWT and every reading, photograph and voice note in IndexedDB. No unlock, no password |
| `android:allowBackup="false"` | `AndroidManifest.xml` | The default `true` lets `adb backup` copy all of `/data/data` off the device with no root, and makes the same data eligible for cloud backup on a device with a Google account |

Nothing is lost by either. A restore was never how a tablet is recovered here — the work belongs
on the server, and a rebuilt device is rebuilt by installing the APK and signing in.

**`debuggable` controls three things, not one.** Capacitor reads the same
`ApplicationInfo.FLAG_DEBUGGABLE` (`CapConfig`: `isDebug`) to decide two more, so turning it off
also means:

- `chrome://inspect` can no longer see the WebView
- Capacitor's own logging goes quiet

#### Inspecting a tablet that is misbehaving

When a device genuinely has to be looked at, reach for the WebView inspector — **not** for
`debuggable`. Add an `android` block to `capacitor.config.ts`:

```ts
const config: CapacitorConfig = {
  appId: 'com.hnp.mfdcs',
  appName: 'MFDCS',
  webDir: 'dist',
  android: {
    // TEMPORARY - remove before this build goes near a tablet in service.
    webContentsDebuggingEnabled: true
  }
}
```

Then `npm run build:apk`, install, and the WebView appears in `chrome://inspect` on a machine with
the tablet plugged in — the full DevTools: console, network, and IndexedDB with the operator's
readings in it.

Why this and not `debuggable true`, when both make the app inspectable:

| | `webContentsDebuggingEnabled` | `debuggable true` |
|---|---|---|
| Opens | the WebView inspector | the WebView inspector **and** a JDWP debugger on the process |
| Reaches | what the page can reach | app memory, arbitrary code execution in the app's context |
| Also flips | nothing | Capacitor logging, and every AGP optimisation this build type gets |

The second column is the one that reads the session JWT out of memory. The first is enough to
diagnose a page, and cannot do more than the page itself could.

Two rules hold whichever you use:

1. **Take the build off the tablet again afterwards.** `capacitor.config.ts` is compiled into
   `android/app/src/main/assets/capacitor.config.json` by `cap sync`, so the flag is baked into
   the APK — there is no runtime switch, and an inspectable build left on a tablet in service is
   an inspectable tablet.
2. **Never commit it enabled.** It is one line in a file nothing else changes, and it produces no
   symptom whatsoever on a working device, so nothing will remind you.

#### The side effect that will confuse you at the unzip prompt

A non-debuggable build turns on AGP's **resource path shortening**. Every file under `res/` is
renamed, so the APK you unzip looks like this:

```
res/GT.crt      ← this is res/raw/plant_ca.crt
res/8G.xml      ← this is res/xml/network_security_config.xml
```

Nothing is missing and nothing is broken: `resources.arsc` maps `raw/plant_ca` → `res/GT.crt`, and
the compiled network config still references it by resource id, so `@raw/plant_ca` resolves at
runtime exactly as before. The APK also gets about 0.9 MB smaller, which is the same optimisation.

It is written down because the obvious check — *"is the CA in the APK?"* — now answers **no** if
you grep the file listing for `plant_ca`, and that is the single most alarming wrong answer this
project can give you. Verify it by size or through the resource table instead:

```bash
# By the resource table — the reliable one, and it names the mangled file for you
aapt2 dump resources app-debug.apk | grep -A1 raw/plant_ca

# Or by size, using whatever certs/rootCA.crt currently weighs
unzip -l app-debug.apk | awk -v n="$(stat -c%s certs/rootCA.crt)" '$1==n'
```

---

## 4. What the app talks to

**The app never talks to the backend directly.** It talks to the same nginx the browsers talk to,
over HTTPS, and nginx reverse-proxies to Spring Boot. One address, one certificate, one set of
access rules.

The address comes from `.env.mobile`, the same file `npm run preview:mobile` uses:

```
VITE_SERVER_URL=https://192.168.0.101:4173
```

There is no separate environment file for the APK. There was, briefly, and it was one more place
for the address to go stale — the app and the browser reach the same server, so they read the same
setting.

The web assets themselves are **bundled into the APK**, not fetched. The app opens instantly with
no network, which is the whole point of an offline-first system; only API calls go over the wire.

---

## 5. Certificates: the trap that costs an afternoon

The PWA is served over HTTPS with a certificate this site issued itself (mkcert). Installing that
CA on a tablet makes Chrome trust it. **It does not make the app trust it.**

Since API 24, an Android app trusts only the **system** CA store. A CA installed by hand lands in
the **user** store, which apps ignore unless they opt in. So the app — with the CA visibly
installed on the device, working in Chrome on the same tablet — fails every request with
`CertPathValidatorException`, which reaches the operator as *"ارتباط با سرور برقرار نشد"*: exactly
what a down network looks like.

Two files fix it:

- `android/app/src/main/res/xml/network_security_config.xml` — trusts `system` **and**
  `@raw/plant_ca`, and keeps cleartext off.
- `android/app/src/main/res/raw/plant_ca.crt` — the CA itself, copied from `certs/rootCA.crt` by
  `npm run ca:apk` on every build.

That copy is deliberate, and so is the fact that it is **gitignored**. `certs/` is machine- and
site-specific; a committed copy would be a second one that quietly goes stale, and a rebuilt-CA
mismatch shows up only when somebody tries to log in. Regenerating it on every build means the two
cannot disagree.

**A useful side effect:** bundling the CA removes the per-tablet CA installation step entirely. A
device needs the APK and nothing else.

The certificate is public — it is the CA's certificate, not its key. Bundling it discloses
nothing.

### Bundled CA vs. the CA installed on the tablet

These are **two separate trust stores** that happen to hold the same certificate, and confusing
them is what makes this section necessary. On a tablet that runs both Chrome and the app:

| | Chrome / the PWA | The packaged app |
|---|---|---|
| Trusts | system store **+ user store** | system store **+ `@raw/plant_ca`** |
| Gets the CA from | the one an admin installed in Settings | the copy inside the APK |
| When the CA rotates | install the new one on the device | rebuild and reinstall the APK |

So installing the CA on a tablet is what the **browser** needs, and it has no effect on the app
whatsoever. The app is not reading it and never will, unless the config opts in (below).

**This is a feature, and it is worth keeping.** If the app cannot reach the server on a tablet
where Chrome reaches it happily, that difference tells you the CA inside the APK is stale — it is
the single most useful diagnostic this setup gives you, and `deployment.md` names it as the first
thing to check.

#### Could the app just use the installed CA instead?

Yes. One line in `network_security_config.xml`:

```xml
<certificates src="user" />   <!-- the app now trusts any CA installed on the device -->
```

That is precisely the opt-in the paragraph above refers to. Because the app's requests are
`fetch()` from the **WebView**, this file is the *only* lever — a custom `TrustManager` in Java
would not affect WebView traffic at all, so there is no third option.

**It is deliberately not done**, and the reason is that it buys nothing here:

- The only thing it saves is rebuilding when the CA rotates — and the CA is copied in fresh by
  `ca:apk` on **every** build (§3), while the fleet is updated by rebuild-and-reinstall anyway
  (§10). The rebuild that `src="user"` avoids is one you were already doing.
- A CA outlives everything else here — mkcert issues them for ten years — and the *server*
  certificate, which expires far sooner, needs no APK rebuild at all, because the app trusts the CA
  rather than the leaf. The problem being solved arrives roughly once a decade. Check the real
  dates with the commands in *Two expiry dates* below rather than trusting that sentence.
- In exchange, the app would trust **any** CA installed on the device, permanently. On a shared
  tablet that is physically handled all shift, anyone who reaches Settings can install a CA and
  read the session JWT and every reading in transit.
- And it creates a second source of truth: the app would keep working from the device's CA while
  the one inside the APK quietly went stale — destroying the diagnostic above, and reproducing
  exactly the "second copy that goes stale" failure this section's gitignore rule exists to
  prevent.

If the concern is expiry, the better answer is to issue the CA with a **longer validity** (mkcert
defaults to ten years; `openssl` will give you thirty), since changing it costs one rebuild either
way.

#### If you do decide to switch to the device's CA

Recorded so the decision can be taken properly rather than reconstructed. The trigger would be a
site where the CA rotates often enough that rebuilding is a real burden, **and** where tablets are
physically controlled well enough that the trust widening is acceptable.

Edit `android/app/src/main/res/xml/network_security_config.xml`:

```xml
<network-security-config>
    <base-config cleartextTrafficPermitted="false">
        <trust-anchors>
            <certificates src="system" />
            <certificates src="user" />        <!-- CAs installed on the device -->
            <certificates src="@raw/plant_ca" /> <!-- keep, or drop — see below -->
        </trust-anchors>
    </base-config>
</network-security-config>
```

Then decide the second question, which is the one that actually matters:

| | Keep `@raw/plant_ca` too | Drop it, `user` only |
|---|---|---|
| Tablet with no CA installed | still works | **fails** — every device now needs the CA installed first |
| Bundled CA goes stale | invisible; the device's copy silently covers for it | cannot happen |
| Sources of truth | two, and you cannot tell which is in use | one |

**Dropping it is the more honest of the two.** Keeping both is the configuration that recreates
this section's original failure — a second copy that quietly goes stale — and it removes the
diagnostic that a working Chrome plus a failing app currently gives you.

What else changes if you take this route:

1. **`npm run ca:apk` becomes dead weight.** Remove it from `sync:apk` in `package.json`, delete
   `scripts/bundle-site-ca.mjs`, and drop the `plant_ca.crt` line from `.gitignore` — or it stays
   as a build step producing a file nothing reads.
2. **Every tablet needs the CA installed before the app works**, including replacements and any
   device that is factory reset. `deployment.md § Installing the CA on tablets` stops being
   skippable for app-only tablets, and its note saying otherwise must be corrected.
3. **§5's opening claim — "a device needs the APK and nothing else" — becomes false**, along with
   the same line in the README and in `deployment.md`.
4. **The failure mode moves.** Today a missing CA is caught at build time (`bundle-site-ca.mjs`
   exits non-zero). Afterwards it is caught by an operator, in the plant, as
   «ارتباط با سرور برقرار نشد».

### Bundling a different CA

The source path is hardcoded in `scripts/bundle-site-ca.mjs`: it always reads `certs/rootCA.crt`
and always writes `android/app/src/main/res/raw/plant_ca.crt`. There is no config for it. To
package a different CA (a different site, a re-issued root):

1. Overwrite `certs/rootCA.crt` in place — same filename, new content.
2. Run `npm run ca:apk` (or the full `npm run build:apk`, which runs it as its first step).

Then rebuild and reinstall on every tablet — see §10, *"I regenerated the CA itself."* A device
still running the old APK keeps trusting the old CA and fails to log in.

### Two expiry dates, two very different costs

Both certificates expire, and confusing which one has expired sends you to the wrong fix. Read the
current dates off the files rather than trusting anything written here:

```bash
openssl x509 -in certs/cert.pem   -noout -subject -dates    # the server certificate nginx serves
openssl x509 -in certs/rootCA.crt -noout -subject -dates    # the CA bundled into the APK
```

| Expires | Symptom | Fix | APK rebuild? |
|---|---|---|---|
| **Server certificate** (the leaf) | Every tablet, the same morning: browsers warn and the service worker will not register; the app fails every request with `CertPathValidatorException` → «ارتباط با سرور برقرار نشد» | Re-issue from the **same CA**, update nginx, reload | **No** — the app trusts the CA, not the leaf |
| **The CA itself** | The same symptom, and re-issuing the leaf does not help | Regenerate the CA, rebuild, reinstall on every tablet, and re-install the CA on any tablet using Chrome | **Yes**, and a full fleet sweep |

The leaf is the one that expires first and it is the cheap one. Put **both** dates in a calendar
with months of warning: the failure is fleet-wide, simultaneous, and looks exactly like the network
being down. See [deployment.md § Renewal](deployment.md#renewal).

---

## 6. Icons and splash

Generated from the two SVGs the PWA already uses, by `npm run icons:apk`:

```
public/icons/icon.svg           full-bleed, rounded  → legacy launcher icon, splash logo
public/icons/icon-maskable.svg  inside the safe zone → adaptive icon foreground
```

The maskable variant exists because a PWA icon on Android faces the same problem an adaptive icon
does — the launcher applies its own mask and crops what falls outside — so the same artwork serves
both, and there is nothing extra to keep in step. The brand colour is **read out of** `icon.svg`
rather than written down again.

Two template files are deleted by the script, and that deletion is load-bearing:
`drawable-v24/ic_launcher_foreground.xml` is a vector that wins over the generated PNG on API 24+
— which is every device this app runs on — so leaving it means the icon never changes no matter
what you generate.

Run it after editing either SVG, and after `npx cap add android` ever regenerates the platform.
It is **not** part of the build: the PNGs are committed under `android/`, and the build must not
depend on `sharp` being installable on the machine running it.

---

## 7. NFC

Web NFC (`window.NDEFReader`) is a Chrome API. **Android's WebView does not implement it.** Inside
the packaged app it is simply absent — not denied, not broken, missing — so tag scanning would
disappear from the app with no error anywhere.

`android/app/src/main/java/com/hnp/mfdcs/NfcPlugin.java` puts `NfcAdapter` behind the same door.
`services/nfc` picks a reader; nothing above it changed.

### The contract, which is the part worth understanding

The plugin sends each record as **base64 bytes** with a `recordType` from Web NFC's vocabulary,
and those bytes are **what Web NFC would have handed the page** — not what is physically on the
tag. Web NFC normalises two well-known record types before the page sees them, and the plugin does
the same:

| Record | Raw NDEF | What crosses the bridge |
|---|---|---|
| `text` | status byte, language code, then the text | just the text, UTF-8 |
| `uri` | prefix byte (`0x04` = `https://`), then the rest | the expanded URL |

Everything else passes through untouched.

Those two rules are fixed by the NFC Forum spec and cannot drift. **Everything else** — records
that are mislabelled, media types that lie, which of several records holds the asset id — is
heuristics learned from tags in this plant, and lives once, in TypeScript, in `decodeRecordData`.

Get this wrong in the obvious direction (send the raw payload, let the shared decoder sort it out)
and it fails quietly: the decoder offers itself both the raw bytes and its own header-stripping
attempt, prefers the *longer*, and reads `ASSET-42` as `\u0002enASSET-42` — an id that matches no
asset, with nothing on screen to say why. `src/services/nfc/nativeNfc.test.ts` pins both halves,
including that failure, so a regression on the Java side is legible instead of mysterious.

### Registration

`MainActivity.onCreate` calls `registerPlugin(NfcPlugin.class)` **before** `super.onCreate`.
Capacitor auto-registers plugins that arrive as npm packages; one living in the app's own source is
invisible to that. Registered after `super.onCreate`, the bridge is already built and the registry
frozen — `window.Capacitor.Plugins.Nfc` is undefined, `isNFCSupported()` answers false, and
scanning vanishes silently.

### Reader mode and the lifecycle

The plugin uses `enableReaderMode`, not foreground dispatch: the tag stays inside this activity
instead of being broadcast where another app could take it, or bouncing our own activity through
`onNewIntent` and tearing down the WebView mid-shift.

Android only permits reader mode on a **resumed** activity, so `handleOnPause`/`handleOnResume`
reconcile the hardware to what the page asked for. Without them a scan running when the screen
locks comes back dead — after a call, a notification, or a screen timeout — and looks to the
operator like a tag that will not read.

---

## 8. Camera, microphone and location

These are `getUserMedia` and `navigator.geolocation`, the same calls the browser makes. Capacitor's
`BridgeWebChromeClient` maps each onto the matching Android permission and prompts at the moment of
use.

**But the WebView cannot grant itself anything the app has not declared.** A permission missing
from `AndroidManifest.xml` is refused outright — no prompt, no error the page can see. That is
exactly how camera and microphone came to do nothing at all in the first build: the page asked,
Android declined silently, and the operator saw a dead button.

Declared, with the reason:

| Permission | For |
|---|---|
| `CAMERA` | photographing a reading or a fault, and video evidence |
| `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS` | voice notes, and a video's audio track |
| `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION` | stamping where a reading was taken |
| `NFC` | tag identification (normal permission — granted at install, never prompts) |
| `INTERNET` | reaching nginx |

Every corresponding `<uses-feature>` is `android:required="false"`, and that matters: a hardware
feature used through a permission is *implicitly required* unless said otherwise, and a required
feature keeps the app off every device that lacks it. Some tablets here have no NFC and some have
no rear camera; they must still be able to open a log sheet and type readings in.

---

## 9. Telling the app apart from a browser

`src/services/device/nativeApp.ts` — `isNativeApp()`, `currentPlatform()`, `nativePlugin<T>()`.

It reads the `window.Capacitor` global rather than importing `@capacitor/core`, which keeps that
package out of the web bundle entirely — the only trace of Capacitor in `dist/` is the one
`window.Capacitor` read itself.

What that costs the browser build, measured against the build before the packaged app existed:

| | |
|---|---|
| Byte-identical | every vendor chunk, every font, the stylesheet, every icon, `manifest.webmanifest` |
| Changed | the app chunk, **+~1.5 KiB** (this module and the native NFC reader), and with it `index.html` and `sw.js`, which name that chunk by its content hash |

Nothing a PWA install depends on moves, which is the point. But the app chunk does change, so
**`dist/` still has to be redeployed** — and a diff there is expected, not a regression.

`display-mode: standalone` does **not** answer this question. A Capacitor WebView reports
`display-mode: browser` — no manifest is applied and there is no browser UI to hide — so every
check written for "is this an installed PWA" comes back false inside the app. That is why the
install banner appeared to operators who had installed the APK a minute earlier;
`InstallPwaPrompt` now checks `isNativeApp()` first.

---

## 10. What to rebuild, when

The question this file exists for.

### I changed the web app (a page, a fix, anything under `src/`)

```bash
npm run build:mobile     # → dist/, for nginx
npm run build:apk        # → APK, rebuilds dist/ on the way
```

Put `dist/` where nginx serves it; copy the APK to the tablets. **Both**, or the two go out of
step.

**The two commands do not interfere.** `build:mobile` writes `dist/` and *only* `dist/` — it never
touches `android/`, and the APK on disk is exactly as it was. Copying `dist/` into the Android
project is `npx cap sync android`, which `build:apk` runs and `build:mobile` does not. So a browser
deploy is safe to do on its own, as often as you like.

The consequence is the one worth holding on to: **nothing warns you.** After a `build:mobile` the
browsers are on the new build and the tablets are still on whatever the last `build:apk`
produced — no error, no mismatch check, and both apps working. That is the "out of step" above,
and it is silent by construction. Run `build:apk` too whenever a change is meant to reach the
tablets — it re-runs `build:mobile` on the way, so it is never wasted work, and it is the only one
of the two that updates both.

### Getting a new APK onto the tablets

The current procedure is **uninstall, then install** — chosen deliberately, and it is what makes
the debug signing key (§3) an acceptable arrangement rather than a liability: Android only compares
signatures when updating an *existing* install, so a fresh install accepts any key from any
machine.

The price is that **uninstalling deletes IndexedDB**, and IndexedDB is the app. Everything below
exists because of that one fact:

- log sheets filled but not yet synced
- photographs, voice notes and video still in the upload queue
- `logSheetUserArchives`, which is exempt from every retention rule and is the **only copy in
  existence** of work belonging to an operator whose round was reassigned
- locally-filed NFC fault reports, and every signed-in session

None of it is recoverable, and none of it leaves a trace on the server.

**The procedure:**

1. Bring the tablet **online** and let it sync.
2. **Confirm delivery against the server** — not against the tablet. See the warning below.
3. Uninstall the app.
4. Install the new APK.
5. Each operator signs in again.

> **The device's own "pending" badge cannot answer step 2.** `SyncManager.getPendingCount()` is
> scoped to the **signed-in user** — `isLogSheetOutboundOwnedByUser`, `getOwnPendingAttachments`,
> and an archive query that returns nothing at all without a `userId`. That scoping is correct and
> deliberate (a shared tablet would otherwise show a badge that can never reach zero), but it means
> the badge answers *"does this operator have undelivered work?"*, **never** *"does this tablet?"*
>
> So: operator A works offline, does not sync, signs out. Operator B signs in. **B's badge reads
> zero.** The tablet looks clean, and uninstalling at that moment destroys A's readings for good.
>
> There is no device-wide indicator in the app today. Confirm from the **server**, which knows what
> it actually received and does not depend on the memory of the device you are about to wipe.

Do this while the fleet is small enough to sweep in one sitting. A tablet that is missed keeps the
old build and, with `versionCode`/`versionName` fixed at `1`/`1.0` (§3), looks identical to an
updated one in Settings → Apps.

### The server address changed

Edit **`.env.mobile`** — one file, both targets:

```
VITE_SERVER_URL=https://<new-address>:<port>
```

Then rebuild both as above. Also re-issue the certificate for the new address
(`npm run setup:mkcert -- -Ip <new-ip>`) and reconfigure nginx.

### I regenerated the certificate for the same CA

Nothing to do in the app, and nothing to do on any tablet. It trusts the **CA**, not the leaf
certificate. Update nginx and reload.

### I regenerated the **CA** itself

Both trust stores have to be updated, and they are separate (§5):

```bash
npm run build:apk        # picks up the new certs/rootCA.crt automatically — that is what ca:apk is for
```

- **Every tablet** — reinstall the APK, or it keeps trusting the old CA and fails to log in.
- **Every tablet that also uses Chrome** — install the new CA on the device as well. The APK's copy
  does nothing for the browser, exactly as the device's copy does nothing for the app.

Miss either half and the symptom is the same on both: «ارتباط با سرور برقرار نشد», indistinguishable
from a dead network.

### I changed an icon SVG

```bash
npm run icons        # PWA icons
npm run icons:apk    # Android launcher + splash
npm run build:apk
```

### I changed something native (manifest, plugin, network config)

```bash
npm run build:apk
```

Gradle picks it up. No `cap add`, no regeneration.

### `android/` needs to be recreated from scratch

Rare, and it costs the hand-written files. Save `NfcPlugin.java`, `MainActivity.java`,
`AndroidManifest.xml` and `res/xml/network_security_config.xml` first — or take them back out of
git, which is why they are committed.

```bash
npx cap add android
# restore the four files above, then:
npm run icons:apk
npm run build:apk
```

---

## 11. What is committed and what is not

`android/` **is** committed: it holds the plugin, the manifest, the network configuration and the
generated icons — all of it either hand-written or reproducible only with `sharp`.

Not committed (`android/.gitignore` and the root `.gitignore`):

| | Why |
|---|---|
| `android/app/src/main/assets/public/` | the copied `dist/`; regenerated by every sync |
| `android/app/src/main/assets/capacitor.config.json` | generated |
| `android/**/build/`, `.gradle/` | build output |
| `android/app/src/main/res/raw/plant_ca.crt` | this site's CA — copied in by `ca:apk`, see §5 |
| `*.apk` | build output |

**`android/local.properties` is the exception, and it is committed on purpose.** The Capacitor
template ignores it and most projects should, because it holds a per-machine SDK path. This one is
built at a single site against the SDK location §2.1 prescribes, so committing a working default
means a fresh clone builds instead of failing on a file nobody knew to create — and the file's own
comments explain what to change it to on another machine, which is the part an ignored file cannot
do. A machine that needs a different path keeps the edit local with
`git update-index --skip-worktree android/local.properties`.

If this project ever gains contributors on varied machines, reverse it: re-ignore the file, ship a
`local.properties.example` instead, and say so in §2.1.

`eslint.config.js` ignores `android/**`. Nothing in it is hand-written JavaScript — it is the
minified bundle plus Gradle's output — and linting a minified bundle produces about fifteen hundred
`no-undef`s for `self` and `URL`, which drowns every real finding and turns the gate into noise.

---

## 12. iOS

Not built yet, and the groundwork is deliberate. `nativeApp.ts` reports the platform rather than
answering "is this Android"; `services/nfc` chooses a reader by capability, not by platform;
nothing above the service layer knows a native app exists. Adding iOS means `npx cap add ios`, an
NFC plugin against Core NFC emitting the same record shape as §7, and the equivalent of §5 for
certificate trust — not a second frontend.

This is the reason Capacitor was chosen over a Trusted Web Activity: a TWA is Android-only, and its
Digital Asset Links verification is done by the OS against the **system** trust store, which a
self-signed site certificate cannot satisfy.

---

## 13. Decisions deferred, and where the path to each is written

Four things this project has **chosen not to do**, each for a stated reason rather than by
omission. Each has its route recorded, so taking it later is a decision rather than an
excavation — and so that nobody re-derives one badly under time pressure.

| Deferred | Trigger to revisit | Recipe |
|---|---|---|
| **A signed release build** with a real keystore | Wanting to update a tablet **in place** instead of uninstall-and-reinstall. Nothing else — not security, not the word "debug" | §3, *Migrating to a signed release build* |
| **A moving `versionCode`** | Follows the row above: in-place updates make monotonicity mandatory | §3, *Where to change them* |
| **A meaningful `versionName`** | Any time — it has no constraints and is safe under either procedure. Wanted the first time a tablet is missed on a sweep | §3, *Where to change them* |
| **Trusting the device's CA** (`src="user"`) instead of the bundled one | A site where the CA rotates often enough that rebuilding is a real burden, *and* tablets are controlled well enough for the trust widening | §5, *If you do decide to switch* |
| **iOS** | A fleet that is not all Android | §12 |

Two of these are **one decision wearing two hats**: the signing key and the update procedure (§10)
hold each other up. The debug key is sound *because* nothing updates in place, and nothing needs to
update in place *because* the fleet is small enough to sweep. Change either and both the other two
rows move with it — which is why §3, §10 and the README's APK section have to be rewritten
together, and why `AGENTS.md` lists them as a single entry.

The three that touch trust or identity — keystore, CA, `versionCode` — share one property worth
stating on its own: **each is cheapest to change before the fleet carries real work**, because each
costs an uninstall round on every tablet, and an uninstall round costs unsynced readings once there
are any.

---

## See also

- [`device-features.md`](device-features.md) — NFC, camera, GPS and orientation from the app's side,
  and how each degrades
- [`deployment.md`](deployment.md) — nginx, certificates, and getting the CA onto a tablet
- [`sync.md`](sync.md) — what actually crosses the wire once the app is talking
