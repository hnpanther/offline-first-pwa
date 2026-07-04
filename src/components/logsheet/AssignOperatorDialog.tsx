import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  CircularProgress,
  Alert
} from '@mui/material'
import { useEffect, useState } from 'react'
import { fetchUnitOperators, type UnitOperatorOption } from '@/services/api'
import { t } from '@/i18n'

interface AssignOperatorDialogProps {
  open: boolean
  unitId: number | string | null | undefined
  mode: 'assign' | 'reassign'
  loading?: boolean
  onClose: () => void
  onConfirm: (operatorId: number) => void
}

export function AssignOperatorDialog({
  open,
  unitId,
  mode,
  loading = false,
  onClose,
  onConfirm
}: AssignOperatorDialogProps) {
  const [operators, setOperators] = useState<UnitOperatorOption[]>([])
  const [fetching, setFetching] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<number | ''>('')

  useEffect(() => {
    if (!open || unitId == null) return
    setFetching(true)
    setFetchError(null)
    setSelectedId('')
    void fetchUnitOperators(unitId)
      .then(list => setOperators(list))
      .catch(err =>
        setFetchError(err instanceof Error ? err.message : t.inbox.assignFailed)
      )
      .finally(() => setFetching(false))
  }, [open, unitId])

  return (
    <Dialog open={open} onClose={loading ? undefined : onClose} fullWidth maxWidth="xs">
      <DialogTitle>
        {mode === 'assign' ? t.inbox.assignTitle : t.inbox.reassignTitle}
      </DialogTitle>
      <DialogContent>
        {fetchError && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {fetchError}
          </Alert>
        )}
        {fetching ? (
          <CircularProgress size={24} sx={{ display: 'block', mx: 'auto', my: 2 }} />
        ) : (
          <FormControl fullWidth sx={{ mt: 1 }}>
            <InputLabel id="assign-operator-label">{t.inbox.selectOperator}</InputLabel>
            <Select
              labelId="assign-operator-label"
              label={t.inbox.selectOperator}
              value={selectedId}
              onChange={e => setSelectedId(e.target.value as number)}
            >
              {operators.map(op => (
                <MenuItem key={op.id} value={op.id}>
                  {op.fullName}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={loading}>
          {t.form.cancel}
        </Button>
        <Button
          variant="contained"
          disabled={loading || fetching || selectedId === ''}
          onClick={() => {
            if (selectedId !== '') onConfirm(selectedId)
          }}
        >
          {loading ? t.inbox.assigning : t.inbox.assignConfirm}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
