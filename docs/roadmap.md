# Roadmap — decisions deferred, with the facts they rest on

> **Nothing in this file is implemented.** Every other document under `docs/` describes the system
> as it is; this one describes work that has been thought through and not done. Keep the
> separation — a reader who cannot tell the two apart will trust a design as if it were behaviour,
> which is exactly the failure the documentation rule in `CLAUDE.md` exists to prevent.
>
> When one of these is built, move the content into the reference document it belongs to
> (`deployment.md`, `apk.md`, `sync.md`) and delete the section here.

Each section records the **facts about the current system** that the decision depends on. Those
facts are the part most worth keeping: a design can be re-argued cheaply, a constraint established
by reading five files and a built APK cannot.

The backend keeps its own, with the same convention:
[`backend-offline-first/docs/roadmap.md`](../../JavaProject/backend-offline-first/docs/roadmap.md).

---

# 1. Hardening what nginx serves

*Raised as: "someone could break into the nginx server and change the files it serves — can the
backend check they are intact?"*

The concern is sound, and unlike §3 it is **tractable**, because here the device is honest and the
server is the problem.

## What is true today

| Fact | Where |
|---|---|
| The nginx config sets **no security headers at all** — every `add_header` in the documented config is `Cache-Control` | [deployment.md § The whole `nginx.conf`](deployment.md) |
| `dist/index.html` carries **no `integrity` attributes** — Vite does not emit SRI by default | verified against a real build |
| The service worker is `registerType: 'autoUpdate'` with `skipWaiting: true` and `clientsClaim: true` | `vite.config.ts` |
| Therefore a deploy reaches the whole browser fleet **within minutes, with no user action** | [deployment.md § Publishing a new build](deployment.md#publishing-a-new-build) |
| The APK **bundles** its web assets and fetches none of them | [apk.md §4](apk.md) |
| The API client sends a bearer token explicitly; CORS runs with `allowCredentials: false` | `services/api/client.ts`, backend `CorsConfig` |

## The amplification worth stating plainly

The same mechanism that makes deployment painless makes a compromise automatic: **modify
`dist/` on nginx and every browser-based tablet is running that code within minutes**, with no
prompt and nothing for an operator to notice. `deployment.md` already names this as the reason to
check one tablet before walking away; it is also the reason this section exists.

**It does not reach the APK.** Packaged assets are not fetched, so a compromised nginx can alter
what the browsers run and not what the app runs. That asymmetry is worth holding on to when
choosing which delivery a given tablet gets.

## Why the client cannot be the one to check

A page that has already loaded possibly-tampered JavaScript cannot be trusted to report on it —
tampered code answers "intact". **Any integrity check has to run somewhere the attacker has not
already reached**: on the nginx host, on the backend, or from a third machine.

## The options, cheapest first

1. **Security headers, starting with CSP.** A `connect-src` restricted to the app's own origin
   stops an injected script exfiltrating readings to a second destination — the browser refuses
   the request. It does nothing against a rooted device (§3), which controls the browser itself,
   but it is the cheapest real control here and today there is none.
   Add `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY` in the same pass.
   **HSTS deliberately excluded**: with a private CA and IP-based URLs it buys little and can
   strand a site that has to fall back, so it needs its own decision rather than riding along.
2. **File integrity monitoring on the nginx host.** Hash the `dist/` tree at build time, store the
   manifest, re-hash on a timer on the host and alert on drift. This is the honest version of
   "can the backend check the files are intact" — the backend can *hold* the expected hashes;
   something outside the browser has to *do* the comparison.
3. **A read-only web root**, with the deploy identity separate from the nginx runtime identity.
   Removes the easiest path from "a process was compromised" to "the served files changed".
4. **Subresource Integrity on the build output.** Makes a modified JS chunk fail to execute. Narrow
   but real: an attacker who can also rewrite `index.html` simply rewrites the hashes, so this
   shrinks the attack surface to `index.html` and `sw.js` rather than closing it.

## What would make it urgent

Any of: the nginx host becoming reachable from a wider network than the plant floor; the web root
becoming writable by a process that also handles untrusted input; or the fleet growing past the
point where "check one tablet after deploying" is a real check rather than a habit.

---

# 2. Noticing a session that is behaving oddly

*The detection half of §3 — and the only part of that problem with a cheap answer.*

## What is true today

| Fact | Where |
|---|---|
| `api_sessions` already records `ip_address`, `user_agent`, `device_label` and `last_seen_at` per session | backend `ApiSession` |
| JWTs are **stateful**: the `jti` must match a live row **belonging to the `uid` in the token** | backend [security.md §8](../../JavaProject/backend-offline-first/docs/security.md) |
| The token carries **no roles or permissions** — authorities are read from the database on every request | same |
| **One device per user**; a new login supersedes the previous session, with the reason recorded | same |
| Deactivating or deleting a user closes live sessions immediately | same |
| `api_key_usage` logs one row per request on the **integration** chain, including refusals | same |

## What is missing

Nothing *records* less than it should — the columns above are populated. What does not exist is
anything that **reads them and complains**: one user seen from two addresses, a session whose IP
changes mid-shift, a `last_seen_at` pattern that does not look like a person walking a round.

This is worth separating from §1 and §3 because it is the only one of the three that needs no new
trust machinery, no device support and no change to how the app is delivered — only a query and
somewhere to send the result.

## Where it would go

The backend, beside the existing session registry — not here. Recorded in this file because it is
the mitigation the PWA and APK threat discussion lands on, and because the facts above were
established while answering that question.

---

# 3. Proving a tablet is running the real app

*Raised as: "someone could root a tablet, change the app so data is also sent somewhere else —
can the device prove it has the version that matches the server?"*

**Recorded largely so that it is not re-attempted.** The direct form of this request cannot be
satisfied, and the reason is structural rather than a gap in this codebase.

## Why the client cannot answer it

A device under an attacker's control cannot attest to its own integrity: whatever check the app
performs, the attacker patches out or feeds a false answer to. Verification has to rest on
something the device's operator does not control, which means hardware.

| Mechanism | Viability here |
|---|---|
| **Play Integrity API** | **Unavailable.** It verifies against Google's servers at call time, and these tablets have no route off the plant network |
| **Hardware key attestation** (Android Keystore) | **Technically possible offline** — the certificate chain validates locally against a bundled Google root, and the attestation record carries `verifiedBootState` and `deviceLocked`, which a rooted device fails |

## Why even the viable one is not obviously worth it

- It covers the **APK only**. The browser-delivered PWA has no equivalent, so a mixed fleet is only
  half covered.
- Attestation quality on low-cost industrial tablets is uneven, and some ship with an unlocked
  bootloader, which fails the check from day one for reasons that have nothing to do with an
  attacker.
- It is a native plugin plus server-side chain validation — a large piece of work against a threat
  whose blast radius is already bounded (below).

## What bounds the damage today, and is the actual defence

| Fact | Where |
|---|---|
| There is **no full master-data pull** — a device holds only the bundles for its own sheets | [sync.md](sync.md), `AGENTS.md` |
| Scope is enforced **server-side** from the database, never from a claim in the token | backend [security.md](../../JavaProject/backend-offline-first/docs/security.md) |
| Outbound sync carries **only the signed-in operator's own work**, on every queue | `AGENTS.md` § Critical invariants |
| A forged token cannot grant authority, impersonate another user, or outlive its session row | backend [security.md §8](../../JavaProject/backend-offline-first/docs/security.md) |

So the reachable loss from one rooted tablet is **that operator's own scope** — which is what the
architecture was built to guarantee, and it holds.

## Where this belongs instead

With device management, not application code: MDM and kiosk mode, a locked bootloader, OEM
unlocking disabled. Those are the controls that make rooting hard; an app cannot make it
detectable from the inside.

Two refinements that *would* add a property, and what each is actually worth:

- **Token binding** (a key in the device's hardware keystore, each request signed with it) closes
  **token theft** — an exfiltrated JWT is useless on another device. It does **not** close a rooted
  device, which can ask its own keystore to sign. Worth knowing the distinction before anybody
  buys the work expecting more.
- **§2's anomaly detection**, which is cheaper than either and is the part that would actually
  surface an incident.

## One idea that was considered and does not work

*"nginx issues an id when it serves the app, tells the backend that id is authorised, and rotates
it periodically."*

Four reasons it adds no security property:

1. **It binds to nothing.** Whatever nginx hands the page, the page's JavaScript can read — and so
   can anyone who controls the device (§3) or nginx (§1). It is a bearer token with exactly the
   properties the JWT already has.
2. **The APK never receives a served page at all** — its assets are bundled, and nginx only
   proxies its API calls. There is nothing for the mechanism to attach to.
3. **It breaks offline-first.** A credential that rotates on a timer expires mid-shift on a tablet
   that is deliberately out of contact for hours, and the queued readings then cannot be delivered.
   That contradicts the first invariant in `CLAUDE.md`.
4. **It duplicates `api_sessions`**, which already does stateful sessions with revocation, expiry
   and per-session IP and user-agent recording.

The existing JWT *is* "an id the backend recognises, which expires and can be revoked". A second
issuer in front of it adds moving parts without adding an answer.
