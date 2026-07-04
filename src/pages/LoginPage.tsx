import {
  Box,
  Card,
  CardContent,
  Typography,
  TextField,
  Button,
  Alert,
  CircularProgress
} from '@mui/material'
import LoginIcon from '@mui/icons-material/Login'
import { useState, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useForm, Controller } from 'react-hook-form'
import { useAuth } from '@/hooks/useAuth'
import { useSettings } from '@/hooks/useSettings'
import { t } from '@/i18n'

interface LoginForm {
  username: string
  password: string
}

export function LoginPage() {
  const { signIn, isAuthenticated, authLoaded } = useAuth()
  const { settings } = useSettings()
  const navigate = useNavigate()
  const location = useLocation()
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const from = (location.state as { from?: string } | null)?.from ?? '/'

  useEffect(() => {
    if (authLoaded && isAuthenticated) {
      navigate(from, { replace: true })
    }
  }, [authLoaded, isAuthenticated, from, navigate])

  const { control, handleSubmit } = useForm<LoginForm>({
    defaultValues: { username: '', password: '' }
  })

  if (!authLoaded) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        <CircularProgress />
      </Box>
    )
  }

  if (isAuthenticated) {
    return null
  }

  const onSubmit = async (data: LoginForm) => {
    setError(null)
    setSubmitting(true)
    try {
      const err = await signIn(data.username.trim(), data.password)
      if (err) {
        setError(err)
      } else {
        navigate(from, { replace: true })
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'background.default',
        p: 2
      }}
    >
      <Card sx={{ width: '100%', maxWidth: 420 }}>
        <CardContent sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, p: 3 }}>
          <Box sx={{ textAlign: 'center' }}>
            <Typography variant="h5" fontWeight={700} gutterBottom>
              {t.auth.loginTitle}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {t.auth.loginSubtitle}
            </Typography>
            <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 1 }} dir="ltr">
              {settings.serverUrl}
            </Typography>
          </Box>

          {error && <Alert severity="error">{error}</Alert>}

          <Controller
            name="username"
            control={control}
            rules={{ required: true }}
            render={({ field }) => (
              <TextField
                {...field}
                label={t.auth.username}
                fullWidth
                autoComplete="username"
                autoFocus
                disabled={submitting}
              />
            )}
          />

          <Controller
            name="password"
            control={control}
            rules={{ required: true }}
            render={({ field }) => (
              <TextField
                {...field}
                label={t.auth.password}
                type="password"
                fullWidth
                autoComplete="current-password"
                disabled={submitting}
              />
            )}
          />

          <Button
            variant="contained"
            size="large"
            fullWidth
            onClick={() => void handleSubmit(onSubmit)()}
            disabled={submitting}
            startIcon={
              submitting ? <CircularProgress size={18} color="inherit" /> : <LoginIcon />
            }
          >
            {submitting ? t.auth.loggingIn : t.auth.login}
          </Button>
        </CardContent>
      </Card>
    </Box>
  )
}
