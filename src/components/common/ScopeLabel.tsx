import { Typography } from '@mui/material'
import { useScopeLabel } from '@/hooks/useScopeLabel'

interface ScopeLabelProps {
  scopeSummary?: string | null
  templateId?: string
  scopeDisplayLabel?: string | null
  variant?: 'body2' | 'caption' | 'subtitle1'
  color?: string
  fontWeight?: number
}

export function ScopeLabel({
  scopeSummary,
  templateId,
  scopeDisplayLabel,
  variant = 'body2',
  color = 'text.secondary',
  fontWeight
}: ScopeLabelProps) {
  const label = useScopeLabel(
    scopeSummary ?? undefined,
    templateId,
    scopeDisplayLabel ?? undefined
  )

  return (
    <Typography variant={variant} color={color} fontWeight={fontWeight}>
      {label}
    </Typography>
  )
}
