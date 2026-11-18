/**
 * Where the server clock (`serverClock.ts`) is kept between runs: one `syncMeta` row.
 *
 * Kept apart from the clock itself so the deadline helpers, which every screen and the database
 * module read, do not import the database. `main.tsx` calls {@link loadServerClock} once, after
 * the database opens and before the first render.
 */

import { db } from '@/services/storage/db'
import { adoptStoredServerClock, setServerClockPersister, type ServerClockState } from './serverClock'

export const SERVER_CLOCK_META_KEY = 'serverClock'

async function write(value: ServerClockState): Promise<void> {
  await db.syncMeta.put({ key: SERVER_CLOCK_META_KEY, value })
}

/** Reads the stored measurement into memory and starts writing new ones back. */
export async function loadServerClock(): Promise<void> {
  setServerClockPersister(write)
  try {
    const row = await db.syncMeta.get(SERVER_CLOCK_META_KEY)
    adoptStoredServerClock(row?.value)
  } catch {
    adoptStoredServerClock(null)
  }
}
