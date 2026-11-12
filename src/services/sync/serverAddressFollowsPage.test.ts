import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/services/storage/db'
import { getLogSheet, getSettings, saveLogSheet, saveSettings } from '@/services/storage'
import { syncManager } from '@/services/sync'
import { pullBootstrap } from '@/services/sync/pullBootstrap'
import { apiClient, resolveBaseUrl } from '@/services/api/client'
import { probeServer } from '@/services/api/serverProbe'
import type { AppSettings, LogSheet } from '@/types'

/**
 * Where a real sync pass actually sends the operator's work — end to end, with nothing mocked but
 * the network.
 *
 * <h2>Why this is not covered by the unit tests of the rule</h2>
 *
 * `deliveryServerUrl.test.ts` proves the rule. This proves the rule is the one the traffic
 * obeys: the settings row in IndexedDB, `getSettings()`, the API client's three transports (JSON,
 * multipart upload, blob download), the login page's probe and the sync manager's outbound queue
 * are all real here. Only `fetch` is replaced, so every URL a device would put on the wire is
 * recorded and checked.
 *
 * <h2>The situation it reproduces</h2>
 *
 * One `dist/` was built with `VITE_SERVER_URL=https://abc.com`. The plant's nginx is now reached
 * at `https://cbd.com`, and nobody rebuilt. The browser on `cbd.com` must send everything to
 * `cbd.com` — relative `/api/...` — while the packaged app must keep the address it was given.
 */

const SEED = 'https://abc.com'
const NEW_ORIGIN = 'https://cbd.com'
const SESSION_USER_ID = '7'
const NOW = Date.now()

const originalWindow = (globalThis as { window?: unknown }).window

/** Every URL handed to fetch, in order. */
let requested: string[] = []

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

/** A plant server that answers wherever it is asked — the test is about where it is asked. */
function fakeServer() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    requested.push(url)
    const path = url.replace(/^https?:\/\/[^/]+/, '')
    if (path === '/api/health') return json({ status: 'ok' })
    if (path === '/api/log-sheets/batch') {
      return json([{ localId: 'local-1', outcome: 'SUBMITTED', serverId: 55 }])
    }
    if (path === '/api/bootstrap') {
      return json({
        serverTime: NOW,
        userId: Number(SESSION_USER_ID),
        operationalUnits: [],
        accessibleUnitIds: [],
        supervisorScopeUnitIds: [],
        primaryUnitId: null,
        mobilePolicy: { imageAnnotationEnabled: true, nfcStrictSerialMatch: true }
      })
    }
    if (path === '/api/attachments') return json({ id: 9 })
    if (path.startsWith('/api/attachments/')) {
      return new Response(new Blob(['jpeg']), { status: 200, headers: { 'content-type': 'image/jpeg' } })
    }
    return json({ message: `unexpected ${path}` }, 404)
  })
}

/** A browser tab on `origin`, running the production bundle. */
function browserAt(origin: string): void {
  vi.stubEnv('PROD', true)
  vi.stubEnv('VITE_SERVER_URL', SEED)
  ;(globalThis as { window?: unknown }).window = {
    location: { origin },
    addEventListener: () => {},
    removeEventListener: () => {}
  }
}

/** The packaged app: Capacitor's WebView, whose own origin is its local asset server. */
function packagedApp(): void {
  vi.stubEnv('PROD', true)
  vi.stubEnv('VITE_SERVER_URL', SEED)
  ;(globalThis as { window?: unknown }).window = {
    location: { origin: 'https://localhost' },
    Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
    addEventListener: () => {},
    removeEventListener: () => {}
  }
}

/** A round the operator finished offline: submitted on the device, not yet on the server. */
function finishedRound(): LogSheet {
  return {
    id: 'local-1',
    localId: 'local-1',
    serverId: '55',
    templateId: '3',
    templateName: 'راند روزانه',
    scopeSummary: 'سالن ۱',
    assigneeUserId: SESSION_USER_ID,
    localOwnerUserId: SESSION_USER_ID,
    status: 'submitted',
    syncStatus: 'pending',
    serverStatus: 'IN_PROGRESS',
    dueAt: NOW + 3_600_000,
    completedAt: NOW - 1_000,
    clientActionId: 'action-1',
    entries: [
      {
        assetId: '7',
        assetName: 'پمپ ۱',
        subFunctionCode: 'SF-1',
        subFunctionTag: 'TAG-1',
        classId: '2',
        formData: { temp: 42 },
        createdAt: NOW - 10_000,
        updatedAt: NOW - 5_000
      }
    ],
    createdAt: NOW - 60_000,
    updatedAt: NOW - 1_000
  } as LogSheet
}

async function storedServerUrl(): Promise<string | undefined> {
  const row = (await db.settings.get('app')) as (AppSettings & { key: string }) | undefined
  return row?.serverUrl
}

beforeEach(async () => {
  if (!db.isOpen()) await db.open()
  await db.logSheets.clear()
  await db.settings.clear()
  await db.syncMeta.clear()
  await db.attachments.clear()
  await db.syncMeta.put({ key: 'sessionUserId', value: Number(SESSION_USER_ID) })
  await db.syncMeta.put({
    key: 'authSession',
    value: {
      accessToken: 'token',
      tokenType: 'Bearer',
      expiresAt: NOW + 86_400_000,
      username: 'op',
      fullName: 'اپراتور',
      roles: ['OPERATOR'],
      permissions: []
    }
  })
  requested = []
  vi.stubGlobal('navigator', { onLine: true })
  vi.stubGlobal('fetch', fakeServer())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  ;(globalThis as { window?: unknown }).window = originalWindow
})

describe('a browser on a new domain, with a bundle built for the old one', () => {
  it('delivers a finished round to its own origin — relative /api, never the build address', async () => {
    browserAt(NEW_ORIGIN)
    await saveLogSheet(finishedRound())

    await syncManager.sync()

    expect(requested).toContain('/api/log-sheets/batch')
    expect(requested.every(url => url.startsWith('/api/'))).toBe(true)
    expect((await getLogSheet('local-1'))?.syncStatus).toBe('synced')
  })

  it('ignores a stored address an older build wrote — the device heals without anybody touching it', async () => {
    browserAt(NEW_ORIGIN)
    await saveSettings({ ...(await getSettings()), serverUrl: SEED })
    await saveLogSheet(finishedRound())

    await syncManager.sync()

    expect(requested).toContain('/api/log-sheets/batch')
    expect(requested.some(url => url.includes('abc.com'))).toBe(false)
    expect((await getLogSheet('local-1'))?.syncStatus).toBe('synced')
  })

  it('uploads and downloads attachments on its own origin too', async () => {
    browserAt(NEW_ORIGIN)

    await apiClient.multipart('/api/attachments', new FormData())
    await apiClient.fetchBlob('/api/attachments/9')

    expect(requested).toEqual(['/api/attachments', '/api/attachments/9'])
  })

  it("asks its own origin on the login page's probe", async () => {
    browserAt(NEW_ORIGIN)

    const answered = await probeServer(resolveBaseUrl((await getSettings()).serverUrl))

    expect(answered).toBe(true)
    expect(requested).toEqual(['/api/health'])
  })

  it('writes its own origin into the row when the bootstrap next saves settings', async () => {
    browserAt(NEW_ORIGIN)
    await saveSettings({ ...(await getSettings()), serverUrl: SEED })

    await pullBootstrap()

    expect(requested).toEqual(['/api/bootstrap'])
    expect(await storedServerUrl()).toBe(NEW_ORIGIN)
  })

  it('reports the address it uses, for the login page and Settings to show', async () => {
    browserAt(NEW_ORIGIN)
    expect((await getSettings()).serverUrl).toBe(NEW_ORIGIN)

    // The same bundle, opened by IP on the same nginx: a different origin, its own server.
    browserAt('https://192.168.60.1')
    expect((await getSettings()).serverUrl).toBe('https://192.168.60.1')
  })
})

describe('the packaged app — the same bundle, unchanged behaviour', () => {
  it('a fresh install delivers to the build address', async () => {
    packagedApp()
    await saveLogSheet(finishedRound())

    await syncManager.sync()

    expect(requested).toContain(`${SEED}/api/log-sheets/batch`)
    expect(requested.every(url => url.startsWith(`${SEED}/api/`))).toBe(true)
    expect((await getLogSheet('local-1'))?.syncStatus).toBe('synced')
  })

  it('after an administrator changed the address, delivers there — never to its own origin', async () => {
    packagedApp()
    await saveSettings({ ...(await getSettings()), serverUrl: NEW_ORIGIN })
    await saveLogSheet(finishedRound())

    await syncManager.sync()

    expect(requested).toContain(`${NEW_ORIGIN}/api/log-sheets/batch`)
    expect(requested.every(url => url.startsWith(`${NEW_ORIGIN}/api/`))).toBe(true)
    expect(requested.some(url => url.startsWith('/') || url.includes('localhost'))).toBe(false)
  })

  it('keeps the address an administrator set when the bootstrap saves settings', async () => {
    packagedApp()
    await saveSettings({ ...(await getSettings()), serverUrl: NEW_ORIGIN })

    await pullBootstrap()

    expect(requested).toEqual([`${NEW_ORIGIN}/api/bootstrap`])
    expect(await storedServerUrl()).toBe(NEW_ORIGIN)
  })

  it('uploads and downloads attachments at the configured address', async () => {
    packagedApp()
    await saveSettings({ ...(await getSettings()), serverUrl: NEW_ORIGIN })

    await apiClient.multipart('/api/attachments', new FormData())
    await apiClient.fetchBlob('/api/attachments/9')

    expect(requested).toEqual([`${NEW_ORIGIN}/api/attachments`, `${NEW_ORIGIN}/api/attachments/9`])
  })
})
