/** Jalali date + time in fa-IR locale (Asia/Tehran via device/browser). */
export function formatJalaliDateTime(ts?: number | null): string {
  if (ts == null) return '—'
  return new Date(ts).toLocaleString('fa-IR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Asia/Tehran'
  })
}
