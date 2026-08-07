import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db, DEFAULT_SETTINGS } from '@/services/storage/db'
import { getSettings, saveSettings } from '@/services/storage'
import { pullBootstrap, pullBootstrapIfStale } from '@/services/sync/pullBootstrap'

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

  it('keeps every other device setting untouched', async () => {
    // The device owns serverUrl and the NFC policies; the server owns the ceilings. A refresh
    // of one must not clobber the other, or a sync would silently reset the tablet's config.
    await saveSettings({
      ...DEFAULT_SETTINGS,
      serverUrl: 'https://plant.example',
      allowManualEntry: true,
      nfcStrictSerialMatch: true
    })
    fetchBootstrap.mockResolvedValue(bootstrapPayload({ attachmentLimits: LIMITS }))

    await pullBootstrap()

    const settings = await getSettings()
    expect(settings.serverUrl).toBe('https://plant.example')
    expect(settings.allowManualEntry).toBe(true)
    expect(settings.nfcStrictSerialMatch).toBe(true)
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
