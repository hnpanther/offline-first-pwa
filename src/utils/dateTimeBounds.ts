import type { FieldDefinition } from '@/types/sync'
import { parseDateTimeEpoch } from './dateTimeValue'
import { serverNow } from '@/services/clock/serverClock'

/** Inclusive limits, judged at local recording time, never at a later sync retry. */
export function dateTimeBoundsError(value: unknown, validation: FieldDefinition['validation'], now = serverNow()): string | undefined {
  if (value == null || value === '') return undefined
  const epoch = parseDateTimeEpoch(value)
  if (epoch == null) return 'تاریخ و ساعت معتبر وارد کنید.'
  const range = validation?.dateTimeRange
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  const min = finite(range?.min) ? range.min : undefined
  const max = finite(range?.max) ? range.max : undefined
  if (!(min != null && max != null && min > max) &&
      ((min != null && epoch < min) || (max != null && epoch > max))) {
    return 'تاریخ و ساعت باید داخل بازهٔ تعیین‌شده باشد.'
  }
  const relative = validation?.dateTimeRelative
  const minutes = (v: unknown): v is number => finite(v) && Number.isInteger(v) && v >= 0 && v <= 5256000
  if (minutes(relative?.beforeMinutes) && epoch < now - relative.beforeMinutes * 60000) {
    return `تاریخ حداکثر ${relative.beforeMinutes} دقیقه قبل از زمان ثبت مجاز است.`
  }
  if (minutes(relative?.afterMinutes) && epoch > now + relative.afterMinutes * 60000) {
    return `تاریخ حداکثر ${relative.afterMinutes} دقیقه بعد از زمان ثبت مجاز است.`
  }
  return undefined
}
