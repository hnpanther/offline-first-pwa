# Read this first

React + TypeScript + Vite offline-first PWA for industrial field data collection. Persian (RTL),
MUI, Dexie/IndexedDB. Its backend lives at
`D:\LocalStorage\Project\JavaProject\backend-offline-first`.

The operators using this app are standing in a plant, often with **no network**, holding a
tablet against a pipe. Every design decision here follows from that.

## Before you change anything

Read, in this order:

1. **[AGENTS.md](AGENTS.md)** — the conventions of this codebase and the traps found the hard
   way. Several are not guessable: an attachment field's value is an object and therefore truthy
   even when empty; the sync interval is stored in ms and displayed in seconds and must be
   converted on exactly one side; NFC scan failures are deliberately opaque.
2. **[README.md](README.md)** — what the app does, how to run it, how to test it on a phone,
   and how to deploy it.
3. **[docs/](docs/)** — the deep references:

| File | When you need it |
|---|---|
| [docs/sync.md](docs/sync.md) | How data moves to and from the server, in what order, and what each failure means. **The most delicate code in the app.** |
| [docs/storage.md](docs/storage.md) | The Dexie schema, every store, and the rules for changing it |
| [docs/device-features.md](docs/device-features.md) | NFC, camera, GPS, screen orientation — support and fallbacks |

## The rule that keeps this useful

**Any change to sync, storage, a device feature or a user-visible behaviour must update the
matching document in the same commit.** Not afterwards, not in a follow-up.

Documentation that lags the code is worse than none: it is confidently wrong, and the next
person — or the next agent — will trust it.

| You change | Also update |
|---|---|
| The Dexie schema or a store | [docs/storage.md](docs/storage.md) |
| Sync order, an outcome, or the attachment queue | [docs/sync.md](docs/sync.md) |
| NFC, camera, GPS or orientation | [docs/device-features.md](docs/device-features.md) |
| A trap you only found by debugging | **[AGENTS.md](AGENTS.md)** — add an entry with the *why* |
| A user-visible feature or setting | [README.md](README.md) |
| Anything touching the API contract | the backend's `README.md`, `AGENTS.md` and `docs/` too |

## Non-negotiables

- **Never discard local work.** A reading taken in the field exists whether or not the server
  has accepted it. A refused submission is kept, surfaced and recoverable — never dropped.
- **Never edit an applied Dexie `version(n)` block.** Add a new one with the full store list.
  Rewriting a shipped version makes a device's database un-openable.
- **Assume no network.** Code that requires a `serverId` to exist will break on exactly the path
  this app is built for.
- **All UI text is Persian and lives in `src/i18n/fa.ts`.** No hardcoded strings in components.

## Verifying

```bash
npm run test && npx tsc --noEmit && npm run build
```

A device feature cannot be proven in a unit test. NFC, camera and orientation need a real
Android device, and the orientation lock needs the app **installed**, not a browser tab.
