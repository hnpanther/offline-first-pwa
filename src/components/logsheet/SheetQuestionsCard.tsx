import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Stack,
  Typography
} from '@mui/material'
import SaveIcon from '@mui/icons-material/Save'
import HelpOutlineIcon from '@mui/icons-material/HelpOutline'
import { DynamicClassForm } from '@/components/forms/DynamicClassForm'
import { formatJalaliDateTime } from '@/utils/formatDate'
import type { FieldDefinition } from '@/types/sync'

interface SheetQuestionsCardProps {
  /** The round's own questions, frozen onto the sheet when it was raised. */
  questions: FieldDefinition[]
  /** The answers as they stand on the device. */
  values: Record<string, unknown>
  /** Read-only once the round can no longer be edited here. */
  readOnly: boolean
  /** When the operator last answered them on this device, for the «ذخیره شد» line. */
  savedAt?: number
  onSave: (values: Record<string, unknown>) => Promise<void>
}

/**
 * The questions that belong to the **round** rather than to any asset on it — «آیا همه لوله‌ها
 * بازدید شد؟», asked once per sheet.
 *
 * <h3>Why it has its own save</h3>
 *
 * The same reason each asset does: one small save per section means a closed app costs a field
 * rather than an afternoon, and what the section shows afterwards is what was actually stored.
 * It queues a progress report like any other save, so a supervisor sees the answer without
 * waiting for the round to finish.
 *
 * <h3>Why `DynamicClassForm` renders it unchanged</h3>
 *
 * These are field definitions with a different owner — same shape, same controls, same
 * validator. The component takes a list and a form control and asks nothing about where the
 * list came from, which is the whole reason this feature needed no new field rendering.
 *
 * Attachment types cannot reach here: the server refuses them for a round-level question
 * because `attachments.asset_id` is NOT NULL and an answer that belongs to no asset has
 * nowhere to put its bytes. `attachmentContext` is therefore deliberately absent, and such a
 * field would render read-only if one ever arrived from an older server.
 */
export function SheetQuestionsCard({
  questions,
  values,
  readOnly,
  savedAt,
  onSave
}: SheetQuestionsCardProps) {
  const {
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting }
  } = useForm<Record<string, unknown>>({ defaultValues: values })

  // Re-seed when the stored answers change under the form — a bundle merge while the round is
  // open, or this device's own save completing. Keyed on the values rather than on the sheet
  // object, which is replaced on every unrelated save.
  useEffect(() => {
    reset(values)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(values)])

  if (questions.length === 0) return null

  return (
    <Card variant="outlined" sx={{ mb: 2 }} data-testid="sheet-questions">
      <CardContent sx={{ pb: 2 }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
          <HelpOutlineIcon fontSize="small" color="primary" />
          <Typography variant="subtitle2" fontWeight={700} sx={{ flexGrow: 1 }}>
            پرسش‌های این کار
          </Typography>
          {savedAt != null && (
            <Typography variant="caption" color="text.secondary">
              {formatJalaliDateTime(savedAt)}
            </Typography>
          )}
        </Stack>

        <Alert severity="info" sx={{ mb: 2, py: 0.5 }}>
          این پرسش‌ها یک‌بار برای کل این کار پرسیده می‌شوند، نه برای هر دارایی.
        </Alert>

        <Box
          component="form"
          onSubmit={e => {
            e.preventDefault()
            void handleSubmit(onSave)()
          }}
        >
          <DynamicClassForm
            fields={questions}
            control={control}
            errors={errors}
            readOnly={readOnly}
            readOnlyValues={readOnly ? values : undefined}
          />

          {!readOnly && (
            <Button
              type="submit"
              variant="outlined"
              fullWidth
              sx={{ mt: 2 }}
              disabled={isSubmitting}
              startIcon={isSubmitting ? <CircularProgress size={16} /> : <SaveIcon />}
            >
              ذخیره پرسش‌ها
            </Button>
          )}
        </Box>
      </CardContent>
    </Card>
  )
}
