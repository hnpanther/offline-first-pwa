import {
  Box,
  Card,
  CardContent,
  Typography,
  TextField,
  Button,
  Alert,
  Divider,
  InputAdornment
} from '@mui/material'
import SaveIcon from '@mui/icons-material/Save'
import { useForm, Controller } from 'react-hook-form'
import { useState } from 'react'
import { useSettings } from '@/hooks/useSettings'
import { getSettings } from '@/services/storage'
import { useAuth } from '@/hooks/useAuth'
import { hasPlantWideScope, isManualTagEntryAllowed } from '@/types/auth'
import { t } from '@/i18n'
import { DEFAULT_SETTINGS } from '@/services/storage/db'
import { isOrientationLockSupported } from '@/services/device/screenOrientation'
import { clampSyncInterval, fromSeconds, toSeconds } from '@/services/settings/syncInterval'
import { useScreenOrientation } from '@/hooks/useScreenOrientation'
import type { AppSettings } from '@/types'

export function SettingsPage() {
  const { settings, updateSettings } = useSettings()
  const { authSession } = useAuth()
  const isAdmin = hasPlantWideScope(authSession ?? null)
  // The policy is an AND with the viewer's own permission, so the raw switch alone can mislead:
  // an admin reading «فعال» while their own account lacks the permission would go looking for a
  // bug in the fill screen. Both answers are shown, the effective one second.
  const manualEntryEffective = isManualTagEntryAllowed(
    authSession ?? null,
    settings.nfcManualEntryEnabled
  )
  const [saved, setSaved] = useState(false)
  const limits = settings.attachmentLimits ?? DEFAULT_SETTINGS.attachmentLimits
  const orientationLockSupported = isOrientationLockSupported()
  // Calling the hook here re-applies the lock and reports back, so the alert below reflects
  // the choice that was just saved rather than the one in force when the app launched.
  const orientationOutcome = useScreenOrientation()

  const { control, handleSubmit } = useForm<AppSettings>({
    values: settings
  })

  const onSubmit = async (data: AppSettings) => {
    // Re-read the stored row instead of trusting the snapshot this form was built from. The
    // server-owned values below can change under an open page — a bootstrap runs on every
    // reconnect — and a form initialised minutes ago would otherwise write the policy it
    // remembers back over the one the server has since sent. That is not a cosmetic race: for
    // `nfcStrictSerialMatch` it would silently restore a scan rule an administrator changed.
    const stored = await getSettings()
    await updateSettings({
      ...data,
      // Already milliseconds: the field converts on the way in and out (see below). Converting
      // again here multiplied the interval by 1000 on every save — including a save where
      // nobody touched the field — so 30 seconds silently became 30,000 and grew from there.
      syncIntervalMs: clampSyncInterval(data.syncIntervalMs),
      // None of these are written from this screen; the device is not their owner.
      attachmentLimits: stored.attachmentLimits ?? DEFAULT_SETTINGS.attachmentLimits,
      nfcStrictSerialMatch: stored.nfcStrictSerialMatch,
      imageAnnotationEnabled: stored.imageAnnotationEnabled
    })
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
  }

  return (
    <Box
      component="form"
      onSubmit={handleSubmit(onSubmit)}
      sx={{ maxWidth: 600, mx: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}
      noValidate
    >
      <Typography variant="h5" fontWeight={700}>
        {t.settings.title}
      </Typography>

      {saved && <Alert severity="success">{t.settings.saved}</Alert>}

      {/* Server connection */}
      <Card>
        <CardContent sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
          <Typography variant="subtitle1" fontWeight={600} color="text.secondary">
            {t.settings.connection}
          </Typography>

          <Controller
            name="serverUrl"
            control={control}
            render={({ field }) => (
              <TextField
                {...field}
                label={t.settings.serverUrl}
                fullWidth
                dir="ltr"
                helperText="مثال: http://192.168.1.100:8081"
                inputProps={{ style: { textAlign: 'left', direction: 'ltr' } }}
              />
            )}
          />

          <Controller
            name="syncIntervalMs"
            control={control}
            render={({ field }) => (
              <TextField
                {...field}
                value={toSeconds(field.value)}
                onChange={e => field.onChange(fromSeconds(e.target.value))}
                label={t.settings.syncInterval}
                type="number"
                fullWidth
                inputProps={{ min: 10, max: 3600 }}
                InputProps={{
                  endAdornment: <InputAdornment position="end">ثانیه</InputAdornment>
                }}
              />
            )}
          />
        </CardContent>
      </Card>

      {/* Rules the device follows but does not own — shown, never edited.
          Manual tag entry is listed but not editable here: it used to be a device switch that
          *granted* the capability to anyone who could open this screen, and it is now a
          server-owned restriction ANDed with the user's permission. */}
      {isAdmin && (
        <Card variant="outlined">
          <CardContent>
            <Typography variant="subtitle1" fontWeight={700} gutterBottom>
              {t.settings.serverPolicyTitle}
            </Typography>
            <Alert severity="info" sx={{ mb: 2 }}>
              {t.settings.serverPolicyHint}
            </Alert>
            <Box
              component="dl"
              sx={{ m: 0, display: 'grid', gridTemplateColumns: '1fr auto', rowGap: 1.5, columnGap: 2 }}
            >
              <Box sx={{ display: 'contents' }}>
                <Box component="dt">
                  <Typography variant="body2" color="text.secondary">
                    {t.settings.strictSerialMatch}
                  </Typography>
                  <Typography variant="caption" color="text.disabled" component="div">
                    {t.settings.strictSerialMatchHint}
                  </Typography>
                </Box>
                <Typography component="dd" variant="body2" fontWeight={700} sx={{ m: 0 }}>
                  {settings.nfcStrictSerialMatch ? t.settings.policyOn : t.settings.policyOff}
                </Typography>
              </Box>
              <Box sx={{ display: 'contents' }}>
                <Box component="dt">
                  <Typography variant="body2" color="text.secondary">
                    {t.settings.manualTagEntry}
                  </Typography>
                  <Typography variant="caption" color="text.disabled" component="div">
                    {t.settings.manualTagEntryHint}
                  </Typography>
                </Box>
                <Box component="dd" sx={{ m: 0, textAlign: 'start' }}>
                  <Typography variant="body2" fontWeight={700}>
                    {settings.nfcManualEntryEnabled ? t.settings.policyOn : t.settings.policyOff}
                  </Typography>
                  <Typography variant="caption" color="text.disabled" component="div">
                    {t.settings.manualTagEntryYou}:{' '}
                    {manualEntryEffective ? t.settings.policyOn : t.settings.policyOff}
                  </Typography>
                </Box>
              </Box>
              <Box sx={{ display: 'contents' }}>
                <Box component="dt">
                  <Typography variant="body2" color="text.secondary">
                    {t.settings.imageAnnotation}
                  </Typography>
                  <Typography variant="caption" color="text.disabled" component="div">
                    {t.settings.imageAnnotationHint}
                  </Typography>
                </Box>
                <Typography component="dd" variant="body2" fontWeight={700} sx={{ m: 0 }}>
                  {settings.imageAnnotationEnabled ? t.settings.policyOn : t.settings.policyOff}
                </Typography>
              </Box>
            </Box>
          </CardContent>
        </Card>
      )}

      {/* A device preference, not an account one — which is why it lives here and never syncs.
          Admin-only to change, like the NFC scan rule: an operator flipping the orientation of
          a wall-mounted tablet mid-round is not a decision that belongs to them. */}
      <Card variant="outlined" sx={{ mb: 2 }}>
        <CardContent>
          <Typography variant="subtitle1" fontWeight={700} gutterBottom>
            {t.settings.displaySection}
          </Typography>

          <Controller
            name="screenOrientation"
            control={control}
            render={({ field }) => (
              <TextField
                {...field}
                value={field.value ?? 'auto'}
                select
                fullWidth
                size="small"
                label={t.settings.screenOrientation}
                disabled={!isAdmin}
                SelectProps={{ native: true }}
                helperText={t.settings.screenOrientationHint}
              >
                <option value="auto">{t.settings.screenOrientationAuto}</option>
                <option value="portrait">{t.settings.screenOrientationPortrait}</option>
                <option value="landscape">{t.settings.screenOrientationLandscape}</option>
              </TextField>
            )}
          />

          {/* What actually happened, rather than silence. An administrator who picks Landscape
              and watches the tablet keep rotating cannot otherwise tell a browser that refuses
              to lock from a setting that did not save. */}
          {!orientationLockSupported ? (
            <Alert severity="info" sx={{ mt: 2 }}>
              {t.settings.screenOrientationUnsupported}
            </Alert>
          ) : (
            orientationOutcome && (
              <Alert
                severity={
                  orientationOutcome.applied || orientationOutcome.reason === 'auto'
                    ? 'success'
                    : orientationOutcome.reason === 'notInstalled'
                      ? 'warning'
                      : 'info'
                }
                sx={{ mt: 2 }}
              >
                {orientationOutcome.applied
                  ? t.settings.screenOrientationApplied
                  : orientationOutcome.reason === 'auto'
                    ? t.settings.screenOrientationAutoActive
                    : orientationOutcome.reason === 'notInstalled'
                      ? t.settings.screenOrientationNotInstalled
                      : t.settings.screenOrientationRefused}
              </Alert>
            )
          )}

          {!isAdmin && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              {t.settings.adminOnly}
            </Typography>
          )}
        </CardContent>
      </Card>

      {/* Server-owned, so read-only and admin-only: showing it to an operator would invite a
          support call about a setting they cannot change, and the value they see would be
          whatever the last bootstrap brought rather than anything they control. */}
      {isAdmin && (
        <Card variant="outlined">
          <CardContent>
            <Typography variant="subtitle1" fontWeight={700} gutterBottom>
              {t.attachments.limitsTitle}
            </Typography>
            <Alert severity="info" sx={{ mb: 2 }}>
              {t.attachments.limitsHint}
            </Alert>
            <Box component="dl" sx={{ m: 0, display: 'grid', gridTemplateColumns: '1fr auto', rowGap: 1, columnGap: 2 }}>
              {[
                [t.attachments.limitImages, limits.maxImagesPerField],
                [t.attachments.limitAudios, limits.maxAudiosPerField],
                [t.attachments.limitVideos, limits.maxVideosPerField],
                [t.attachments.limitAudioSeconds, limits.maxAudioSeconds],
                [t.attachments.limitVideoSeconds, limits.maxVideoSeconds]
              ].map(([label, value]) => (
                <Box key={String(label)} sx={{ display: 'contents' }}>
                  <Typography component="dt" variant="body2" color="text.secondary">
                    {label}
                  </Typography>
                  <Typography component="dd" variant="body2" fontWeight={700} sx={{ m: 0 }}>
                    {String(value)}
                  </Typography>
                </Box>
              ))}
            </Box>
          </CardContent>
        </Card>
      )}

      <Divider />

      <Button
        type="submit"
        variant="contained"
        size="large"
        startIcon={<SaveIcon />}
        sx={{ alignSelf: 'flex-end', minWidth: 140 }}
      >
        {t.settings.save}
      </Button>
    </Box>
  )
}
