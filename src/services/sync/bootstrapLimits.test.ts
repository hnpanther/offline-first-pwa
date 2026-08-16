import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db, DEFAULT_SETTINGS } from '@/services/storage/db'
import { getSettings, saveSettings } from '@/services/storage'
import { pullBootstrap, pullBootstrapIfStale } from '@/services/sync/pullBootstrap'
import { useAppStore } from '@/store'

const fetchBootstrap = vi.fn()
vi.mock('@/services/api', () => ({
  fetchBootstrap: (...args: unknown[]) => fetchBootstrap(...args)
}))

/**
 * Attachment ceilings are owned by the server and mirrored onto the device.
 *
 * The whole point is that an administrator edits them once in the web panel and every tablet
 * follows on its next reconnect, with nobody touching the device. These tests pin down the two
 * halves of that: the refresh actually happens, and it never fires backwards — a device must
 * not push its stale copy anywhere, and a server that says nothing must not wipe what is there.
 */

const LIMITS = {
  maxImagesPerField: 5,
  maxAudiosPerField: 2,
  maxVideosPerField: 1,
  maxAudioSeconds: 60,
  maxVideoSeconds: 45
}

function bootstrapPayload(overrides: Record<string, unknown> = {}) {
  return {
    serverTime: 1_700_000_000_000,
    userId: 7,
    operationalUnits: [],
    accessibleUnitIds: [],
    supervisorScopeUnitIds: [],
    primaryUnitId: null,
    ...overrides
  }
}

beforeEach(async () => {
  if (!db.isOpen()) await db.open()
  await db.settings.clear()
  await db.syncMeta.clear()
  await db.operationalUnits.clear()
  fetchBootstrap.mockReset()
})

describe('attachment limits over bootstrap', () => {
  it('starts from the shipped defaults before any sync', async () => {
    expect((await getSettings()).attachmentLimits).toEqual(DEFAULT_SETTINGS.attachmentLimits)
  })

  it('adopts the server ceilings on a successful pull', async () => {
    fetchBootstrap.mockResolvedValue(bootstrapPayload({ attachmentLimits: LIMITS }))

    const result = await pullBootstrap()

    expect(result.success).toBe(true)
    expect((await getSettings()).attachmentLimits).toEqual(LIMITS)
  })

  it('keeps the settings the device does own untouched', async () => {
    // serverUrl and the sync interval are the tablet's own; the ceilings and policies are the
    // server's. A refresh of one must not clobber the other, or a sync would silently reset
    // the connection settings somebody configured on that device.
    await saveSettings({
      ...DEFAULT_SETTINGS,
      serverUrl: 'https://plant.example',
      syncIntervalMs: 45_000,
      screenOrientation: 'landscape'
    })
    fetchBootstrap.mockResolvedValue(bootstrapPayload({ attachmentLimits: LIMITS }))

    await pullBootstrap()

    const settings = await getSettings()
    expect(settings.serverUrl).toBe('https://plant.example')
    expect(settings.syncIntervalMs).toBe(45_000)
    expect(settings.screenOrientation).toBe('landscape')
    expect(settings.attachmentLimits).toEqual(LIMITS)
  })

  it('leaves the stored ceilings alone when the server does not send any', async () => {
    // An older server, or a payload trimmed by a proxy. Falling back to defaults here would
    // silently widen limits an administrator had tightened.
    await saveSettings({ ...DEFAULT_SETTINGS, attachmentLimits: LIMITS })
    fetchBootstrap.mockResolvedValue(bootstrapPayload())

    await pullBootstrap()

    expect((await getSettings()).attachmentLimits).toEqual(LIMITS)
  })

  it('leaves the stored ceilings alone when the pull fails', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, attachmentLimits: LIMITS })
    fetchBootstrap.mockRejectedValue(new Error('offline'))

    const result = await pullBootstrap()

    expect(result.success).toBe(false)
    // Offline capture has to keep working against the last known rules.
    expect((await getSettings()).attachmentLimits).toEqual(LIMITS)
  })

  it('respects the staleness throttle for an ongoing session', async () => {
    // Bootstrap is throttled to once an hour so a running app does not re-pull constantly.
    // The consequence — an admin's change can lag by up to that hour — is real and documented;
    // the sign-in path below is what makes it immediate when it matters.
    await saveSettings({ ...DEFAULT_SETTINGS, attachmentLimits: LIMITS })
    await db.syncMeta.put({ key: 'lastBootstrapAt', value: Date.now() })
    fetchBootstrap.mockResolvedValue(
      bootstrapPayload({ attachmentLimits: { ...LIMITS, maxImagesPerField: 9 } })
    )

    await pullBootstrapIfStale(60 * 60 * 1000)

    expect(fetchBootstrap).not.toHaveBeenCalled()
    expect((await getSettings()).attachmentLimits.maxImagesPerField).toBe(5)
  })

  it('ignores the throttle when asked for a forced pull', async () => {
    // What a fresh sign-in does: a device starting a new session must start from the current
    // rules, and "log out and back in" is the one instruction support can reliably give.
    await saveSettings({ ...DEFAULT_SETTINGS, attachmentLimits: LIMITS })
    await db.syncMeta.put({ key: 'lastBootstrapAt', value: Date.now() })
    const tightened = { ...LIMITS, maxImagesPerField: 1 }
    fetchBootstrap.mockResolvedValue(bootstrapPayload({ attachmentLimits: tightened }))

    await pullBootstrapIfStale(0)

    expect(fetchBootstrap).toHaveBeenCalledOnce()
    expect((await getSettings()).attachmentLimits).toEqual(tightened)
  })

  it('applies a tightened ceiling, not just a loosened one', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, attachmentLimits: LIMITS })
    const tightened = { ...LIMITS, maxImagesPerField: 1, maxVideoSeconds: 20 }
    fetchBootstrap.mockResolvedValue(bootstrapPayload({ attachmentLimits: tightened }))

    await pullBootstrap()

    expect((await getSettings()).attachmentLimits).toEqual(tightened)
  })
})

/**
 * Rules the device follows but does not own: the scan policy (a deployment property, editable
 * nowhere in the UI) and the annotate-before-save switch (admin-editable in the web panel).
 *
 * They travel on bootstrap for the same reason the ceilings do — it is the one call every
 * reconnect already makes — and they are held to the same two rules: a change must actually
 * reach the device, and a server that says nothing must never reset one.
 */
describe('mobile policy over bootstrap', () => {
  const POLICY = { imageAnnotationEnabled: false, nfcStrictSerialMatch: false }

  it('ships with the strict rule and annotation on, before any sync', async () => {
    const settings = await getSettings()
    expect(settings.nfcStrictSerialMatch).toBe(true)
    expect(settings.imageAnnotationEnabled).toBe(true)
  })

  it('adopts the server policy on a successful pull', async () => {
    fetchBootstrap.mockResolvedValue(bootstrapPayload({ mobilePolicy: POLICY }))

    await pullBootstrap()

    const settings = await getSettings()
    expect(settings.nfcStrictSerialMatch).toBe(false)
    expect(settings.imageAnnotationEnabled).toBe(false)
  })

  it('applies the policy even when the payload carries no ceilings', async () => {
    // The two blocks are independent; gating the policy write on attachmentLimits being
    // present would make it depend on an unrelated part of the response.
    fetchBootstrap.mockResolvedValue(
      bootstrapPayload({ mobilePolicy: { imageAnnotationEnabled: false, nfcStrictSerialMatch: true } })
    )

    await pullBootstrap()

    expect((await getSettings()).imageAnnotationEnabled).toBe(false)
  })

  it('applies both blocks in the same pull without either overwriting the other', async () => {
    // Two read-modify-write passes over the settings row would race, and the second would win
    // with its own stale copy — losing whichever block was written first.
    fetchBootstrap.mockResolvedValue(
      bootstrapPayload({ attachmentLimits: LIMITS, mobilePolicy: POLICY })
    )

    await pullBootstrap()

    const settings = await getSettings()
    expect(settings.attachmentLimits).toEqual(LIMITS)
    expect(settings.imageAnnotationEnabled).toBe(false)
    expect(settings.nfcStrictSerialMatch).toBe(false)
  })

  it('leaves the stored policy alone when the server sends none', async () => {
    // An older server. Falling back to defaults here would silently re-enable a step an
    // administrator had switched off — and, worse, could hand a device a scan rule nobody chose.
    await saveSettings({ ...DEFAULT_SETTINGS, ...POLICY })
    fetchBootstrap.mockResolvedValue(bootstrapPayload({ attachmentLimits: LIMITS }))

    await pullBootstrap()

    const settings = await getSettings()
    expect(settings.nfcStrictSerialMatch).toBe(false)
    expect(settings.imageAnnotationEnabled).toBe(false)
  })

  it('leaves the stored policy alone when the pull fails', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, ...POLICY })
    fetchBootstrap.mockRejectedValue(new Error('offline'))

    await pullBootstrap()

    const settings = await getSettings()
    expect(settings.nfcStrictSerialMatch).toBe(false)
    expect(settings.imageAnnotationEnabled).toBe(false)
  })

  it('re-tightens the scan rule when the server turns it back on', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, nfcStrictSerialMatch: false })
    fetchBootstrap.mockResolvedValue(
      bootstrapPayload({ mobilePolicy: { imageAnnotationEnabled: true, nfcStrictSerialMatch: true } })
    )

    await pullBootstrap()

    expect((await getSettings()).nfcStrictSerialMatch).toBe(true)
  })
})

/**
 * Writing the refreshed values into the **store**, not only into IndexedDB.
 *
 * `useSettings` reads the settings row once per app lifetime and caches it in the store;
 * nothing re-reads it afterwards, and signing out and back in does not reload the page. So a
 * bootstrap that only wrote IndexedDB left every store consumer on the value that happened to
 * be there when the tab was opened — the Settings screen reported a policy the device was not
 * running under, and the fill page kept scanning under the previous `nfcStrictSerialMatch`.
 *
 * Reported from the field as "I disabled photo annotation in the panel, signed out and back
 * in, and the app still shows it enabled".
 */
describe('the store follows the server, not just IndexedDB', () => {
  beforeEach(() => {
    useAppStore.getState().setSettings({ ...DEFAULT_SETTINGS })
  })

  it('publishes a refreshed policy to the store so open screens stop showing the old one', async () => {
    fetchBootstrap.mockResolvedValue(
      bootstrapPayload({
        mobilePolicy: { imageAnnotationEnabled: false, nfcStrictSerialMatch: false }
      })
    )

    await pullBootstrap()

    const inStore = useAppStore.getState().settings
    expect(inStore.imageAnnotationEnabled).toBe(false)
    expect(inStore.nfcStrictSerialMatch).toBe(false)
    // …and the two never disagree, which is the actual invariant.
    expect(inStore).toEqual(await getSettings())
  })

  it('publishes refreshed ceilings too', async () => {
    fetchBootstrap.mockResolvedValue(bootstrapPayload({ attachmentLimits: LIMITS }))

    await pullBootstrap()

    expect(useAppStore.getState().settings.attachmentLimits).toEqual(LIMITS)
  })

  it('leaves the device-owned settings in the store untouched', async () => {
    // The store carries the tablet's own configuration as well; a policy refresh must not
    // reset the server URL somebody typed on that device.
    await saveSettings({ ...DEFAULT_SETTINGS, serverUrl: 'https://plant.example' })
    useAppStore.getState().setSettings({ ...DEFAULT_SETTINGS, serverUrl: 'https://plant.example' })
    fetchBootstrap.mockResolvedValue(
      bootstrapPayload({ mobilePolicy: { imageAnnotationEnabled: false, nfcStrictSerialMatch: true } })
    )

    await pullBootstrap()

    expect(useAppStore.getState().settings.serverUrl).toBe('https://plant.example')
  })

  it('does not touch the store when the server sends no policy and no ceilings', async () => {
    useAppStore.getState().setSettings({ ...DEFAULT_SETTINGS, imageAnnotationEnabled: false })
    fetchBootstrap.mockResolvedValue(bootstrapPayload())

    await pullBootstrap()

    expect(useAppStore.getState().settings.imageAnnotationEnabled).toBe(false)
  })
})
