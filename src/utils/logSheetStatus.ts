import type { LogSheet } from '@/types'

export const SYNC_OUTCOME_MESSAGES = {
  EXPIRED: 'مهلت تکمیل این کار گذشته است و امکان سینک وجود ندارد.',
  SUPERSEDED: 'این کار قبلاً توسط شخص دیگری ثبت شده و مورد شما قابل سینک نیست.',
  DUPLICATE: 'این ارسال قبلاً ثبت شده است.',
  ERROR: 'خطا در ارسال به سرور.'
} as const

export function isLogSheetExpired(sheet: Pick<LogSheet, 'dueAt' | 'serverStatus'>, now = Date.now()): boolean {
  if (sheet.serverStatus === 'EXPIRED') return true
  return sheet.dueAt != null && sheet.dueAt <= now
}

export function isSupersededSyncError(syncError?: string): boolean {
  if (!syncError) return false
  return syncError.includes('SUPERSEDED') || syncError === SYNC_OUTCOME_MESSAGES.SUPERSEDED
}

export function syncOutcomeMessage(outcome?: string, error?: string | null): string {
  if (error?.trim()) return error
  switch (outcome) {
    case 'SUPERSEDED':
      return SYNC_OUTCOME_MESSAGES.SUPERSEDED
    case 'EXPIRED':
      return SYNC_OUTCOME_MESSAGES.EXPIRED
    case 'DUPLICATE':
      return SYNC_OUTCOME_MESSAGES.DUPLICATE
    default:
      return SYNC_OUTCOME_MESSAGES.ERROR
  }
}

export function canSubmitLogSheet(sheet: LogSheet, now = Date.now()): { ok: boolean; reason?: string } {
  if (isLogSheetExpired(sheet, now)) {
    return { ok: false, reason: SYNC_OUTCOME_MESSAGES.EXPIRED }
  }
  if (sheet.serverStatus === 'SUBMITTED' && sheet.syncStatus === 'synced') {
    return { ok: false, reason: 'این کار قبلاً ثبت نهایی شده است.' }
  }
  return { ok: true }
}
