import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  Stack,
  Typography
} from '@mui/material'
import PermMediaIcon from '@mui/icons-material/PermMedia'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import { t } from '@/i18n'
import { attachmentIdsOf } from '@/services/storage/attachments'
import type {
  RestorableAsset,
  RestorableField,
  RestorePlan
} from '@/services/storage/restoreArchivedWork'

/**
 * Choosing which of an archived round's assets to copy back into the live sheet.
 *
 * <h2>Why the operator picks, rather than one button that restores everything</h2>
 *
 * While the sheet belonged to somebody else, that somebody may have recorded their own readings.
 * Restoring over them would bury real work with no trace, so every asset the live sheet already
 * answers is marked a **conflict**, shows both values, and starts **unticked**. The assets nobody
 * has touched since start ticked, because for those there is no real decision to make.
 *
 * <h2>What the media counts mean</h2>
 *
 * Media restores as references to files still on this device, so a field can offer two files
 * while the live sheet shows none: clearing the row dropped the references and left the files.
 * The count shown is what would actually be written — `buildRestorePlan` resolves it against the
 * device, so it already excludes a file that is gone and already includes one the archive never
 * knew about. Ids that resolve to nothing are reported separately rather than quietly omitted;
 * an operator should be told that a photograph did not come back.
 */
interface Props {
  open: boolean
  plan: RestorePlan | null
  busy: boolean
  onClose: () => void
  onConfirm: (assetIds: string[]) => void
}

function fill(template: string, count: number): string {
  return template.replace('{{count}}', String(count))
}

/** One side of one field, as a line of Persian text. */
function formatValue(field: RestorableField, value: unknown): string {
  if (field.media) {
    const count = attachmentIdsOf(value).length
    return count === 0 ? t.restoreArchived.empty : fill(t.restoreArchived.mediaCount, count)
  }
  if (value === undefined || value === null || value === '') return t.restoreArchived.empty
  if (typeof value === 'object') return JSON.stringify(value)
  const text =
    typeof value === 'boolean'
      ? value
        ? t.restoreArchived.yes
        : t.restoreArchived.no
      : String(value)
  return field.unit ? text + ' ' + field.unit : text
}

export default function RestoreArchivedWorkDialog({
  open,
  plan,
  busy,
  onClose,
  onConfirm
}: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // Conflicting assets start unticked: replacing somebody else's reading has to be a decision,
  // not the default a hurried tap accepts.
  useEffect(() => {
    setSelected(new Set((plan?.assets ?? []).filter(a => !a.conflict).map(a => a.assetId)))
  }, [plan])

  const conflicts = useMemo(() => (plan?.assets ?? []).filter(a => a.conflict).length, [plan])
  const missing = useMemo(
    () => (plan?.assets ?? []).reduce((n, a) => n + a.missingAttachmentIds.length, 0),
    [plan]
  )

  const toggle = (assetId: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(assetId)) next.delete(assetId)
      else next.add(assetId)
      return next
    })
  }

  const renderField = (asset: RestorableAsset, field: RestorableField) => (
    <Box key={field.key} sx={{ mt: 0.75 }}>
      <Typography variant="caption" fontWeight={700} sx={{ display: 'block' }}>
        {field.label}
      </Typography>
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        <Typography variant="caption" color="success.main">
          {t.restoreArchived.mine}: {formatValue(field, field.mine)}
        </Typography>
        {asset.conflict && (
          <Typography variant="caption" color="text.secondary">
            {t.restoreArchived.current}: {formatValue(field, field.current)}
          </Typography>
        )}
      </Stack>
    </Box>
  )

  const renderAsset = (asset: RestorableAsset) => (
    <Box key={asset.assetId} sx={{ py: 1.25 }}>
      <FormControlLabel
        sx={{ alignItems: 'flex-start', m: 0, width: '100%' }}
        control={
          <Checkbox
            checked={selected.has(asset.assetId)}
            onChange={() => toggle(asset.assetId)}
            disabled={busy}
            sx={{ pt: 0, mr: 0.5 }}
            inputProps={{ 'aria-label': asset.assetName }}
          />
        }
        label={
          <Box sx={{ width: '100%' }}>
            <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
              <Typography variant="subtitle2" fontWeight={700}>
                {asset.assetName}
              </Typography>
              {asset.conflict && (
                <Chip
                  size="small"
                  color="warning"
                  variant="outlined"
                  label={t.restoreArchived.conflictChip}
                />
              )}
              {asset.attachmentIds.length > 0 && (
                <Chip
                  size="small"
                  variant="outlined"
                  icon={<PermMediaIcon />}
                  label={fill(t.restoreArchived.mediaCount, asset.attachmentIds.length)}
                />
              )}
            </Stack>

            {asset.fields.map(field => renderField(asset, field))}

            {asset.missingAttachmentIds.length > 0 && (
              <Typography variant="caption" color="error.main" sx={{ display: 'block', mt: 0.5 }}>
                {fill(t.restoreArchived.missingMedia, asset.missingAttachmentIds.length)}
              </Typography>
            )}
          </Box>
        }
      />
    </Box>
  )

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t.restoreArchived.title}</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          {t.restoreArchived.intro}
        </Typography>

        {conflicts > 0 && (
          <Alert severity="warning" icon={<WarningAmberIcon />} sx={{ mb: 1.5 }}>
            {fill(t.restoreArchived.conflictWarning, conflicts)}
          </Alert>
        )}
        {missing > 0 && (
          <Alert severity="info" sx={{ mb: 1.5 }}>
            {fill(t.restoreArchived.missingWarning, missing)}
          </Alert>
        )}

        <Stack divider={<Divider flexItem />}>{(plan?.assets ?? []).map(renderAsset)}</Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          {t.form.cancel}
        </Button>
        <Button
          variant="contained"
          disabled={busy || selected.size === 0}
          onClick={() => onConfirm([...selected])}
        >
          {fill(t.restoreArchived.confirm, selected.size)}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
