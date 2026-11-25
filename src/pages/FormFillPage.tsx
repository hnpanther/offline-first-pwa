import { serverNow } from '@/services/clock/serverClock'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Autocomplete,
  TextField,
  Stack,
  Typography
} from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import SaveIcon from '@mui/icons-material/Save'
import SendIcon from '@mui/icons-material/Send'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { t } from '@/i18n'
import { DynamicClassForm } from '@/components/forms/DynamicClassForm'
import { getFormDefinition } from '@/services/storage/formDefinitions'
import {
  createLocalFormDraft,
  correctRejectedForm,
  getFormSubmission,
  markFormSubmissionLocallyFinal,
  saveLocalFormDraft
} from '@/services/storage/formSubmissions'
import { db } from '@/services/storage/db'
import { loadAccessibleUnitIds, loadPrimaryUnitId } from '@/services/forms/formLookups'
import { getSessionUserId } from '@/services/auth/sessionContext'
import { syncManager } from '@/services/sync'
import {
  describeFormSubmitBlockingIssues,
  findFormSubmitBlockingIssues
} from '@/utils/formSubmissionValidation'
import { isFormSubmissionVisibleToSession } from '@/utils/formSubmissionVisibility'
import { FORM_OWNER } from '@/utils/signatureVerdict'
import { listKey } from '@/services/lookups/lookupStore'
import { formFilingUnits, defaultFilingUnit } from '@/utils/formFilingUnits'
import { offlineFormFillBlocked } from '@/utils/formFillGate'
import { persianFormTitle } from '@/utils/persianFormTitle'
import { useAppStore } from '@/store'
import { hasPlantWideScope } from '@/types/auth'
import type { CachedFormDefinition, LocalFormSubmission, OperationalUnit } from '@/types'

type Mode = 'new' | 'edit'

export function FormFillPage() {
  const navigate = useNavigate()
  const { formId, localId } = useParams<{ formId?: string; localId?: string }>()
  const mode: Mode = localId ? 'edit' : 'new'
  const authSession = useAppStore(s => s.authSession)
  const plantWide = hasPlantWideScope(authSession)

  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [definition, setDefinition] = useState<CachedFormDefinition | null>(null)
  const [submission, setSubmission] = useState<LocalFormSubmission | null>(null)
  const [units, setUnits] = useState<OperationalUnit[]>([])
  const [reporterUnitId, setReporterUnitId] = useState('')
  const [lookupsReady, setLookupsReady] = useState(true)
  const [fillBlocked, setFillBlocked] = useState(false)

  const readOnly = submission?.status === 'submitted' || fillBlocked

  const form = useForm<Record<string, unknown>>({
    defaultValues: {},
    mode: 'onChange'
  })

  const fields = useMemo(
    () => submission?.fieldDefinitionsSnapshot ?? definition?.fields ?? [],
    [submission, definition]
  )

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [allUnits, primary, accessible] = await Promise.all([
        db.operationalUnits.toArray(),
        loadPrimaryUnitId(),
        loadAccessibleUnitIds()
      ])
      if (mode === 'edit' && localId) {
        const row = await getFormSubmission(localId)
        const sessionUserId = await getSessionUserId()
        if (
          !row ||
          !isFormSubmissionVisibleToSession(row, {
            userId: sessionUserId,
            accessibleUnitIds: accessible,
            plantWide
          })
        ) {
          setError('پیش‌نویس یافت نشد.')
          return
        }
        setSubmission(row)
        setReporterUnitId(row.reporterUnitId)
        form.reset(row.formData ?? {})
        const def = await getFormDefinition(row.formDefinitionId)
        setDefinition(def ?? null)
        setUnits(formFilingUnits(allUnits, def?.subjectUnitIds ?? [], accessible, plantWide))
        await noteLookupGate(def?.requiredLookups)
      } else if (formId) {
        const def = await getFormDefinition(formId)
        if (!def) {
          setError(t.forms.emptyCatalog)
          return
        }
        setDefinition(def)
        setSubmission(null)
        const choices = formFilingUnits(allUnits, def.subjectUnitIds, accessible, plantWide)
        setUnits(choices)
        setReporterUnitId(defaultFilingUnit(choices, primary))
        form.reset({})
        await noteLookupGate(def.requiredLookups)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطا در بارگذاری فرم')
    } finally {
      setLoading(false)
    }
  }, [form, formId, localId, mode, plantWide])

  /** This form's own lists, not every leased catalog. Offline fill waits until they are here. */
  async function noteLookupGate(
    required: Array<{ code: string }> | undefined
  ): Promise<boolean> {
    const codes = required ?? []
    const metas = codes.length
      ? await Promise.all(codes.map(r => db.lookupLists.get(listKey(r.code))))
      : []
    const completeCodes = codes
      .filter((_, i) => metas[i] != null && metas[i]!.complete)
      .map(r => r.code)
    const ready = codes.length === 0 || completeCodes.length === codes.length
    const blocked = offlineFormFillBlocked({
      requiredLookups: codes,
      completeCodes,
      offline: typeof navigator !== 'undefined' && navigator.onLine === false
    })
    setLookupsReady(ready)
    setFillBlocked(blocked)
    return blocked
  }

  useEffect(() => {
    void load()
  }, [load])

  // This page scrolls the window. The log-sheet asset form scrolls inside a dialog, so the same
  // fields do not move the page there. Here, anything inserted above the action row (a lookup
  // hint, the signature pad, a validation alert) is above whatever the browser anchored at the
  // bottom, and anchoring yanks the scroll position. Opt out for the life of this page only.
  useEffect(() => {
    const root = document.documentElement
    const previous = root.style.overflowAnchor
    root.style.overflowAnchor = 'none'
    return () => {
      root.style.overflowAnchor = previous
    }
  }, [])

  const ensureDraft = async (values: Record<string, unknown>, recordedAt: number): Promise<LocalFormSubmission | null> => {
    if (!units.some(unit => unit.id === reporterUnitId)) {
      setError('واحد ثبت‌کنندهٔ مجاز را انتخاب کنید.')
      return null
    }
    if (submission) {
      const saved = await saveLocalFormDraft(submission.localId, values, reporterUnitId, recordedAt)
      if (saved) setSubmission(saved)
      return saved ?? null
    }
    if (!definition) return null
    const created = await createLocalFormDraft({
      recordedAt,
      formDefinitionId: definition.id,
      schemaVersionId: definition.schemaVersionId,
      formCode: definition.code,
      formTitle: definition.title,
      reporterUnitId,
      subjectUnitId: reporterUnitId,
      fieldDefinitionsSnapshot: definition.fields,
      formData: values
    })
    setSubmission(created)
    // Route to stable edit URL so refresh keeps the draft.
    navigate(`/forms/${created.localId}`, { replace: true })
    return created
  }

  const handleSaveDraft = async () => {
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      const values = form.getValues()
      const recordedAt = serverNow()
      const invalid = findFormSubmitBlockingIssues(fields, values, recordedAt).filter(issue => issue.problem)
      if (invalid.length) { setError(describeFormSubmitBlockingIssues(invalid)); return }
      const row = await ensureDraft(values, recordedAt)
      if (!row) return
      setInfo(t.forms.draftSaved)
      void syncManager.pushFormDraftsNow()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطا در ذخیره پیش‌نویس')
    } finally {
      setBusy(false)
    }
  }

  const handleFinalSubmit = async () => {
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      const values = form.getValues()
      const recordedAt = serverNow()
      const issues = findFormSubmitBlockingIssues(fields, values, recordedAt)
      if (issues.length > 0) {
        setError(describeFormSubmitBlockingIssues(issues) || t.forms.validationBlocked)
        return
      }
      const row = await ensureDraft(values, recordedAt)
      if (!row) return
      const finalised = await markFormSubmissionLocallyFinal(row.localId, values, recordedAt)
      if (finalised) setSubmission(finalised)
      setInfo(t.forms.submittedLocal)
      void syncManager.sync()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطا در ارسال نهایی')
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    )
  }

  const title =
    persianFormTitle(submission?.formTitle ?? definition?.title) || t.forms.title

  return (
    <Box
      sx={theme => ({
        p: 2,
        maxWidth: 720,
        mx: 'auto',
        // The app bar is fixed. Focusing the last control scrolls it to the top of the layout
        // viewport, which is under that bar, and the browser then corrects — a jump. The margin
        // is what scroll-into-view already honours.
        '& .MuiInputBase-root, & .MuiButton-root, & .MuiSelect-select': {
          scrollMarginTop: `calc(${Number(theme.mixins.toolbar.minHeight) || 56}px + 12px)`,
          scrollMarginBottom: 24
        }
      })}
    >
      <Button
        startIcon={<ArrowBackIcon />}
        onClick={() => navigate('/forms')}
        sx={{ mb: 1 }}
      >
        {t.forms.backToList}
      </Button>

      <Typography
        variant="h5"
        fontWeight={700}
        sx={{ mb: 2, whiteSpace: 'normal', overflowWrap: 'anywhere' }}
      >
        {title}
      </Typography>

      {!lookupsReady && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {t.forms.offlineNotReady}
        </Alert>
      )}
      {lookupsReady && definition?.requiredLookups && definition.requiredLookups.length > 0 && (
        <Alert severity="success" sx={{ mb: 2 }}>
          {t.forms.offlineReady}
        </Alert>
      )}
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {info && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setInfo(null)}>
          {info}
        </Alert>
      )}
      {submission?.syncStatus === 'failed' && submission.lastSubmitOutcome === 'VALIDATION_ERROR' && (
        <Alert severity="error" sx={{ mb: 2 }} action={
          <Button disabled={busy} onClick={async () => {
            setBusy(true)
            try {
              const corrected = await correctRejectedForm(submission.localId)
              if (corrected) { setSubmission(corrected); form.reset(corrected.formData) }
            } catch (err) {
              setError(err instanceof Error ? err.message : 'خطا در بازکردن فرم برای اصلاح')
            } finally { setBusy(false) }
          }}>اصلاح پاسخ‌ها</Button>
        }>{submission.syncError || 'ارسال فرم نیاز به اصلاح دارد.'}</Alert>
      )}

      {readOnly && (
        <Alert severity="info" sx={{ mb: 2 }}>
          {t.forms.immutable}
        </Alert>
      )}

      {!readOnly && (
        <Box sx={{ mb: 2 }}>
          <Autocomplete
            options={units}
            value={units.find(unit => unit.id === reporterUnitId) ?? null}
            onChange={(_, unit) => setReporterUnitId(unit?.id ?? '')}
            getOptionLabel={unit => `${unit.name} · ${unit.code}`}
            isOptionEqualToValue={(a, b) => a.id === b.id}
            noOptionsText="واحد مجازی برای ثبت این فرم در دسترس نیست."
            disabled={busy}
            renderInput={params => <TextField {...params} label={t.forms.reporterUnit} size="small" />}
          />
          {!submission && (
            <Button sx={{ mt: 2 }} variant="contained" disabled={busy || !reporterUnitId || fillBlocked}
              onClick={() => void handleSaveDraft()}>
              شروع تکمیل فرم
            </Button>
          )}
        </Box>
      )}

      {submission && (fields.length === 0 ? (
        <Alert severity="warning">فیلدی برای این فرم تعریف نشده است.</Alert>
      ) : (
        <DynamicClassForm
          fields={fields}
          control={form.control}
          errors={form.formState.errors}
          readOnly={readOnly}
          readOnlyValues={readOnly ? (submission?.formData ?? {}) : undefined}
          attachmentContext={
            submission
              ? {
                  formSubmissionLocalId: submission.localId,
                  formSubmissionId: submission.serverId
                }
              : undefined
          }
          // Same soft stale path as log sheets: SignatureFieldWithVerdict needs an owner
          // key so it can compare localFingerprint / baselines to live answers. Never blocks
          // draft or final submit.
          signatureContext={{ owner: FORM_OWNER }}
        />
      ))}

      {submission && !readOnly && (
        <Stack direction="row" spacing={1} sx={{ mt: 3 }} justifyContent="flex-end">
          <Button
            variant="outlined"
            startIcon={<SaveIcon />}
            disabled={busy}
            onClick={() => void handleSaveDraft()}
          >
            {busy ? t.forms.saving : t.forms.saveDraft}
          </Button>
          <Button
            variant="contained"
            startIcon={<SendIcon />}
            disabled={busy}
            onClick={() => void handleFinalSubmit()}
          >
            {busy ? t.forms.submitting : t.forms.submitFinal}
          </Button>
        </Stack>
      )}
    </Box>
  )
}
