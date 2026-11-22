import type { LogSheet } from '@/types'

/**
 * Where the round's answers stand with the server, for the line under the save button.
 *
 * `queued` — saved on this device, not yet accepted (offline, or waiting for the push);
 * `refused` — the server answered the push with a refusal, shown with its reason;
 * `delivered` — the server holds these answers. Nothing when nobody has answered on this device.
 */
export type SheetFormDelivery = 'queued' | 'refused' | 'delivered'

export function sheetFormDelivery(
  sheet: Pick<LogSheet, 'sheetFormLocallyEditedAt' | 'sheetFormDeliveredAt' | 'progressSyncStatus'>
): SheetFormDelivery | undefined {
  if (sheet.sheetFormLocallyEditedAt != null) {
    return sheet.progressSyncStatus === 'failed' ? 'refused' : 'queued'
  }
  return sheet.sheetFormDeliveredAt != null ? 'delivered' : undefined
}
