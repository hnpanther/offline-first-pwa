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
import { t } from '@/i18n'
import type { AppSettings } from '@/types'

export function SettingsPage() {
  const { settings, updateSettings } = useSettings()
  const [saved, setSaved] = useState(false)

  const { control, handleSubmit } = useForm<AppSettings>({
    values: settings
  })

  const onSubmit = async (data: AppSettings) => {
    await updateSettings({
      ...data,
      syncIntervalMs: Number(data.syncIntervalMs) * 1000
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
                value={Number(field.value) / 1000}
                onChange={e => field.onChange(Number(e.target.value) * 1000)}
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

      {/* Operator info */}
      <Card>
        <CardContent sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
          <Typography variant="subtitle1" fontWeight={600} color="text.secondary">
            {t.settings.operatorSection}
          </Typography>

          <Controller
            name="operatorName"
            control={control}
            render={({ field }) => (
              <TextField
                {...field}
                label={t.settings.operatorName}
                fullWidth
                placeholder="نام و نام خانوادگی"
              />
            )}
          />

          <Controller
            name="locationName"
            control={control}
            render={({ field }) => (
              <TextField
                {...field}
                label={t.settings.locationName}
                fullWidth
                placeholder="نام محل / سایت"
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
        </CardContent>
      </Card>

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
