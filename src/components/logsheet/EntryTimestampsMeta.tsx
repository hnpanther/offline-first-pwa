import { Typography } from '@mui/material'
import { t } from '@/i18n'
import { formatJalaliDateTime } from '@/utils/formatDate'

interface EntryTimestampsMetaProps {
  createdAt?: number
  updatedAt?: number
}

/** Shamsi created/updated times for a log sheet asset entry. */
export function EntryTimestampsMeta({
  createdAt,
  updatedAt
}: EntryTimestampsMetaProps) {
  if (createdAt == null && updatedAt == null) return null

  return (
    <Typography
      variant="caption"
      color="text.secondary"
      component="div"
      sx={{ mt: 0.5, lineHeight: 1.4 }}
    >
      {createdAt != null && (
        <span>
          {t.records.createdAt}: {formatJalaliDateTime(createdAt)}
        </span>
      )}
      {createdAt != null && updatedAt != null && (
        <Typography component="span" variant="caption" sx={{ mx: 0.5 }}>
          ·
        </Typography>
      )}
      {updatedAt != null && (
        <span>
          {t.records.updatedAt}: {formatJalaliDateTime(updatedAt)}
        </span>
      )}
    </Typography>
  )
}
