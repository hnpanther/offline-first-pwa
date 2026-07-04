import { Typography, Box } from '@mui/material'
import { t } from '@/i18n'

const formatDate = (ts: number) =>
  new Date(ts).toLocaleString('fa-IR', { dateStyle: 'short', timeStyle: 'short' })

interface LogSheetIdentityMetaProps {
  serverId?: string | number | null
  createdAt?: number | null
  variant?: 'body2' | 'caption'
  inline?: boolean
}

/** Shows server log-sheet id and production (generation) date. */
export function LogSheetIdentityMeta({
  serverId,
  createdAt,
  variant = 'caption',
  inline = true
}: LogSheetIdentityMetaProps) {
  const parts: string[] = []
  if (serverId != null && String(serverId).trim()) {
    parts.push(`${t.logSheet.serverId}: ${String(serverId)}`)
  }
  if (createdAt != null) {
    parts.push(`${t.logSheet.producedAt}: ${formatDate(createdAt)}`)
  }
  if (parts.length === 0) return null

  const content = parts.join(inline ? ' · ' : '\n')

  if (inline) {
    return (
      <Typography variant={variant} color="text.secondary" component="span">
        {content}
      </Typography>
    )
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
      {serverId != null && String(serverId).trim() && (
        <Typography variant={variant} color="text.secondary">
          {t.logSheet.serverId}: <strong>{String(serverId)}</strong>
        </Typography>
      )}
      {createdAt != null && (
        <Typography variant={variant} color="text.secondary">
          {t.logSheet.producedAt}: <strong>{formatDate(createdAt)}</strong>
        </Typography>
      )}
    </Box>
  )
}
