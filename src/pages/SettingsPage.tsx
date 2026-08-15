import {
  Box,
  Card,
  CardContent,
  Typography,
  TextField,
  Button,
  Alert,
  Divider,
  InputAdornment,
  FormControlLabel,
  Switch
} from '@mui/material'
import SaveIcon from '@mui/icons-material/Save'
import { useForm, Controller } from 'react-hook-form'
import { useState } from 'react'
import { useSettings } from '@/hooks/useSettings'
import { useAuth } from '@/hooks/useAuth'
import { hasPlantWideScope } from '@/types/auth'
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
    await updateSettings({
      ...data,
      // Already milliseconds: the field converts on the way in and out (see below). Converting
      // again here multiplied the interval by 1000 on every save — including a save where
      // nobody touched the field — so 30 seconds silently became 30,000 and grew from there.
      syncIntervalMs: clampSyncInterval(data.syncIntervalMs),
      // Never written from this screen. The form was initialised from a snapshot, so
      // submitting it back could overwrite ceilings a bootstrap refreshed in the meantime —
      // and the device is not the owner of these values in the first place.
      attachmentLimits: limits
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

      {/* NFC settings */}
      <Card>
        <CardContent sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <Typography variant="subtitle1" fontWeight={600} color="text.secondary">
            {t.settings.nfcSection}
          </Typography>

          <Controller
            name="allowManualEntry"
            control={control}
            render={({ field }) => (
              <FormControlLabel
                control={
                  <Switch
                    checked={!!field.value}
                    onChange={e => field.onChange(e.target.checked)}
                  />
                }
                label={
                  <Box>
                    <Typography variant="body2">{t.settings.allowManualEntry}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {t.settings.allowManualEntryHint}
                    </Typography>
                  </Box>
                }
                sx={{ alignItems: 'flex-start', mt: 0.5 }}
              />
            )}
          />

          <Divider sx={{ my: 0.5 }} />

          {/* Admin-only: tightening the scan rule is a site-wide policy decision. */}
          <Controller
            name="nfcStrictSerialMatch"
            control={control}
            render={({ field }) => (
              <FormControlLabel
                control={
                  <Switch
                    checked={!!field.value}
                    disabled={!isAdmin}
                    onChange={e => field.onChange(e.target.checked)}
                  />
                }
                label={
                  <Box>
                    <Typography variant="body2">{t.settings.strictSerialMatch}</Typography>
                    <Typography variant="caption" color="text.secondary" component="div">
                      {t.settings.strictSerialMatchHint}
                    </Typography>
                    {!isAdmin && (
                      <Typography variant="caption" color="text.disabled" component="div">
                        {t.settings.strictSerialMatchAdminOnly}
                      </Typography>
                    )}
                  </Box>
                }
                sx={{ alignItems: 'flex-start', mt: 0.5 }}
              />
            )}
          />
        </CardContent>
      </Card>

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
              {t.settings.strictSerialMatchAdminOnly}
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
