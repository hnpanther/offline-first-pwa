import { describe, it, expect, vi } from 'vitest'
import { applyServerUrlChange, type ServerUrlChangeSteps } from './applyServerUrlChange'

/**
 * The order of these steps is the security property, so the tests assert the order — not just
 * that every step ran. A version that calls all four in the wrong sequence passes any
 * "was it called" check while re-opening exactly the hole this function closes.
 */
function recordingSteps() {
  const calls: string[] = []
  const steps: ServerUrlChangeSteps = {
    stopSync: vi.fn(() => { calls.push('stopSync') }),
    clearSession: vi.fn(async () => { calls.push('clearSession') }),
    save: vi.fn(async () => { calls.push('save') }),
    reload: vi.fn(() => { calls.push('reload') })
  }
  return { calls, steps }
}

describe('applyServerUrlChange', () => {
  describe('when the origin did not change', () => {
    it('saves and nothing else', async () => {
      const { calls, steps } = recordingSteps()

      const reloading = await applyServerUrlChange(false, steps)

      expect(calls).toEqual(['save'])
      expect(reloading).toBe(false)
    })

    it('does not stop sync — an ordinary settings save must not interrupt a round', async () => {
      const { steps } = recordingSteps()

      await applyServerUrlChange(false, steps)

      expect(steps.stopSync).not.toHaveBeenCalled()
      expect(steps.clearSession).not.toHaveBeenCalled()
      expect(steps.reload).not.toHaveBeenCalled()
    })
  })

  describe('when the origin changed', () => {
    it('tears the session down BEFORE writing the new address', async () => {
      const { calls, steps } = recordingSteps()

      await applyServerUrlChange(true, steps)

      expect(calls).toEqual(['stopSync', 'clearSession', 'save', 'reload'])
    })

    it('reports that the page is reloading, so no "saved" tick is shown', async () => {
      const { steps } = recordingSteps()

      await expect(applyServerUrlChange(true, steps)).resolves.toBe(true)
    })

    it('waits for the session to be cleared — not merely to have been started', async () => {
      const { calls, steps } = recordingSteps()
      // A clearSession that resolves on a later microtask would let `save` overtake it if the
      // await were missing. That is the regression: the address reaching storage while a token
      // still exists.
      steps.clearSession = vi.fn(async () => {
        await Promise.resolve()
        await Promise.resolve()
        calls.push('clearSession')
      })

      await applyServerUrlChange(true, steps)

      expect(calls).toEqual(['stopSync', 'clearSession', 'save', 'reload'])
    })

    it('does not reload if the save fails, leaving the operator on a page that can report it', async () => {
      const { calls, steps } = recordingSteps()
      steps.save = vi.fn(async () => { throw new Error('quota exceeded') })

      await expect(applyServerUrlChange(true, steps)).rejects.toThrow('quota exceeded')

      // The session is gone and the address was not written: the safe half of the failure. The
      // operator logs in again to the server they were already using.
      expect(calls).toEqual(['stopSync', 'clearSession'])
      expect(steps.reload).not.toHaveBeenCalled()
    })

    it('does not write the new address if the session could not be cleared', async () => {
      const { calls, steps } = recordingSteps()
      steps.clearSession = vi.fn(async () => { throw new Error('idb closed') })

      await expect(applyServerUrlChange(true, steps)).rejects.toThrow('idb closed')

      expect(calls).toEqual(['stopSync'])
      expect(steps.save).not.toHaveBeenCalled()
    })
  })
})
