import { describe, it, expect, vi } from 'vitest'
import { applyServerUrlChange, type ServerUrlChangeSteps } from './applyServerUrlChange'

/**
 * The order of these steps is the security property, so the tests assert the order — not just
 * that every step ran. A version that calls all of them in the wrong sequence passes any
 * "was it called" check while re-opening exactly the hole this function closes.
 *
 * <p>The first step, `verify`, is the data-safety half: a new address that does not answer must
 * leave the device exactly as it was, because once it is saved and the session is gone nobody
 * can log in on that device to change it back.
 */
function recordingSteps(answers = true) {
  const calls: string[] = []
  const steps: ServerUrlChangeSteps = {
    verify: vi.fn(async () => { calls.push('verify'); return answers }),
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

      const outcome = await applyServerUrlChange(false, steps)

      expect(calls).toEqual(['save'])
      expect(outcome).toBe('saved')
    })

    it('does not stop sync — an ordinary settings save must not interrupt a round', async () => {
      const { steps } = recordingSteps()

      await applyServerUrlChange(false, steps)

      expect(steps.stopSync).not.toHaveBeenCalled()
      expect(steps.clearSession).not.toHaveBeenCalled()
      expect(steps.reload).not.toHaveBeenCalled()
    })

    it('does not ask the server anything — the address it uses is the one it already had', async () => {
      // Otherwise saving the sync interval offline would be refused for no reason at all.
      const { steps } = recordingSteps(false)

      await expect(applyServerUrlChange(false, steps)).resolves.toBe('saved')

      expect(steps.verify).not.toHaveBeenCalled()
      expect(steps.save).toHaveBeenCalled()
    })
  })

  describe('when the origin changed', () => {
    it('asks the new address first, then tears the session down BEFORE writing it', async () => {
      const { calls, steps } = recordingSteps()

      await applyServerUrlChange(true, steps)

      expect(calls).toEqual(['verify', 'stopSync', 'clearSession', 'save', 'reload'])
    })

    it('reports that the page is reloading, so no "saved" tick is shown', async () => {
      const { steps } = recordingSteps()

      await expect(applyServerUrlChange(true, steps)).resolves.toBe('reloading')
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

      expect(calls).toEqual(['verify', 'stopSync', 'clearSession', 'save', 'reload'])
    })

    it('does not reload if the save fails, leaving the operator on a page that can report it', async () => {
      const { calls, steps } = recordingSteps()
      steps.save = vi.fn(async () => { throw new Error('quota exceeded') })

      await expect(applyServerUrlChange(true, steps)).rejects.toThrow('quota exceeded')

      // The session is gone and the address was not written: the safe half of the failure. The
      // operator logs in again to the server they were already using.
      expect(calls).toEqual(['verify', 'stopSync', 'clearSession'])
      expect(steps.reload).not.toHaveBeenCalled()
    })

    it('does not write the new address if the session could not be cleared', async () => {
      const { calls, steps } = recordingSteps()
      steps.clearSession = vi.fn(async () => { throw new Error('idb closed') })

      await expect(applyServerUrlChange(true, steps)).rejects.toThrow('idb closed')

      expect(calls).toEqual(['verify', 'stopSync'])
      expect(steps.save).not.toHaveBeenCalled()
    })
  })

  describe('when the new address does not answer', () => {
    it('changes nothing at all — not the session, not sync, not the stored address', async () => {
      const { calls, steps } = recordingSteps(false)

      const outcome = await applyServerUrlChange(true, steps)

      expect(outcome).toBe('unreachable')
      expect(calls).toEqual(['verify'])
      expect(steps.stopSync).not.toHaveBeenCalled()
      expect(steps.clearSession).not.toHaveBeenCalled()
      expect(steps.save).not.toHaveBeenCalled()
      expect(steps.reload).not.toHaveBeenCalled()
    })

    it('treats a probe that rejects as no answer', async () => {
      const { steps } = recordingSteps()
      steps.verify = vi.fn(async () => { throw new Error('network down') })

      await expect(applyServerUrlChange(true, steps)).resolves.toBe('unreachable')
      expect(steps.clearSession).not.toHaveBeenCalled()
      expect(steps.save).not.toHaveBeenCalled()
    })

    it('treats a probe that throws before returning a promise as no answer', async () => {
      const { steps } = recordingSteps()
      steps.verify = vi.fn(() => { throw new Error('synchronous') }) as unknown as () => Promise<boolean>

      await expect(applyServerUrlChange(true, steps)).resolves.toBe('unreachable')
      expect(steps.save).not.toHaveBeenCalled()
    })

    it('accepts only a definite yes', async () => {
      // Anything but `true` is not the server saying it is up.
      const { steps } = recordingSteps()
      steps.verify = vi.fn(async () => 'yes' as unknown as boolean)

      await expect(applyServerUrlChange(true, steps)).resolves.toBe('unreachable')
      expect(steps.save).not.toHaveBeenCalled()
    })

    it('waits for the answer before touching anything', async () => {
      // A slow probe must not let the teardown start in the meantime.
      const { calls, steps } = recordingSteps()
      let release: (value: boolean) => void = () => {}
      steps.verify = vi.fn(() => new Promise<boolean>(resolve => { release = resolve }))

      const pending = applyServerUrlChange(true, steps)
      await Promise.resolve()
      await Promise.resolve()
      expect(calls).toEqual([])

      release(true)
      await expect(pending).resolves.toBe('reloading')
      expect(calls).toEqual(['stopSync', 'clearSession', 'save', 'reload'])
    })
  })
})
