import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Stack,
  Typography
} from '@mui/material'
import SaveIcon from '@mui/icons-material/Save'
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline'
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline'
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
  /**
   * Where a photo, voice note, video or coordinate answering one of these questions belongs.
   *
   * No `assetId`, and that is the point: this media belongs to the **round**. The server stores
   * it with `attachments.asset_id` NULL (V10) and the device with `LocalAttachment.assetId`
   * absent, which is the one bit that tells the two owners apart.
   */
  attachmentContext?: {
    logSheetLocalId: string
    logSheetServerId?: string
  }
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
 * <h3>Media, and required answers</h3>
 *
 * A round-level question may be an image, a video, a voice note or a coordinate, exactly like a
 * per-asset one: `attachmentContext` is passed down with no `assetId`, and everything from the
 * capture control to the upload queue reads that absence as "this belongs to the sheet".
 *
 * A **required** question is enforced here and nowhere else. `handleSubmit` refuses to call
 * `onSave` while one is unanswered, which is help — the operator is looking at exactly these
 * questions. The round's final submission never checks them, on the device or on the server: an
 * operator standing at the equipment with a day's readings queued must never be blocked by an
 * answer they can still supply, and a required question that stopped a submit would do exactly
 * that.
 */
export function SheetQuestionsCard({
  questions,
  values,
  readOnly,
  savedAt,
  attachmentContext,
  onSave
}: SheetQuestionsCardProps) {
  const {
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting, isDirty }
  } = useForm<Record<string, unknown>>({ defaultValues: values })

  // Re-seed when the stored answers change under the form — a bundle merge while the round is
  // open, or this device's own save completing. Keyed on the values rather than on the sheet
  // object, which is replaced on every unrelated save.
  useEffect(() => {
    reset(values)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(values)])

  if (questions.length === 0) return null

  // Only to word the hint. The refusal itself is react-hook-form's, from the rules
  // `DynamicClassForm` already builds out of `required` — not a second check that could disagree.
  const hasRequired = questions.some(q => q.required)

  return (
    <Card variant="outlined" sx={{ mb: 2 }} data-testid="sheet-questions">
      <CardContent sx={{ pb: 2 }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
          <HelpOutlineIcon fontSize="small" color="primary" />
          <Typography variant="subtitle2" fontWeight={700} sx={{ flexGrow: 1 }}>
            پرسش‌های این کار
          </Typography>
          {/* Saved / unsaved, as a chip rather than a timestamp alone.
              This is the one place in the app where typing into a visible form and walking
              away loses the typing: these answers live in react-hook-form state until the
              button below is pressed, and every other field on the page belongs to a dialog
              that saves when it closes. `isDirty` rather than a comparison with `values` —
              re-typing the same answer still leaves the button something to do. */}
          {!readOnly && isDirty && (
            <Chip
              size="small"
              color="warning"
              variant="outlined"
              icon={<ErrorOutlineIcon fontSize="small" />}
              label="ذخیره نشده"
            />
          )}
          {!readOnly && !isDirty && savedAt != null && (
            <Chip
              size="small"
              color="success"
              variant="outlined"
              icon={<CheckCircleOutlineIcon fontSize="small" />}
              label="ذخیره شد"
            />
          )}
          {savedAt != null && (
            <Typography variant="caption" color="text.secondary">
              {formatJalaliDateTime(savedAt)}
            </Typography>
          )}
        </Stack>

        <Alert severity="info" sx={{ mb: 2, py: 0.5 }}>
          این پرسش‌ها یک‌بار برای کل این کار پرسیده می‌شوند، نه برای هر دارایی.
          {hasRequired && ' پرسش‌های ستاره‌دار برای ذخیرهٔ همین بخش لازم‌اند.'}
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
            attachmentContext={attachmentContext}
          />

          {!readOnly && (
            <>
              <Typography
                variant="caption"
                color={isDirty ? 'warning.main' : 'text.secondary'}
                sx={{ display: 'block', mt: 2, fontWeight: isDirty ? 600 : 400 }}
              >
                تا وقتی ذخیره نکنید، این پاسخ‌ها به سرور ارسال نمی‌شوند.
              </Typography>
              <Button
                type="submit"
                variant={isDirty ? 'contained' : 'outlined'}
                fullWidth
                sx={{ mt: 0.75 }}
                disabled={isSubmitting}
                startIcon={isSubmitting ? <CircularProgress size={16} /> : <SaveIcon />}
              >
                ذخیره پرسش‌ها
              </Button>
            </>
          )}
        </Box>
      </CardContent>
    </Card>
  )
}
