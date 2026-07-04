import { Navigate, useLocation } from 'react-router-dom'
import { Box, CircularProgress } from '@mui/material'
import { useAuth } from '@/hooks/useAuth'

interface ProtectedRouteProps {
  children: React.ReactNode
}

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { authLoaded, isAuthenticated } = useAuth()
  const location = useLocation()

  if (!authLoaded) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    )
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />
  }

  return <>{children}</>
}
