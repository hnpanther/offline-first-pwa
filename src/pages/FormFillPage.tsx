import {
  Alert,
  Box,
  Button,
  CircularProgress,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
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
  const [subjectUnitId, setSubjectUnitId] = useState('')
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

  const subjectChoices = useMemo(() => {
    const fromDef = definition?.subjectUnitIds ?? []
    if (fromDef.length > 0) return units.filter(u => fromDef.includes(u.id))
    if (submission?.subjectUnitId) {
      return units.filter(u => u.id === submission.subjectUnitId)
    }
    return units
  }, [definition, submission, units])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [allUnits, primary, accessible] = await Promise.all([
        db.operationalUnits.toArray(),
        loadPrimaryUnitId(),
        loadAccessibleUnitIds()
      ])
      setUnits(allUnits)

      const defaultReporter =
        primary ??
        accessible[0] ??
        allUnits[0]?.id ??
        ''

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
        setSubjectUnitId(row.subjectUnitId)
        form.reset(row.formData ?? {})
        const def = await getFormDefinition(row.formDefinitionId)
        setDefinition(def ?? null)
        await noteLookupGate(def?.requiredLookups)
      } else if (formId) {
        const def = await getFormDefinition(formId)
        if (!def) {
          setError(t.forms.emptyCatalog)
          return
        }
        setDefinition(def)
        const blocked = await noteLookupGate(def.requiredLookups)
        if (blocked) return
        const firstSubject = def.subjectUnitIds[0] ?? ''
        setReporterUnitId(defaultReporter)
        setSubjectUnitId(firstSubject)
        form.reset({})
        // Create an empty local draft immediately so media fields have an owner key and the
        // schema freeze matches the server's "first draft save" rule once sync lands.
        if (defaultReporter && firstSubject) {
          const created = await createLocalFormDraft({
            formDefinitionId: def.id,
            formCode: def.code,
            formTitle: def.title,
            reporterUnitId: defaultReporter,
            subjectUnitId: firstSubject,
            fieldDefinitionsSnapshot: def.fields,
            formData: {}
          })
          setSubmission(created)
          navigate(`/forms/${created.localId}`, { replace: true })
          void syncManager.pushFormDraftsNow()
        }
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

  const ensureDraft = async (values: Record<string, unknown>): Promise<LocalFormSubmission | null> => {
    if (submission) {
      const saved = await saveLocalFormDraft(submission.localId, values)
      if (saved) setSubmission(saved)
      return saved ?? null
    }
    if (!definition) return null
    if (!reporterUnitId || !subjectUnitId) {
      setError(t.forms.pickSubject)
      return null
    }
    const created = await createLocalFormDraft({
      formDefinitionId: definition.id,
      formCode: definition.code,
      formTitle: definition.title,
      reporterUnitId,
      subjectUnitId,
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
      const row = await ensureDraft(values)
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
      const issues = findFormSubmitBlockingIssues(fields, values)
      if (issues.length > 0) {
        setError(describeFormSubmitBlockingIssues(issues) || t.forms.validationBlocked)
        return
      }
      const row = await ensureDraft(values)
      if (!row) return
      const finalised = await markFormSubmissionLocallyFinal(row.localId, values)
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
    <Box sx={{ p: 2, maxWidth: 720, mx: 'auto' }}>
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
      {readOnly && (
        <Alert severity="info" sx={{ mb: 2 }}>
          {t.forms.immutable}
        </Alert>
      )}

      {!readOnly && (
        <Stack spacing={2} sx={{ mb: 2 }}>
          <FormControl fullWidth size="small">
            <InputLabel id="reporter-unit-label">{t.forms.reporterUnit}</InputLabel>
            <Select
              labelId="reporter-unit-label"
              label={t.forms.reporterUnit}
              value={reporterUnitId}
              disabled={!!submission}
              onChange={e => setReporterUnitId(String(e.target.value))}
            >
              {units.map(u => (
                <MenuItem key={u.id} value={u.id}>
                  {u.name} ({u.code})
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <FormControl fullWidth size="small">
            <InputLabel id="subject-unit-label">{t.forms.subjectUnit}</InputLabel>
            <Select
              labelId="subject-unit-label"
              label={t.forms.subjectUnit}
              value={subjectUnitId}
              disabled={!!submission}
              onChange={e => setSubjectUnitId(String(e.target.value))}
            >
              {subjectChoices.length === 0 ? (
                <MenuItem value="" disabled>
                  {t.forms.noUnits}
                </MenuItem>
              ) : (
                subjectChoices.map(u => (
                  <MenuItem key={u.id} value={u.id}>
                    {u.name} ({u.code})
                  </MenuItem>
                ))
              )}
            </Select>
          </FormControl>
        </Stack>
      )}

      {fields.length === 0 ? (
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
      )}

      {!readOnly && (
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
