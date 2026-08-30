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
import { useAppStore } from '@/store'
import { useSettings } from '@/hooks/useSettings'
import { t } from '@/i18n'
import { postLoginPath } from '@/utils/loginRedirect'

interface LoginForm {
  username: string
  password: string
}

interface LoginLocationState {
  sessionEnded?: boolean
}

export function LoginPage() {
  const { signIn, isAuthenticated, authLoaded } = useAuth()
  const sessionEnded = useAppStore(s => s.sessionEnded)
  const setSessionEnded = useAppStore(s => s.setSessionEnded)
  const { settings } = useSettings()
  const navigate = useNavigate()
  const location = useLocation()
  const [error, setError] = useState<string | null>(null)
  const [sessionNotice, setSessionNotice] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (authLoaded && isAuthenticated) {
      navigate(postLoginPath(), { replace: true })
    }
  }, [authLoaded, isAuthenticated, navigate])

  useEffect(() => {
    // Either source counts: the store flag (set by the unauthorized handler and
    // immune to the redirect race) or the router state, kept for the direct
    // navigate path. Both are cleared once shown so a refresh or a back
    // navigation does not replay the notice.
    const fromRouter = (location.state as LoginLocationState | null)?.sessionEnded
    if (!sessionEnded && !fromRouter) return
    setSessionNotice(t.auth.sessionEnded)
    if (sessionEnded) setSessionEnded(false)
    if (fromRouter) navigate(location.pathname, { replace: true, state: null })
  }, [location.pathname, location.state, navigate, sessionEnded, setSessionEnded])

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
    setSessionNotice(null)
    setSessionEnded(false)
    setSubmitting(true)
    try {
      const err = await signIn(data.username.trim(), data.password)
      if (err) {
        setError(err)
      } else {
        navigate(postLoginPath(), { replace: true })
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Box
      component="main"
      sx={{
        minHeight: '100dvh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: '#f3f6f9',
        backgroundImage:
          'radial-gradient(circle at 12% 8%, rgba(21, 101, 192, 0.07), transparent 30%), radial-gradient(circle at 88% 92%, rgba(0, 137, 123, 0.055), transparent 28%)',
        px: { xs: 2, sm: 3 },
        pt: 'max(20px, env(safe-area-inset-top))',
        pb: 'max(20px, env(safe-area-inset-bottom))'
      }}
    >
      <Card
        variant="outlined"
        sx={{
          width: '100%',
          maxWidth: 390,
          borderColor: '#dde5ed',
          borderRadius: 3,
          boxShadow: '0 12px 34px rgba(28, 48, 69, 0.08)',
          overflow: 'hidden'
        }}
      >
        <Box sx={{ height: 3, bgcolor: 'primary.main' }} aria-hidden="true" />
        <CardContent
          sx={{
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            p: { xs: 2.5, sm: 3.25 },
            '&:last-child': { pb: { xs: 2.5, sm: 3.25 } }
          }}
        >
          <Box sx={{ textAlign: 'center' }}>
            <Box
              sx={{
                width: 42,
                height: 42,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                mb: 1.25,
                color: 'primary.main',
                border: '1px solid #d7e5f5',
                borderRadius: 2.5,
                bgcolor: '#eef5fd'
              }}
              aria-hidden="true"
            >
              <LoginIcon fontSize="small" />
            </Box>
            <Typography
              variant="caption"
              color="primary"
              fontWeight={600}
              sx={{ display: 'block', mb: 0.35, letterSpacing: 0.2 }}
            >
              {t.app.name}
            </Typography>
            <Typography variant="h5" fontWeight={750} sx={{ mb: 0.5, color: '#24384d' }}>
              {t.auth.loginTitle}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: '0.82rem' }}>
              {t.auth.loginSubtitle}
            </Typography>
          </Box>

          {sessionNotice && <Alert severity="warning" sx={{ py: 0.25 }}>{sessionNotice}</Alert>}
          {error && <Alert severity="error" sx={{ py: 0.25 }}>{error}</Alert>}

          <Box
            component="form"
            onSubmit={handleSubmit(onSubmit)}
            noValidate
            sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}
          >
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
                  size="small"
                  inputProps={{ enterKeyHint: 'next' }}
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
                  size="small"
                  inputProps={{ enterKeyHint: 'go' }}
                />
              )}
            />

            <Button
              type="submit"
              variant="contained"
              size="large"
              fullWidth
              disabled={submitting}
              startIcon={
                submitting ? <CircularProgress size={18} color="inherit" /> : <LoginIcon />
              }
              sx={{ minHeight: 48, mt: 0.25, borderRadius: 2.25, boxShadow: 'none' }}
            >
              {submitting ? t.auth.loggingIn : t.auth.login}
            </Button>
          </Box>

          <Box
            sx={{
              minWidth: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 0.75,
              px: 1,
              py: 0.7,
              border: '1px solid #e5eaf0',
              borderRadius: 2,
              bgcolor: '#fafbfd'
            }}
          >
            <Box sx={{ width: 6, height: 6, flex: '0 0 auto', borderRadius: '50%', bgcolor: 'success.main' }} />
            <Typography
              variant="caption"
              color="text.disabled"
              dir="ltr"
              noWrap
              sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', fontSize: '0.65rem' }}
            >
              {settings.serverUrl}
            </Typography>
          </Box>
        </CardContent>
      </Card>
    </Box>
  )
}
