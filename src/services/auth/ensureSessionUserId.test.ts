import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * `ensureSessionUserId` is the repair for a bug whose whole danger was silence: login
 * succeeded, `sessionUserId` stayed null, and from then on outbound sync pushed nothing while
 * the first inbox merge could overwrite the operator's typed values — with no error anywhere.
 *
 * These tests pin the three properties that make the repair safe: it never invents an
 * identity, it never runs the destructive isolation without one, and it heals silently the
 * moment the server answers.
 */

const syncMetaStore = new Map<string, unknown>()

const fetchBootstrap = vi.fn()
const getAllLogSheets = vi.fn(async () => [] as unknown[])
const updateLogSheet = vi.fn(async () => {})
const archiveLogSheetForUser = vi.fn(async () => {})
const clearInboxSnapshot = vi.fn(async () => {})
const getArchivedLogSheetsForUser = vi.fn(async () => [] as unknown[])
const removeArchivedLogSheet = vi.fn(async () => {})

const setSessionUserId = vi.fn()
const setSessionBindingPending = vi.fn()
let storeState: Record<string, unknown> = {}

vi.mock('@/services/storage/db', () => ({
  db: {
    syncMeta: {
      get: async (key: string) =>
        syncMetaStore.has(key) ? { key, value: syncMetaStore.get(key) } : undefined,
      put: async (row: { key: string; value: unknown }) => {
        syncMetaStore.set(row.key, row.value)
      }
    }
  }
}))

vi.mock('@/services/storage', () => ({
  getAllLogSheets: (...args: unknown[]) => getAllLogSheets(...(args as [])),
  updateLogSheet: (...args: unknown[]) => updateLogSheet(...(args as []))
}))

vi.mock('@/services/storage/logSheetArchive', () => ({
  archiveLogSheetForUser: (...args: unknown[]) => archiveLogSheetForUser(...(args as [])),
  archivedLogSheetViewId: (serverId: string, userId: string) => `arch:${serverId}:${userId}`,
  getArchivedLogSheetsForUser: (...args: unknown[]) => getArchivedLogSheetsForUser(...(args as [])),
  removeArchivedLogSheet: (...args: unknown[]) => removeArchivedLogSheet(...(args as []))
}))

vi.mock('@/services/storage/inboxCache', () => ({
  clearInboxSnapshot: (...args: unknown[]) => clearInboxSnapshot(...(args as []))
}))

vi.mock('@/services/api', () => ({
  fetchBootstrap: (...args: unknown[]) => fetchBootstrap(...(args as []))
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      ...storeState,
      setSessionUserId,
      setSessionBindingPending
    })
  }
}))

const { ensureSessionUserId } = await import('@/services/auth/sessionContext')

beforeEach(() => {
  syncMetaStore.clear()
  vi.clearAllMocks()
  storeState = { authSession: { username: 'op1' }, sessionUserId: null }
})

describe('when the id is already on disk', () => {
  it('returns it without calling the server', async () => {
    syncMetaStore.set('sessionUserId', 7)

    const id = await ensureSessionUserId()

    expect(id).toBe('7')
    expect(fetchBootstrap).not.toHaveBeenCalled()
    expect(setSessionUserId).toHaveBeenCalledWith('7')
    expect(setSessionBindingPending).toHaveBeenCalledWith(false)
  })

  it('is cheap enough to call on every sync tick', async () => {
    syncMetaStore.set('sessionUserId', 7)

    await ensureSessionUserId()
    await ensureSessionUserId()
    await ensureSessionUserId()

    expect(fetchBootstrap).not.toHaveBeenCalled()
  })
})

describe('when the id is missing', () => {
  it('binds from bootstrap and persists it', async () => {
    fetchBootstrap.mockResolvedValue({ userId: 42 })

    const id = await ensureSessionUserId()

    expect(id).toBe('42')
    expect(syncMetaStore.get('sessionUserId')).toBe(42)
    expect(setSessionUserId).toHaveBeenCalledWith('42')
    expect(setSessionBindingPending).toHaveBeenLastCalledWith(false)
  })

  it('stays unbound and flags the session when the server is unreachable', async () => {
    fetchBootstrap.mockRejectedValue(new Error('offline'))

    const id = await ensureSessionUserId()

    expect(id).toBeNull()
    expect(syncMetaStore.has('sessionUserId')).toBe(false)
    expect(setSessionBindingPending).toHaveBeenCalledWith(true)
    expect(setSessionUserId).not.toHaveBeenCalled()
  })

  it('treats a bootstrap response with no user id as a failure, not as success', async () => {
    // A malformed or partial response must never be turned into a bound session — an
    // invented identity is worse than no identity.
    fetchBootstrap.mockResolvedValue({ userId: null })

    const id = await ensureSessionUserId()

    expect(id).toBeNull()
    expect(syncMetaStore.has('sessionUserId')).toBe(false)
    expect(setSessionBindingPending).toHaveBeenCalledWith(true)
  })

  it('retries on the next call rather than latching the failure', async () => {
    fetchBootstrap.mockRejectedValueOnce(new Error('offline'))
    expect(await ensureSessionUserId()).toBeNull()

    fetchBootstrap.mockResolvedValueOnce({ userId: 9 })
    expect(await ensureSessionUserId()).toBe('9')
    expect(syncMetaStore.get('sessionUserId')).toBe(9)
  })
})

describe('the deferred isolation', () => {
  it('never runs while the identity is unknown', async () => {
    // This is the destructive step: with a null id every owned sheet looks like somebody
    // else's, so running it unbound would archive the whole device's work.
    fetchBootstrap.mockRejectedValue(new Error('offline'))

    await ensureSessionUserId()

    expect(getAllLogSheets).not.toHaveBeenCalled()
    expect(archiveLogSheetForUser).not.toHaveBeenCalled()
    expect(updateLogSheet).not.toHaveBeenCalled()
  })

  it('runs once the identity is known and matches the signed-in user', async () => {
    syncMetaStore.set('lastSessionUsername', 'op1')
    fetchBootstrap.mockResolvedValue({ userId: 42 })

    await ensureSessionUserId()

    expect(getAllLogSheets).toHaveBeenCalled()
  })

  it('does not run when the stored username belongs to a different person', async () => {
    // Binding an id for op1 says nothing about work op2 left behind; isolation is the login
    // path's job, driven by activateUserSession's own username comparison.
    syncMetaStore.set('lastSessionUsername', 'op2')
    fetchBootstrap.mockResolvedValue({ userId: 42 })

    await ensureSessionUserId()

    expect(getAllLogSheets).not.toHaveBeenCalled()
  })
})
